import { json, type ActionFunctionArgs } from "@remix-run/cloudflare";
import type { Env } from "../../load-context";
import { captureFrontendError } from "~/lib/merchant-qa.server";

// Phase 3.8 D — frontend-error sink. The root error boundary POSTs
// here when the merchant sees a runtime React/JS error during QA, and
// this loader forwards a redacted event to AppApprove. Same auth model
// as the rest of the QA pipeline (the generated app trusts its own
// frontend; AppApprove trusts the deploy-secret HMAC inside
// captureFrontendError → reportToAppApprove).

interface ErrorReportBody {
  message: string;
  url?: string;
  stack?: string;
  cause?: string;
  status?: number;
  statusText?: string;
  responseData?: string;
  userAgent?: string;
  componentStack?: string;
}

// F2-10 (2026-05-15) — env-presence flags. Boolean per known env var
// so operators see "SHOPIFY_API_KEY present? yes; SHOPIFY_APP_URL
// present? NO" inline with the error report. Truthy boolean only;
// secret values never leave the Worker.
function envPresenceFlags(env: Env): Record<string, string> {
  const flags: Record<string, string> = {};
  const keys: Array<keyof Env> = [
    "SHOPIFY_API_KEY",
    "SHOPIFY_API_SECRET",
    "SHOPIFY_APP_URL",
    "SHOPIFY_CLI_PARTNERS_TOKEN",
    "SCOPES",
    "RESEND_API_KEY",
    "APPAPPROVE_DEPLOY_URL",
    "APPAPPROVE_DEPLOY_SECRET",
  ];
  for (const k of keys) {
    flags[`env:${String(k)}`] = env[k as keyof typeof env] ? "yes" : "no";
  }
  flags["binding:D1"] = env.D1 ? "yes" : "no";
  return flags;
}

export async function action({ context, request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const env = (context.cloudflare?.env ?? {}) as Env;
  let body: ErrorReportBody;
  try {
    body = (await request.json()) as ErrorReportBody;
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.message !== "string" || body.message.length === 0) {
    return json({ ok: false, error: "message is required" }, { status: 400 });
  }
  // F2-10 — enrich payload with server-side context. Stack truncation
  // bumped 1500 → 4000 (matches AppApprove's new validator cap) so full
  // V8 stack traces survive instead of getting cut at the third frame.
  await captureFrontendError(env, body.message.slice(0, 2000), {
    ...(body.url ? { url: String(body.url).slice(0, 500) } : {}),
    ...(body.stack ? { stack: String(body.stack).slice(0, 4000) } : {}),
    ...(body.cause ? { cause: String(body.cause).slice(0, 500) } : {}),
    ...(body.status !== undefined ? { status: String(body.status) } : {}),
    ...(body.statusText
      ? { statusText: String(body.statusText).slice(0, 200) }
      : {}),
    ...(body.responseData
      ? { responseData: String(body.responseData).slice(0, 2000) }
      : {}),
    ...(body.userAgent
      ? { userAgent: String(body.userAgent).slice(0, 200) }
      : {}),
    ...(body.componentStack
      ? { componentStack: String(body.componentStack).slice(0, 1500) }
      : {}),
    requestPath: new URL(request.url).pathname,
    ...envPresenceFlags(env),
  });
  return json({ ok: true });
}
