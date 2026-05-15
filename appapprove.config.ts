// AppApprove project configuration. Edit webhook routes, build hooks, and
// environment variable mappings here. The pricing schema lives separately
// in pricing.yaml.
//
// Full reference: https://appapprove.com/docs/config

import type { AppApproveConfig } from "./app/lib/appapprove-config";

const config: AppApproveConfig = {
  slug: "test-reviews-mcp",
  framework: "remix-cloudflare-workers",
  webhooks: {
    // Map Shopify topics to handler modules. AppApprove's webhook router
    // verifies HMAC and dispatches the parsed payload to your handler.
    "customers/data_request": "~/webhooks/customers-data-request",
    "customers/redact": "~/webhooks/customers-redact",
    "shop/redact": "~/webhooks/shop-redact",
    "app_subscriptions/update": "~/webhooks/app-subscriptions-update",
    "orders/fulfilled": "~/webhooks/orders-fulfilled",
    "orders/create": "~/webhooks/orders-create",
    "app/uninstalled": "~/webhooks/app-uninstalled",
  },
  crons: {
    // Reviews + reminders email pipeline. Mirrored in wrangler.toml.
    "*/15 * * * *": "~/crons/email-pipeline",
    // Daily GDPR deadline scan — warns 7 days before any open
    // customers/data_request, customers/redact, or shop/redact request
    // would breach the 30-day SLA.
    "0 8 * * *": "~/crons/gdpr-deadline-check",
  },
  env: {
    // Public env vars are exposed to the browser. Secrets stay server-only.
    public: [],
    secrets: ["SHOPIFY_API_SECRET"],
  },
  pricing: "./pricing.yaml",
};

export default config;
