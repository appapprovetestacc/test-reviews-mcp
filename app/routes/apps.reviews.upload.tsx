import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { requireAppProxy, jsonCors } from "~/lib/app-proxy.server";
import { uploadReviewPhoto } from "~/lib/r2-photos.server";

// POST /apps/reviews/upload
//
// multipart/form-data:
//   productId: string
//   photo: File (jpg/png/webp/gif, ≤6 MB)
//
// Returns { ok: true, url } — caller embeds the returned url in the
// review-submit form. Falls back to { ok: false } when the R2 binding
// is unset; the storefront form must degrade and submit without photo.
export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return jsonCors({ error: "Method not allowed" }, { status: 405 });
  }
  const { shop } = await requireAppProxy(request, context);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonCors({ ok: false, error: "Invalid form data." }, { status: 400 });
  }
  const productId = String(form.get("productId") ?? "").trim();
  const photo = form.get("photo");
  if (!productId || !(photo instanceof File)) {
    return jsonCors(
      { ok: false, error: "productId and photo are required." },
      { status: 400 },
    );
  }
  const result = await uploadReviewPhoto(context, {
    shop,
    productId,
    contentType: photo.type || "application/octet-stream",
    bytes: await photo.arrayBuffer(),
  });
  if (!result.ok) {
    return jsonCors({ ok: false, error: result.error }, { status: 422 });
  }
  return jsonCors({ ok: true, url: result.url });
}
