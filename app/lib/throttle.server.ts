import type { AppLoadContext } from "@remix-run/cloudflare";
import type { Env } from "../../load-context";

// Phase 7 B5 — pre-request check that asks AppApprove if this project
// is over its monthly hosting quota. Embedded in the Remix request
// handler in server.ts (entry point). If throttle = true, serves a
// 503 + Retry-After header so visitors see a clean "temporarily
// unavailable" page rather than a half-broken response.
//
// Cache: 5 min in-memory per Worker isolate. CF Workers have multiple
// isolates per account — a hot Worker handling 10k req/min might run
// 5-50 isolates, each with its own cache. 5min × N isolates = some
// quota slop, acceptable v1 (alternative: shared cache via KV but
// adds latency to every request).
//
// CIRCUIT-BREAKER: if AppApprove API is unreachable, FAIL OPEN (serve
// the request). Better to over-serve than to fail every customer's
// app when AppApprove has a brief outage. The hourly cron will catch
// up + the next quota-check will throttle if needed.

interface QuotaStatus {
  ok: boolean;
  throttle: boolean;
  tier?: string;
  reason?: string;
  cacheSeconds?: number;
}

interface CacheEntry {
  status: QuotaStatus;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

async function fetchQuotaStatus(env: Env): Promise<QuotaStatus | null> {
  const slug = env.APPAPPROVE_PROJECT_SLUG;
  const deployUrl = env.APPAPPROVE_DEPLOY_URL;
  const deploySecret = env.APPAPPROVE_DEPLOY_SECRET;
  if (!slug || !deployUrl || !deploySecret) {
    // Not deployed via AppApprove (forks / self-host) → no quota check.
    return null;
  }

  const sig = await hmacSha256Hex(deploySecret, "");
  const url = `${deployUrl.replace(/\/$/, "")}/api/internal/projects/${encodeURIComponent(slug)}/quota-status`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-AppApprove-Signature": `sha256=${sig}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // Non-200 → fail open (don't block on AppApprove being down)
      return null;
    }
    return (await res.json()) as QuotaStatus;
  } catch {
    return null;
  }
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(body)),
  );
  return Array.from(sigBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function checkQuotaThrottle(
  context: AppLoadContext,
): Promise<{ throttle: boolean; status: QuotaStatus | null }> {
  const env = (context.cloudflare?.env ?? {}) as Env;
  const slug = env.APPAPPROVE_PROJECT_SLUG;
  if (!slug) return { throttle: false, status: null };

  const cached = cache.get(slug);
  if (cached && cached.expiresAt > Date.now()) {
    return { throttle: cached.status.throttle, status: cached.status };
  }

  const status = await fetchQuotaStatus(env);
  if (!status) {
    // Fail open + cache the null briefly so we don't spam AppApprove
    // when it's down. Re-try in 60s.
    cache.set(slug, {
      status: { ok: true, throttle: false, reason: "appapprove-unreachable" },
      expiresAt: Date.now() + 60_000,
    });
    return { throttle: false, status: null };
  }

  const ttlMs = (status.cacheSeconds ?? 300) * 1000;
  cache.set(slug, {
    status,
    expiresAt: Date.now() + ttlMs,
  });
  return { throttle: status.throttle, status };
}

// 503 response with retry-after header. Helper for the request-handler
// to early-return when checkQuotaThrottle returns throttle: true.
export function throttleResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "Service temporarily unavailable",
      reason:
        "This Shopify app has hit its monthly hosting quota. The owner has been notified and can upgrade their AppApprove plan or wait for the new billing cycle to restore service.",
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "3600", // 1h — quota usually resets at month boundary
        "Cache-Control": "no-store",
      },
    },
  );
}
