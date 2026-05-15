import {
  type LoaderFunctionArgs,
  redirect,
} from "@remix-run/cloudflare";
import {
  buildInstallUrl,
  isValidShop,
  nonce,
  shopifyApi,
} from "~/lib/shopify.server";

// GET /auth?shop=<store>.myshopify.com
// Initiates the Shopify OAuth install flow. Stores a nonce in a short-lived
// HttpOnly cookie so the callback can verify state.
export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  if (!shop || !isValidShop(shop)) {
    return new Response("Missing or invalid ?shop=<name>.myshopify.com", {
      status: 400,
    });
  }
  const api = shopifyApi(context);
  const state = nonce();
  const redirectUri = `${api.appUrl.replace(/\/$/, "")}/auth/callback`;
  const installUrl = buildInstallUrl({
    shop,
    apiKey: api.apiKey,
    scopes: api.scopes,
    redirectUri,
    state,
  });
  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    `shopify_oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  );
  headers.append("Location", installUrl);
  return new Response(null, { status: 302, headers });
}

export default function AuthStart() {
  return null;
}
