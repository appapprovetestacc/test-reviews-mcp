import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { requireAppProxy, jsonCors } from "~/lib/app-proxy.server";
import {
  getReviewSummary,
  listApprovedReviewsForProduct,
} from "~/lib/reviews.server";
import { runMigrations } from "~/lib/db/migrate.server";

// GET /apps/reviews/list?productId=<gid-or-numeric>&page=<n>
//
// Public storefront endpoint. Returns approved reviews for a product
// plus the rating histogram so the block can render hydrated content
// without a second round-trip.
export async function loader({ request, context }: LoaderFunctionArgs) {
  await runMigrations(context);
  const { shop, url } = await requireAppProxy(request, context);
  const productId = url.searchParams.get("productId")?.trim() ?? "";
  if (!productId) {
    return jsonCors({ error: "Missing productId" }, { status: 400 });
  }
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const pageSize = Math.min(
    50,
    Math.max(1, Number(url.searchParams.get("pageSize") ?? "10") || 10),
  );
  const offset = (page - 1) * pageSize;
  const [{ items, total }, summary] = await Promise.all([
    listApprovedReviewsForProduct(context, shop, productId, pageSize, offset),
    getReviewSummary(context, shop, productId),
  ]);
  return jsonCors({
    ok: true,
    productId,
    summary,
    page,
    pageSize,
    total,
    items: items.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      customerName: r.customer_name,
      verified: r.verified === 1,
      photoUrl: r.photo_url,
      reply: r.reply,
      replyAt: r.reply_at,
      createdAt: r.created_at,
    })),
  });
}
