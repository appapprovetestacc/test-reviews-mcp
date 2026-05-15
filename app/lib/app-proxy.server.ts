import type { AppLoadContext } from "@remix-run/cloudflare";
import { verifyAppProxySignature } from "./reviews-helpers";
import { shopifyApi, isValidShop } from "./shopify.server";

// Shared helper for routes mounted under /apps/reviews/* — verifies the
// Shopify app-proxy signature and returns the resolved shop. Throws a
// proper Response on auth failure so loaders / actions bubble a 401.
//
// IMPORTANT: do not call authenticate.admin in app-proxy loaders. The
// storefront request has no App Bridge JWT; it carries a Shopify-signed
// `signature` param instead. We verify that param against the shared
// API secret.

export interface AppProxyAuth {
  shop: string;
  loggedInCustomerId: string | null;
  url: URL;
}

export async function requireAppProxy(
  request: Request,
  context: AppLoadContext,
): Promise<AppProxyAuth> {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") ?? "";
  if (!isValidShop(shop)) {
    throw new Response("Invalid or missing shop param", { status: 400 });
  }
  let cfg;
  try {
    cfg = shopifyApi(context);
  } catch {
    // No API secret configured (preview mode / local dev without env) —
    // serve a 503 so a misconfigured deploy doesn't 200 with junk data.
    throw new Response("Server misconfigured", { status: 503 });
  }
  const ok = await verifyAppProxySignature(url.searchParams, cfg.apiSecret);
  if (!ok) {
    throw new Response("Invalid app-proxy signature", { status: 401 });
  }
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id") || null;
  return { shop, loggedInCustomerId, url };
}

export function jsonCors(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}
