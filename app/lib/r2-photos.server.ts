import type { AppLoadContext } from "@remix-run/cloudflare";
import type { Env } from "../../load-context";
import { newId } from "./reviews-helpers";

// Helpers around the REVIEWS_R2_BUCKET binding. The binding is opt-in:
// when unbound (R2 not provisioned yet) every entry point gracefully
// returns null / false so the storefront form keeps working without
// photo upload.

const MAX_PHOTO_BYTES = 6 * 1024 * 1024; // 6 MB
const ALLOWED_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

function extFromContentType(ct: string): string {
  switch (ct) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

export interface R2UploadResult {
  ok: boolean;
  /** Public URL the storefront should reference in the review row. */
  url?: string;
  /** Object key inside the bucket (kept for later GDPR deletes). */
  key?: string;
  error?: string;
}

export async function uploadReviewPhoto(
  context: AppLoadContext,
  input: {
    shop: string;
    productId: string;
    contentType: string;
    bytes: ArrayBuffer;
  },
): Promise<R2UploadResult> {
  const env = (context.cloudflare?.env ?? {}) as Env;
  const bucket = env.REVIEWS_R2_BUCKET ?? null;
  const publicHost = env.REVIEWS_R2_PUBLIC_HOST ?? "";
  if (!bucket || !publicHost) {
    return { ok: false, error: "Photo upload is not enabled on this store." };
  }
  if (!ALLOWED_CONTENT_TYPES.has(input.contentType)) {
    return { ok: false, error: "Only JPEG, PNG, WebP and GIF photos are allowed." };
  }
  if (input.bytes.byteLength > MAX_PHOTO_BYTES) {
    return { ok: false, error: "Photo must be 6 MB or smaller." };
  }
  if (input.bytes.byteLength === 0) {
    return { ok: false, error: "Photo is empty." };
  }
  const ext = extFromContentType(input.contentType);
  const safeShop = input.shop.replace(/[^a-z0-9-.]/gi, "");
  const safeProduct = input.productId.replace(/[^a-z0-9_-]/gi, "");
  const key = `reviews/${safeShop}/${safeProduct}/${newId("p").slice(2)}.${ext}`;
  try {
    await bucket.put(key, input.bytes, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: {
        shop: input.shop,
        productId: input.productId,
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const host = publicHost.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return {
    ok: true,
    url: `https://${host}/${key}`,
    key,
  };
}

export async function deletePhotoByUrl(
  context: AppLoadContext,
  url: string | null,
): Promise<void> {
  if (!url) return;
  const env = (context.cloudflare?.env ?? {}) as Env;
  const bucket = env.REVIEWS_R2_BUCKET ?? null;
  if (!bucket) return;
  try {
    const parsed = new URL(url);
    const key = parsed.pathname.replace(/^\/+/, "");
    if (!key) return;
    await bucket.delete(key);
  } catch {
    // Photo URL may be malformed — swallow so callers aren't blocked.
  }
}
