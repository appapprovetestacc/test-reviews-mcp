import type { AppLoadContext } from "@remix-run/cloudflare";
import type { Env } from "../../load-context";
import type {
  EmailJobRow,
  EmailJobStage,
  OrderLinkRow,
  QuestionRow,
  QuestionStatus,
  ReviewRow,
  ReviewStatus,
} from "./db/schema.server";
import {
  isVerifiedBuyer,
  newId,
  type SanitisedReview,
  type SanitisedQuestion,
} from "./reviews-helpers";

function db(context: AppLoadContext): D1Database {
  const env = (context.cloudflare?.env ?? {}) as Env;
  if (!env.D1) {
    throw new Response("D1 binding not configured", { status: 500 });
  }
  return env.D1;
}

// ─── Reviews ────────────────────────────────────────────────────────

export interface ListReviewsOptions {
  shop: string;
  productId?: string;
  status?: ReviewStatus | "any";
  search?: string;
  limit: number;
  offset: number;
}

export async function listReviews(
  context: AppLoadContext,
  opts: ListReviewsOptions,
): Promise<{ items: ReviewRow[]; total: number }> {
  const conditions: string[] = ["shop = ?"];
  const params: (string | number)[] = [opts.shop];
  if (opts.productId) {
    conditions.push("product_id = ?");
    params.push(opts.productId);
  }
  if (opts.status && opts.status !== "any") {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts.search) {
    conditions.push(
      "(LOWER(title) LIKE ? OR LOWER(body) LIKE ? OR LOWER(customer_name) LIKE ? OR LOWER(customer_email) LIKE ?)",
    );
    const like = `%${opts.search.toLowerCase().slice(0, 80)}%`;
    params.push(like, like, like, like);
  }
  const where = conditions.join(" AND ");
  const items = await db(context)
    .prepare(
      `SELECT * FROM reviews WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...params, opts.limit, opts.offset)
    .all<ReviewRow>();
  const totalRow = await db(context)
    .prepare(`SELECT COUNT(*) AS count FROM reviews WHERE ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  return { items: items.results ?? [], total: totalRow?.count ?? 0 };
}

export async function listApprovedReviewsForProduct(
  context: AppLoadContext,
  shop: string,
  productId: string,
  limit: number,
  offset: number,
): Promise<{ items: ReviewRow[]; total: number }> {
  return listReviews(context, {
    shop,
    productId,
    status: "approved",
    limit,
    offset,
  });
}

export async function getReviewSummary(
  context: AppLoadContext,
  shop: string,
  productId: string,
): Promise<{ total: number; average: number; counts: Record<1 | 2 | 3 | 4 | 5, number> }> {
  const row = await db(context)
    .prepare(
      `SELECT
         COUNT(*) AS total,
         AVG(rating) AS avg,
         SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS c1,
         SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS c2,
         SUM(CASE WHEN rating = 3 THEN 1 ELSE 0 END) AS c3,
         SUM(CASE WHEN rating = 4 THEN 1 ELSE 0 END) AS c4,
         SUM(CASE WHEN rating = 5 THEN 1 ELSE 0 END) AS c5
       FROM reviews
       WHERE shop = ? AND product_id = ? AND status = 'approved'`,
    )
    .bind(shop, productId)
    .first<{
      total: number;
      avg: number | null;
      c1: number | null;
      c2: number | null;
      c3: number | null;
      c4: number | null;
      c5: number | null;
    }>();
  const total = row?.total ?? 0;
  const avg = row?.avg ?? 0;
  return {
    total,
    average: Math.round((avg ?? 0) * 100) / 100,
    counts: {
      1: row?.c1 ?? 0,
      2: row?.c2 ?? 0,
      3: row?.c3 ?? 0,
      4: row?.c4 ?? 0,
      5: row?.c5 ?? 0,
    },
  };
}

export interface CreateReviewInput extends SanitisedReview {
  shop: string;
  photoUrl: string | null;
  ipHash: string | null;
}

export async function createReview(
  context: AppLoadContext,
  input: CreateReviewInput,
): Promise<ReviewRow> {
  // Verified-buyer lookup before insert, so we don't have to mutate
  // the row again after creation.
  const links = await db(context)
    .prepare(
      `SELECT customer_email, product_id FROM order_links
        WHERE shop = ? AND LOWER(customer_email) = ? AND product_id = ? LIMIT 1`,
    )
    .bind(input.shop, input.customerEmail.toLowerCase(), input.productId)
    .all<{ customer_email: string; product_id: string }>();
  const verified = isVerifiedBuyer({
    reviewEmail: input.customerEmail,
    reviewProductId: input.productId,
    orderLinks: links.results ?? [],
  });
  const now = Date.now();
  const id = newId("rev");
  const row: ReviewRow = {
    id,
    shop: input.shop,
    product_id: input.productId,
    customer_email: input.customerEmail,
    customer_name: input.customerName,
    rating: input.rating,
    title: input.title,
    body: input.body,
    status: "pending",
    verified: verified ? 1 : 0,
    photo_url: input.photoUrl,
    reply: null,
    reply_at: null,
    ip_hash: input.ipHash,
    created_at: now,
    updated_at: now,
  };
  await db(context)
    .prepare(
      `INSERT INTO reviews (
        id, shop, product_id, customer_email, customer_name, rating,
        title, body, status, verified, photo_url, reply, reply_at,
        ip_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.shop,
      row.product_id,
      row.customer_email,
      row.customer_name,
      row.rating,
      row.title,
      row.body,
      row.status,
      row.verified,
      row.photo_url,
      row.reply,
      row.reply_at,
      row.ip_hash,
      row.created_at,
      row.updated_at,
    )
    .run();
  return row;
}

export async function getReview(
  context: AppLoadContext,
  shop: string,
  id: string,
): Promise<ReviewRow | null> {
  const row = await db(context)
    .prepare("SELECT * FROM reviews WHERE shop = ? AND id = ?")
    .bind(shop, id)
    .first<ReviewRow>();
  return row ?? null;
}

export async function setReviewStatus(
  context: AppLoadContext,
  shop: string,
  id: string,
  status: ReviewStatus,
): Promise<void> {
  await db(context)
    .prepare(
      "UPDATE reviews SET status = ?, updated_at = ? WHERE shop = ? AND id = ?",
    )
    .bind(status, Date.now(), shop, id)
    .run();
}

export async function replyToReview(
  context: AppLoadContext,
  shop: string,
  id: string,
  reply: string | null,
): Promise<void> {
  const now = Date.now();
  await db(context)
    .prepare(
      "UPDATE reviews SET reply = ?, reply_at = ?, updated_at = ? WHERE shop = ? AND id = ?",
    )
    .bind(reply, reply ? now : null, now, shop, id)
    .run();
}

export async function countReviewsByStatus(
  context: AppLoadContext,
  shop: string,
): Promise<Record<ReviewStatus, number>> {
  const rows = await db(context)
    .prepare(
      "SELECT status, COUNT(*) AS count FROM reviews WHERE shop = ? GROUP BY status",
    )
    .bind(shop)
    .all<{ status: ReviewStatus; count: number }>();
  const out: Record<ReviewStatus, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
    spam: 0,
  };
  for (const r of rows.results ?? []) out[r.status] = r.count;
  return out;
}

// ─── Q&A ────────────────────────────────────────────────────────────

export interface ListQuestionsOptions {
  shop: string;
  productId?: string;
  status?: QuestionStatus | "any";
  search?: string;
  limit: number;
  offset: number;
}

export async function listQuestions(
  context: AppLoadContext,
  opts: ListQuestionsOptions,
): Promise<{ items: QuestionRow[]; total: number }> {
  const conditions: string[] = ["shop = ?"];
  const params: (string | number)[] = [opts.shop];
  if (opts.productId) {
    conditions.push("product_id = ?");
    params.push(opts.productId);
  }
  if (opts.status && opts.status !== "any") {
    conditions.push("status = ?");
    params.push(opts.status);
  }
  if (opts.search) {
    conditions.push(
      "(LOWER(body) LIKE ? OR LOWER(answer) LIKE ? OR LOWER(customer_name) LIKE ?)",
    );
    const like = `%${opts.search.toLowerCase().slice(0, 80)}%`;
    params.push(like, like, like);
  }
  const where = conditions.join(" AND ");
  const items = await db(context)
    .prepare(
      `SELECT * FROM questions WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...params, opts.limit, opts.offset)
    .all<QuestionRow>();
  const totalRow = await db(context)
    .prepare(`SELECT COUNT(*) AS count FROM questions WHERE ${where}`)
    .bind(...params)
    .first<{ count: number }>();
  return { items: items.results ?? [], total: totalRow?.count ?? 0 };
}

export interface CreateQuestionInput extends SanitisedQuestion {
  shop: string;
  ipHash: string | null;
}

export async function createQuestion(
  context: AppLoadContext,
  input: CreateQuestionInput,
): Promise<QuestionRow> {
  const now = Date.now();
  const id = newId("q");
  const row: QuestionRow = {
    id,
    shop: input.shop,
    product_id: input.productId,
    customer_email: input.customerEmail,
    customer_name: input.customerName,
    body: input.body,
    answer: null,
    answered_at: null,
    status: "pending",
    ip_hash: input.ipHash,
    created_at: now,
    updated_at: now,
  };
  await db(context)
    .prepare(
      `INSERT INTO questions (
        id, shop, product_id, customer_email, customer_name, body,
        answer, answered_at, status, ip_hash, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.shop,
      row.product_id,
      row.customer_email,
      row.customer_name,
      row.body,
      row.answer,
      row.answered_at,
      row.status,
      row.ip_hash,
      row.created_at,
      row.updated_at,
    )
    .run();
  return row;
}

export async function setQuestionStatus(
  context: AppLoadContext,
  shop: string,
  id: string,
  status: QuestionStatus,
): Promise<void> {
  await db(context)
    .prepare(
      "UPDATE questions SET status = ?, updated_at = ? WHERE shop = ? AND id = ?",
    )
    .bind(status, Date.now(), shop, id)
    .run();
}

export async function answerQuestion(
  context: AppLoadContext,
  shop: string,
  id: string,
  answer: string | null,
): Promise<void> {
  const now = Date.now();
  await db(context)
    .prepare(
      "UPDATE questions SET answer = ?, answered_at = ?, updated_at = ? WHERE shop = ? AND id = ?",
    )
    .bind(answer, answer ? now : null, now, shop, id)
    .run();
}

export async function countQuestionsByStatus(
  context: AppLoadContext,
  shop: string,
): Promise<Record<QuestionStatus, number>> {
  const rows = await db(context)
    .prepare(
      "SELECT status, COUNT(*) AS count FROM questions WHERE shop = ? GROUP BY status",
    )
    .bind(shop)
    .all<{ status: QuestionStatus; count: number }>();
  const out: Record<QuestionStatus, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
  };
  for (const r of rows.results ?? []) out[r.status] = r.count;
  return out;
}

// ─── Order links (verified-buyer source) ────────────────────────────

export async function recordOrderLink(
  context: AppLoadContext,
  link: Omit<OrderLinkRow, "created_at">,
): Promise<void> {
  await db(context)
    .prepare(
      `INSERT OR REPLACE INTO order_links (
        shop, order_id, customer_email, product_id, fulfilled_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      link.shop,
      link.order_id,
      link.customer_email,
      link.product_id,
      link.fulfilled_at,
      Date.now(),
    )
    .run();
}

export async function markOrderFulfilled(
  context: AppLoadContext,
  shop: string,
  orderId: string,
  fulfilledAt: number,
): Promise<void> {
  await db(context)
    .prepare(
      "UPDATE order_links SET fulfilled_at = ? WHERE shop = ? AND order_id = ?",
    )
    .bind(fulfilledAt, shop, orderId)
    .run();
}

// ─── Email jobs ─────────────────────────────────────────────────────

export interface EnqueueEmailJobInput {
  shop: string;
  orderId: string;
  customerEmail: string;
  productIds: string[];
  stage: EmailJobStage;
  scheduledAt: number;
  requestToken: string;
  parentId?: string | null;
}

export async function enqueueEmailJob(
  context: AppLoadContext,
  input: EnqueueEmailJobInput,
): Promise<EmailJobRow | null> {
  const now = Date.now();
  const id = newId("ej");
  const row: EmailJobRow = {
    id,
    shop: input.shop,
    order_id: input.orderId,
    customer_email: input.customerEmail,
    product_ids: JSON.stringify(input.productIds),
    stage: input.stage,
    status: "pending",
    scheduled_at: input.scheduledAt,
    sent_at: null,
    request_token: input.requestToken,
    parent_id: input.parentId ?? null,
    attempts: 0,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  try {
    await db(context)
      .prepare(
        `INSERT INTO email_jobs (
          id, shop, order_id, customer_email, product_ids, stage, status,
          scheduled_at, sent_at, request_token, parent_id, attempts,
          last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.shop,
        row.order_id,
        row.customer_email,
        row.product_ids,
        row.stage,
        row.status,
        row.scheduled_at,
        row.sent_at,
        row.request_token,
        row.parent_id,
        row.attempts,
        row.last_error,
        row.created_at,
        row.updated_at,
      )
      .run();
  } catch (err) {
    // Unique index on (shop, order_id, stage) prevents double-enqueue
    // when Shopify retries orders/fulfilled. Treat as no-op.
    const msg = err instanceof Error ? err.message : String(err);
    if (/UNIQUE|constraint/i.test(msg)) return null;
    throw err;
  }
  return row;
}

export async function listDueEmailJobs(
  context: AppLoadContext,
  now: number,
  limit: number,
): Promise<EmailJobRow[]> {
  const rows = await db(context)
    .prepare(
      `SELECT * FROM email_jobs
        WHERE status = 'pending' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC
        LIMIT ?`,
    )
    .bind(now, limit)
    .all<EmailJobRow>();
  return rows.results ?? [];
}

export async function markEmailJobSent(
  context: AppLoadContext,
  id: string,
  sentAt: number,
): Promise<void> {
  await db(context)
    .prepare(
      `UPDATE email_jobs SET status = 'sent', sent_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(sentAt, sentAt, id)
    .run();
}

export async function markEmailJobSkipped(
  context: AppLoadContext,
  id: string,
  reason: string,
): Promise<void> {
  await db(context)
    .prepare(
      `UPDATE email_jobs SET status = 'skipped', last_error = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(reason, Date.now(), id)
    .run();
}

export async function markEmailJobFailed(
  context: AppLoadContext,
  id: string,
  attempts: number,
  error: string,
): Promise<void> {
  const status: "failed" | "pending" = attempts >= 5 ? "failed" : "pending";
  await db(context)
    .prepare(
      `UPDATE email_jobs SET status = ?, attempts = ?, last_error = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(status, attempts, error.slice(0, 500), Date.now(), id)
    .run();
}

export async function hasReviewForRequest(
  context: AppLoadContext,
  shop: string,
  customerEmail: string,
  productIds: string[],
  since: number,
): Promise<boolean> {
  if (productIds.length === 0) return false;
  const placeholders = productIds.map(() => "?").join(",");
  const row = await db(context)
    .prepare(
      `SELECT id FROM reviews
        WHERE shop = ? AND LOWER(customer_email) = ?
          AND product_id IN (${placeholders})
          AND created_at >= ?
        LIMIT 1`,
    )
    .bind(shop, customerEmail.toLowerCase(), ...productIds, since)
    .first<{ id: string }>();
  return !!row;
}

// Hard delete: used by GDPR redact flows.
export async function purgeCustomerData(
  context: AppLoadContext,
  shop: string,
  customerEmail: string,
): Promise<void> {
  const email = customerEmail.toLowerCase();
  const dbInst = db(context);
  await dbInst
    .prepare("DELETE FROM reviews WHERE shop = ? AND LOWER(customer_email) = ?")
    .bind(shop, email)
    .run();
  await dbInst
    .prepare("DELETE FROM questions WHERE shop = ? AND LOWER(customer_email) = ?")
    .bind(shop, email)
    .run();
  await dbInst
    .prepare("DELETE FROM order_links WHERE shop = ? AND LOWER(customer_email) = ?")
    .bind(shop, email)
    .run();
  await dbInst
    .prepare("DELETE FROM email_jobs WHERE shop = ? AND LOWER(customer_email) = ?")
    .bind(shop, email)
    .run();
}

export async function purgeShopData(
  context: AppLoadContext,
  shop: string,
): Promise<void> {
  const dbInst = db(context);
  await dbInst.prepare("DELETE FROM reviews WHERE shop = ?").bind(shop).run();
  await dbInst.prepare("DELETE FROM questions WHERE shop = ?").bind(shop).run();
  await dbInst.prepare("DELETE FROM order_links WHERE shop = ?").bind(shop).run();
  await dbInst.prepare("DELETE FROM email_jobs WHERE shop = ?").bind(shop).run();
}
