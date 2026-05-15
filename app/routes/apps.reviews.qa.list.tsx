import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { requireAppProxy, jsonCors } from "~/lib/app-proxy.server";
import { runMigrations } from "~/lib/db/migrate.server";
import { listQuestions } from "~/lib/reviews.server";

// GET /apps/reviews/qa/list?productId=<id>&page=<n>
//
// Public Q&A list for a product. Only `approved` questions (with their
// optional merchant answer) are returned.
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
  const { items, total } = await listQuestions(context, {
    shop,
    productId,
    status: "approved",
    limit: pageSize,
    offset,
  });
  return jsonCors({
    ok: true,
    productId,
    page,
    pageSize,
    total,
    items: items.map((q) => ({
      id: q.id,
      body: q.body,
      answer: q.answer,
      answeredAt: q.answered_at,
      customerName: q.customer_name,
      createdAt: q.created_at,
    })),
  });
}
