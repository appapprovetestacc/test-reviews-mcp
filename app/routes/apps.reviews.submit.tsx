import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { requireAppProxy, jsonCors } from "~/lib/app-proxy.server";
import { runMigrations } from "~/lib/db/migrate.server";
import {
  checkRateLimit,
  hashIp,
  isValidPhotoUrl,
  validateReviewForm,
} from "~/lib/reviews-helpers";
import { createReview } from "~/lib/reviews.server";
import type { Env } from "../../load-context";

// POST /apps/reviews/submit
// Body: application/x-www-form-urlencoded or JSON
//   productId, rating, title, body, customerName, customerEmail, photoUrl?
//
// Rate-limited per (shop + ip-hash) — 3 submissions per 10 min.
// Returns { ok: true, id } on success.
export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return jsonCors({ error: "Method not allowed" }, { status: 405 });
  }
  await runMigrations(context);
  const { shop } = await requireAppProxy(request, context);
  const env = (context.cloudflare?.env ?? {}) as Env;
  const body = await readBody(request);
  const validated = validateReviewForm({
    productId: body.get("productId"),
    rating: body.get("rating"),
    title: body.get("title"),
    body: body.get("body"),
    customerName: body.get("customerName"),
    customerEmail: body.get("customerEmail"),
  });
  if (!validated.ok) {
    return jsonCors({ ok: false, errors: validated.errors }, { status: 422 });
  }

  // Rate limit using the SESSIONS KV (already provisioned by AppApprove
  // for OAuth) — fall back to no-op when unavailable.
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "0.0.0.0";
  const salt = env.SHOPIFY_API_SECRET ?? env.APPAPPROVE_PROJECT_SLUG ?? "salt";
  const ipHash = await hashIp(ip, salt);
  const sessions = env.SESSIONS ?? null;
  const limitKey = `ratelimit:reviews:${shop}:${ipHash}`;
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
        { ok: false, errors: [{ field: "_form", message: "Too many submissions — try again later." }] },
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

  const rawPhoto = (body.get("photoUrl") ?? "").trim();
  let photoUrl: string | null = null;
  if (rawPhoto) {
    const allowedHosts = [
      env.REVIEWS_R2_PUBLIC_HOST,
      // Shopify CDN URLs aren't valid here — only our R2 host.
    ].filter((h): h is string => !!h);
    if (isValidPhotoUrl({ url: rawPhoto, allowedHosts })) {
      photoUrl = rawPhoto;
    } else {
      // Reject explicitly so storefront can show actionable error.
      return jsonCors(
        {
          ok: false,
          errors: [
            {
              field: "photoUrl",
              message:
                "Photo URL is not allowed. Use the upload helper or omit the photo.",
            },
          ],
        },
        { status: 422 },
      );
    }
  }

  const row = await createReview(context, {
    ...validated.value,
    shop,
    photoUrl,
    ipHash,
  });
  return jsonCors({ ok: true, id: row.id, status: row.status });
}

async function readBody(request: Request): Promise<URLSearchParams> {
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
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) {
      if (typeof v === "string") params.append(k, v);
    }
    return params;
  }
  // Best-effort fallback
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
