import type { WebhookHandler } from "~/lib/appapprove-config";
import {
  type ShopRedactPayload,
  defaultAdapter,
  recordGdprRequest,
} from "~/lib/gdpr.server";
import { purgeShopData } from "~/lib/reviews.server";

// GDPR mandatory webhook: shop/redact.
// Shopify sends this 48 hours after a shop uninstalls. We drop every
// reviews / questions / order_links / email_jobs row for this shop AND
// delegate to the default adapter (extension point).
const handler: WebhookHandler = async ({ shop, payload, context }) => {
  return recordGdprRequest(context, {
    topic: "shop/redact",
    shop,
    payload,
    fn: async () => {
      await purgeShopData(context, shop);
      await defaultAdapter.redactShop({
        payload: payload as ShopRedactPayload,
      });
    },
  });
};

export default handler;
