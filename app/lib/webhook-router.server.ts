import type { AppLoadContext } from "@remix-run/cloudflare";
import type { WebhookHandler } from "./appapprove-config";
import config from "../../appapprove.config";

// HMAC verification per Shopify spec
// https://shopify.dev/docs/apps/build/webhooks/subscribe/get-started#step-5-verify-the-webhook
async function verifyHmac(
  rawBody: string,
  hmacHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!hmacHeader) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  // Constant-time comparison
  if (expected.length !== hmacHeader.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
  }
  return mismatch === 0;
}

// Lazy-loaded handler modules — Vite/Wrangler bundle each one on first call.
const HANDLERS: Record<string, () => Promise<{ default: WebhookHandler }>> = {
  "customers/data_request": () => import("../webhooks/customers-data-request"),
  "customers/redact": () => import("../webhooks/customers-redact"),
  "shop/redact": () => import("../webhooks/shop-redact"),
  "app_subscriptions/update": () => import("../webhooks/app-subscriptions-update"),
  // AppApprove codegen extends this map from appapprove.config.ts at build time.
};

// Per-delivery dedup. Shopify retries webhooks on timeout / 5xx with the
// SAME x-shopify-webhook-id, so a handler that already ran would otherwise
// re-process — especially bad for customers/redact (re-redacting an
// already-deleted record causes confusing audit trails or cascade errors).
// We mark the id in the GDPR_AUDIT KV (reused for retention) with a 7-day
// TTL — well beyond Shopify's 48h retry window.
const WEBHOOK_DEDUP_PREFIX = "webhook_seen:";
const WEBHOOK_DEDUP_TTL_SECONDS = 7 * 86_400;

interface DedupEnv {
  GDPR_AUDIT?: KVNamespace;
}

async function alreadyProcessed(
  context: AppLoadContext,
  webhookId: string,
): Promise<boolean> {
  const env = (context.cloudflare?.env ?? {}) as DedupEnv;
  const ns = env.GDPR_AUDIT;
  if (!ns) return false;
  const key = WEBHOOK_DEDUP_PREFIX + webhookId;
  const seen = await ns.get(key);
  if (seen) return true;
  // Insert BEFORE handler runs so concurrent retries see the marker.
  await ns.put(key, "1", { expirationTtl: WEBHOOK_DEDUP_TTL_SECONDS });
  return false;
}

export async function dispatchWebhook(
  request: Request,
  context: AppLoadContext,
): Promise<Response> {
  const topic = request.headers.get("x-shopify-topic");
  const shop = request.headers.get("x-shopify-shop-domain") ?? "";
  const hmac = request.headers.get("x-shopify-hmac-sha256");
  const webhookId = request.headers.get("x-shopify-webhook-id");
  if (!topic) {
    return new Response("Missing X-Shopify-Topic", { status: 400 });
  }
  const rawBody = await request.text();
  const env = (context.cloudflare?.env ?? {}) as unknown as Record<string, string | undefined>;
  const secret = env.SHOPIFY_API_SECRET;
  if (!secret) {
    return new Response("Server misconfigured: SHOPIFY_API_SECRET missing", {
      status: 500,
    });
  }
  if (!(await verifyHmac(rawBody, hmac, secret))) {
    return new Response("Invalid HMAC", { status: 401 });
  }
  // Dedup AFTER HMAC so an attacker can't pollute the dedup KV with random
  // ids. Shopify always sends x-shopify-webhook-id; if missing we degrade
  // gracefully and accept possible duplicate processing.
  if (webhookId && (await alreadyProcessed(context, webhookId))) {
    return new Response("OK (duplicate)", { status: 200 });
  }
  const loadHandler = HANDLERS[topic];
  if (!loadHandler) {
    // Unrouted topic — log and 200 so Shopify doesn't retry.
    console.warn(`[webhooks] no handler registered for ${topic}`);
    return new Response("OK (no handler)", { status: 200 });
  }
  const mod = await loadHandler();
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = rawBody;
  }
  // Phase 3.8 D — QA event capture for webhook failures. Wrap the
  // handler call so any thrown error reaches the AppApprove timeline
  // before bubbling up. Capture is best-effort and never replaces the
  // 5xx response — Shopify still sees the original failure and retries.
  try {
    return await mod.default({
      topic,
      shop,
      payload,
      headers: request.headers,
      context,
    });
  } catch (err) {
    const env = (context.cloudflare?.env ?? {}) as {
      APPAPPROVE_DEPLOY_URL?: string;
      APPAPPROVE_DEPLOY_SECRET?: string;
      APPAPPROVE_PROJECT_SLUG?: string;
    };
    const { captureWebhookError } = await import("./merchant-qa.server");
    await captureWebhookError(env, topic, err);
    throw err;
  }
}

// Touch `config` so the unused-import linter doesn't strip it. The build
// pipeline reads this same module at deploy time to derive subscriptions.
void config;
