// Migration SQL inlined as TypeScript constants. We keep the matching
// `drizzle/0000_*.sql` file on disk so external tooling
// (`wrangler d1 migrations apply`, the Drizzle journal) can still see
// it, but the Worker bundle imports from here — esbuild has no `.sql?raw`
// loader on the deploy path (Vite-dev tolerates it, the wrangler bundle
// step does not), so a `?raw` import builds fine locally and breaks at
// deploy time. Keep the two files in sync when adding a migration.

export interface Migration {
  /** Matches the `tag` in drizzle/meta/_journal.json. */
  tag: string;
  sql: string;
}

const MIGRATION_0000_INIT_REVIEWS = `-- Initial schema for the Test Reviews App.
-- Tables are tenant-scoped by \`shop\` (myshopify domain) so a single D1
-- instance can host multiple installs. Drizzle journal entry lives at
-- drizzle/meta/_journal.json — every new SQL file MUST be registered
-- there or db:migrate silently skips it.

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  product_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  rating INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  verified INTEGER NOT NULL DEFAULT 0,
  photo_url TEXT,
  reply TEXT,
  reply_at INTEGER,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_shop_product
  ON reviews(shop, product_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reviews_shop_status
  ON reviews(shop, status, created_at DESC);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  product_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  body TEXT NOT NULL,
  answer TEXT,
  answered_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_shop_product
  ON questions(shop, product_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_questions_shop_status
  ON questions(shop, status, created_at DESC);

-- order_links is the verified-buyer source of truth: every line item from
-- every fulfilled order is recorded here. When a customer submits a
-- review, we look for (shop, customer_email, product_id) — match = verified.
CREATE TABLE IF NOT EXISTS order_links (
  shop TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  product_id TEXT NOT NULL,
  fulfilled_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (shop, order_id, product_id, customer_email)
);

CREATE INDEX IF NOT EXISTS idx_order_links_lookup
  ON order_links(shop, customer_email, product_id);

-- email_jobs is the 2-stage pipeline ledger.
--   stage = 'request'  → first email, scheduled 7d after fulfillment
--   stage = 'reminder' → reminder, scheduled 14d after request if no reply
--   status = 'pending' | 'sent' | 'skipped' | 'failed'
-- The cron handler reads pending rows where scheduled_at <= now() and
-- ratchets them to 'sent', then enqueues the reminder row.
CREATE TABLE IF NOT EXISTS email_jobs (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  product_ids TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at INTEGER NOT NULL,
  sent_at INTEGER,
  request_token TEXT NOT NULL,
  parent_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_jobs_due
  ON email_jobs(status, scheduled_at);

CREATE INDEX IF NOT EXISTS idx_email_jobs_token
  ON email_jobs(request_token);

CREATE UNIQUE INDEX IF NOT EXISTS uq_email_jobs_dedup
  ON email_jobs(shop, order_id, stage);

CREATE TABLE IF NOT EXISTS migrations_applied (
  hash TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);`;

export const MIGRATIONS: Migration[] = [
  { tag: "0000_init_reviews", sql: MIGRATION_0000_INIT_REVIEWS },
];
