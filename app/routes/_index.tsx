import type { MetaFunction } from "@remix-run/cloudflare";

export const meta: MetaFunction = () => [
  { title: "Test Reviews App" },
  { name: "description", content: "Shopify App scaffolded by AppApprove." },
];

export default function Index() {
  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem", maxWidth: 720 }}>
      <h1 style={{ marginTop: 0 }}>Test Reviews App</h1>
      <p>
        Your AppApprove-generated Shopify App is live. Open this project in the{" "}
        <a href="https://appapprove.com">AppApprove Vibecode editor</a> to start
        building features with AI assistance and live preview.
      </p>
      <p>
        The Shopify OAuth flow, GDPR webhooks, and Billing API are wired in
        as you complete the AppApprove onboarding.
      </p>
    </main>
  );
}
