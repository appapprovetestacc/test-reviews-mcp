import type { AppLoadContext } from "@remix-run/cloudflare";
import { redirect } from "@remix-run/cloudflare";
import { isValidShop } from "./shopify.server";
import { loadOfflineSession, type OfflineSession } from "./session-storage.server";

// Loader-style admin auth: pull `shop` from the URL, load the stored
// offline session, redirect to /auth if missing. Used by the embedded
// moderation pages — they render before App Bridge has fetched a JWT
// so the route can't call `authenticate.admin` here.

export async function requireAdminLoader(
  request: Request,
  context: AppLoadContext,
): Promise<{ shop: string; session: OfflineSession }> {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  if (!shop || !isValidShop(shop)) {
    throw redirect("/auth");
  }
  const session = await loadOfflineSession(context, shop);
  if (!session) {
    throw redirect(`/auth?shop=${encodeURIComponent(shop)}`);
  }
  return { shop, session };
}
