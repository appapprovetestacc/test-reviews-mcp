import type { WebhookHandler } from "~/lib/appapprove-config";
import {
  type CustomerRedactPayload,
  defaultAdapter,
  recordGdprRequest,
} from "~/lib/gdpr.server";
import { purgeCustomerData } from "~/lib/reviews.server";

// GDPR mandatory webhook: customers/redact.
// Shopify sends this 10 days after a customer requests deletion. We
// drop every reviews / questions / order_links / email_jobs row that
// references the customer email AND delegate to the default adapter
// (extension point for future external data stores).
const handler: WebhookHandler = async ({ shop, payload, context }) => {
  return recordGdprRequest(context, {
    topic: "customers/redact",
    shop,
    payload,
    fn: async () => {
      const typed = payload as CustomerRedactPayload;
      if (typed?.customer?.email) {
        await purgeCustomerData(context, shop, typed.customer.email);
      }
      await defaultAdapter.redactCustomer({ payload: typed });
    },
  });
};

export default handler;
