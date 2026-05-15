import type { WebhookHandler } from "~/lib/appapprove-config";
import { deleteOfflineSession } from "~/lib/session-storage.server";
import { purgeShopData } from "~/lib/reviews.server";

// Shopify webhook: app/uninstalled. Drops the offline session + all
// review/Q&A/order rows for this shop. AppApprove's GDPR shop/redact
// handler runs a similar purge 48h after uninstall; this one keeps the
// dashboard clean immediately so a re-installer doesn't see stale data.

const handler: WebhookHandler = async ({ shop, context }) => {
  await deleteOfflineSession(context, shop);
  await purgeShopData(context, shop);
  return new Response("OK", { status: 200 });
};

export default handler;
