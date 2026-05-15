import {
  type LoaderFunctionArgs,
  redirect,
} from "@remix-run/cloudflare";
import type { Env } from "../../load-context";
import {
  exchangeCodeForOfflineToken,
  isValidShop,
  shopifyApi,
  verifyOAuthHmac,
} from "~/lib/shopify.server";
import { saveOfflineSession } from "~/lib/session-storage.server";
import { getOrSetFirstInstallAt } from "~/lib/trial.server";
import { captureInstall, captureSetupStep } from "~/lib/merchant-qa.server";

// GET /auth/callback — Shopify redirects here with ?code, ?shop, ?state, ?hmac
export async function loader({ request, context }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!shop || !isValidShop(shop) || !code || !state) {
    return new Response("Bad request", { status: 400 });
  }
  const api = shopifyApi(context);
  if (!(await verifyOAuthHmac(url.searchParams, api.apiSecret))) {
    return new Response("HMAC mismatch", { status: 401 });
  }
  // State cookie check
  const cookieHeader = request.headers.get("cookie") ?? "";
  const expectedState = cookieHeader.match(/shopify_oauth_state=([^;]+)/)?.[1];
  if (!expectedState || expectedState !== state) {
    return new Response("State mismatch", { status: 401 });
  }

  const token = await exchangeCodeForOfflineToken({
    shop,
    code,
    apiKey: api.apiKey,
    apiSecret: api.apiSecret,
  });
  await saveOfflineSession(context, {
    shop,
    accessToken: token.accessToken,
    scope: token.scope,
    storedAt: Date.now(),
  });
  // Best-effort: stamp first-install so a later uninstall+reinstall
  // can't reset the trial window. Failure must not block OAuth completion.
  try {
    await getOrSetFirstInstallAt(context, shop);
  } catch (err) {
    console.warn("[auth] getOrSetFirstInstallAt failed (non-fatal)", err);
  }

  // Phase 3.8 D — QA install event. Best-effort, never blocks OAuth.
  const qaEnv = (context.cloudflare?.env ?? {}) as Env;
  await captureInstall(qaEnv, shop);
  // Phase 3 hardening — fire the canonical "oauth_complete" setup step
  // so the AppApprove timeline shows OAuth landed on this shop. This is
  // the first universal setup-step every app shares; merchants add
  // app-specific captureSetupStep calls on top (see docs/qa.md).
  await captureSetupStep(qaEnv, "oauth_complete", { shop });

  // Hand off to the embedded admin app.
  const target = `/?shop=${encodeURIComponent(shop)}&host=${encodeURIComponent(url.searchParams.get("host") ?? "")}`;
  const headers = new Headers({
    Location: target,
    "Set-Cookie":
      "shopify_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  });
  return new Response(null, { status: 302, headers });
}

export default function AuthCallback() {
  return null;
}
