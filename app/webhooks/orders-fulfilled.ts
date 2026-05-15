import type { WebhookHandler } from "~/lib/appapprove-config";
import { runMigrations } from "~/lib/db/migrate.server";
import {
  enqueueEmailJob,
  recordOrderLink,
  markOrderFulfilled,
} from "~/lib/reviews.server";
import { newId, reviewRequestDelayMs } from "~/lib/reviews-helpers";

// Shopify webhook: orders/fulfilled. Records each line-item's
// (customer_email, product_id) link for verified-buyer lookups AND
// enqueues a single review-request email scheduled 7 days from now.
// The unique index on (shop, order_id, "request") makes the enqueue
// idempotent — duplicate Shopify retries are no-ops.

interface FulfilledLineItem {
  product_id?: number | string | null;
}

interface FulfillmentPayload {
  line_items?: FulfilledLineItem[];
}

interface OrderFulfilledPayload {
  id?: number | string;
  email?: string | null;
  contact_email?: string | null;
  customer?: { email?: string | null } | null;
  fulfilled_at?: string | null;
  fulfillments?: FulfillmentPayload[];
  line_items?: FulfilledLineItem[];
}

const handler: WebhookHandler = async ({ shop, payload, context }) => {
  await runMigrations(context);
  const data = (payload ?? {}) as OrderFulfilledPayload;
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
  const fulfilledAt = data.fulfilled_at ? Date.parse(data.fulfilled_at) : Date.now();
  if (!orderId || !email) {
    return new Response("OK (missing order/email)", { status: 200 });
  }
  const lineItems = new Set<string>();
  for (const li of data.line_items ?? []) {
    if (li.product_id != null) lineItems.add(String(li.product_id));
  }
  for (const f of data.fulfillments ?? []) {
    for (const li of f.line_items ?? []) {
      if (li.product_id != null) lineItems.add(String(li.product_id));
    }
  }
  const productIds = Array.from(lineItems);
  if (productIds.length === 0) {
    return new Response("OK (no line items)", { status: 200 });
  }
  for (const pid of productIds) {
    await recordOrderLink(context, {
      shop,
      order_id: orderId,
      customer_email: email,
      product_id: pid,
      fulfilled_at: Number.isFinite(fulfilledAt) ? fulfilledAt : Date.now(),
    });
  }
  await markOrderFulfilled(
    context,
    shop,
    orderId,
    Number.isFinite(fulfilledAt) ? fulfilledAt : Date.now(),
  );
  await enqueueEmailJob(context, {
    shop,
    orderId,
    customerEmail: email,
    productIds,
    stage: "request",
    scheduledAt: Date.now() + reviewRequestDelayMs(),
    requestToken: newId("tok"),
  });
  return new Response("OK", { status: 200 });
};

export default handler;
