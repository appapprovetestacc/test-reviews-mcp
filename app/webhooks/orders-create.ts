import type { WebhookHandler } from "~/lib/appapprove-config";
import { runMigrations } from "~/lib/db/migrate.server";
import { recordOrderLink } from "~/lib/reviews.server";

// Shopify webhook: orders/create. Recorded so the verified-buyer
// badge can light up immediately on review submission even before the
// order is fulfilled — review-request emails still wait for the
// fulfilled webhook.

interface OrderCreatePayload {
  id?: number | string;
  email?: string | null;
  contact_email?: string | null;
  customer?: { email?: string | null } | null;
  line_items?: Array<{ product_id?: number | string | null }>;
}

const handler: WebhookHandler = async ({ shop, payload, context }) => {
  await runMigrations(context);
  const data = (payload ?? {}) as OrderCreatePayload;
  const orderId = data.id != null ? String(data.id) : "";
  const email = (
    data.email ??
    data.contact_email ??
    data.customer?.email ??
    ""
  )
    .toString()
    .trim()
    .toLowerCase();
  if (!orderId || !email) {
    return new Response("OK (missing order/email)", { status: 200 });
  }
  const productIds = new Set<string>();
  for (const li of data.line_items ?? []) {
    if (li.product_id != null) productIds.add(String(li.product_id));
  }
  for (const pid of productIds) {
    await recordOrderLink(context, {
      shop,
      order_id: orderId,
      customer_email: email,
      product_id: pid,
      fulfilled_at: null,
    });
  }
  return new Response("OK", { status: 200 });
};

export default handler;
