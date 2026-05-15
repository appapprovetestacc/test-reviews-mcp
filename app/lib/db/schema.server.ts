// D1 schema types for the Test Reviews App.
//
// We intentionally keep the column definitions colocated with TS row
// shapes so route code and the SQL in `drizzle/0000_init_reviews.sql`
// stay in lock-step. If you add a column, mirror it here AND in a new
// numbered migration file under `drizzle/`, then register the migration
// in `drizzle/meta/_journal.json` (Drizzle silently skips otherwise).

export type ReviewStatus = "pending" | "approved" | "rejected" | "spam";
export type QuestionStatus = "pending" | "approved" | "rejected";
export type EmailJobStage = "request" | "reminder";
export type EmailJobStatus = "pending" | "sent" | "skipped" | "failed";

export interface ReviewRow {
  id: string;
  shop: string;
  product_id: string;
  customer_email: string;
  customer_name: string;
  rating: number;
  title: string;
  body: string;
  status: ReviewStatus;
  verified: 0 | 1;
  photo_url: string | null;
  reply: string | null;
  reply_at: number | null;
  ip_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface QuestionRow {
  id: string;
  shop: string;
  product_id: string;
  customer_email: string;
  customer_name: string;
  body: string;
  answer: string | null;
  answered_at: number | null;
  status: QuestionStatus;
  ip_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface OrderLinkRow {
  shop: string;
  order_id: string;
  customer_email: string;
  product_id: string;
  fulfilled_at: number | null;
  created_at: number;
}

export interface EmailJobRow {
  id: string;
  shop: string;
  order_id: string;
  customer_email: string;
  product_ids: string; // JSON
  stage: EmailJobStage;
  status: EmailJobStatus;
  scheduled_at: number;
  sent_at: number | null;
  request_token: string;
  parent_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export const TABLES = {
  reviews: "reviews",
  questions: "questions",
  orderLinks: "order_links",
  emailJobs: "email_jobs",
  migrationsApplied: "migrations_applied",
} as const;
