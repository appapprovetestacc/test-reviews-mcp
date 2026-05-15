import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { requireAppProxy, jsonCors } from "~/lib/app-proxy.server";
import { runMigrations } from "~/lib/db/migrate.server";
import { checkRateLimit, hashIp, validateQuestionForm } from "~/lib/reviews-helpers";
import { createQuestion } from "~/lib/reviews.server";
import type { Env } from "../../load-context";

// POST /apps/reviews/qa/submit — same envelope as the review submit
// endpoint, but creates a `questions` row. Public Q&A submissions are
// pending by default; the merchant must approve them in the admin
// inbox before they appear on the storefront.
export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return jsonCors({ error: "Method not allowed" }, { status: 405 });
  }
  await runMigrations(context);
  const { shop } = await requireAppProxy(request, context);
  const env = (context.cloudflare?.env ?? {}) as Env;
  const body = await parseBody(request);
  const validated = validateQuestionForm({
    productId: body.get("productId"),
    body: body.get("body"),
    customerName: body.get("customerName"),
    customerEmail: body.get("customerEmail"),
  });
  if (!validated.ok) {
    return jsonCors({ ok: false, errors: validated.errors }, { status: 422 });
  }
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "0.0.0.0";
  const salt = env.SHOPIFY_API_SECRET ?? env.APPAPPROVE_PROJECT_SLUG ?? "salt";
  const ipHash = await hashIp(ip, salt);
  const sessions = env.SESSIONS ?? null;
  const limitKey = `ratelimit:qa:${shop}:${ipHash}`;
  if (sessions) {
    const raw = await sessions.get(limitKey);
    const timestamps: number[] = raw ? (JSON.parse(raw) as number[]) : [];
    const limit = checkRateLimit({
      timestamps,
      now: Date.now(),
      windowMs: 10 * 60 * 1000,
      limit: 3,
    });
    if (!limit.allowed) {
      return jsonCors(
        {
          ok: false,
          errors: [
            { field: "_form", message: "Too many questions — please wait before sending another." },
          ],
        },
        {
          status: 429,
          headers: { "Retry-After": String(limit.retryAfterSeconds) },
        },
      );
    }
    await sessions.put(limitKey, JSON.stringify(limit.retained), {
      expirationTtl: 60 * 60,
    });
  }
  const row = await createQuestion(context, { ...validated.value, shop, ipHash });
  return jsonCors({ ok: true, id: row.id, status: row.status });
}

async function parseBody(request: Request): Promise<URLSearchParams> {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    try {
      const obj = (await request.json()) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        params.append(k, String(v));
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  try {
    const fd = await request.formData();
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") params.append(k, v);
    }
    return params;
  } catch {
    return new URLSearchParams();
  }
}
