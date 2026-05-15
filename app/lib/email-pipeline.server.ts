import type { AppLoadContext } from "@remix-run/cloudflare";
import type { Env } from "../../load-context";
import type { EmailJobRow } from "./db/schema.server";
import {
  enqueueEmailJob,
  hasReviewForRequest,
  listDueEmailJobs,
  markEmailJobFailed,
  markEmailJobSent,
  markEmailJobSkipped,
} from "./reviews.server";
import { sendMail } from "./mail.server";
import { newId, reminderDelayMs } from "./reviews-helpers";

const MAX_JOBS_PER_TICK = 25;

function envOf(context: AppLoadContext): Env {
  return (context.cloudflare?.env ?? {}) as Env;
}

function reviewLandingUrl(env: Env, shop: string, token: string): string {
  const base = env.SHOPIFY_APP_URL?.replace(/\/$/, "") ?? "";
  if (!base) return `https://${shop}/?reviewToken=${encodeURIComponent(token)}`;
  return `${base}/apps/reviews/landing?shop=${encodeURIComponent(shop)}&token=${encodeURIComponent(token)}`;
}

function fromAddress(env: Env): string {
  return env.RESEND_FROM ?? env.MAIL_SENDER_FROM ?? "onboarding@resend.dev";
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildRequestEmail(opts: {
  shop: string;
  productIds: string[];
  landingUrl: string;
}): { subject: string; html: string; text: string } {
  const productCount = opts.productIds.length;
  const subject = "How was your recent order? Leave a review";
  const text = `Thanks for shopping with ${opts.shop}!\n\n` +
    `If you have a minute we'd love to hear what you thought about your ${productCount > 1 ? `${productCount} items` : "purchase"}.\n` +
    `Leave a review: ${opts.landingUrl}\n\n` +
    "Thanks,\nThe team";
  const safeShop = escapeHtml(opts.shop);
  const safeUrl = escapeHtml(opts.landingUrl);
  const html = `<!doctype html><html><body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; color:#1a1a1a; max-width:560px; margin:0 auto; padding:24px;">
  <p>Thanks for shopping with <strong>${safeShop}</strong>!</p>
  <p>If you have a minute we'd love to hear what you thought about your ${productCount > 1 ? `${productCount} items` : "purchase"}.</p>
  <p style="margin:24px 0;"><a href="${safeUrl}" style="background:#000; color:#fff; padding:12px 20px; text-decoration:none; border-radius:4px; display:inline-block;">Leave a review</a></p>
  <p style="color:#666; font-size:13px;">Or paste this into your browser: <br><span style="word-break:break-all;">${safeUrl}</span></p>
  </body></html>`;
  return { subject, html, text };
}

function buildReminderEmail(opts: {
  shop: string;
  landingUrl: string;
}): { subject: string; html: string; text: string } {
  const subject = "Quick reminder — share your review";
  const text = `Just a quick reminder — we'd still love to hear what you thought.\n\n` +
    `Leave a review: ${opts.landingUrl}\n\n` +
    "If you don't have time, no problem — this is the last reminder.";
  const safeShop = escapeHtml(opts.shop);
  const safeUrl = escapeHtml(opts.landingUrl);
  const html = `<!doctype html><html><body style="font-family: system-ui, -apple-system, Segoe UI, sans-serif; color:#1a1a1a; max-width:560px; margin:0 auto; padding:24px;">
  <p>Just a quick reminder from <strong>${safeShop}</strong> — we'd still love to hear what you thought.</p>
  <p style="margin:24px 0;"><a href="${safeUrl}" style="background:#000; color:#fff; padding:12px 20px; text-decoration:none; border-radius:4px; display:inline-block;">Leave a review</a></p>
  <p style="color:#666; font-size:13px;">This is the last reminder — we won't email again about this order.</p>
  </body></html>`;
  return { subject, html, text };
}

async function processJob(
  context: AppLoadContext,
  job: EmailJobRow,
): Promise<void> {
  const env = envOf(context);
  const productIds: string[] = (() => {
    try {
      const parsed = JSON.parse(job.product_ids);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  })();
  // If the customer already left a review for one of the products in
  // this order since the order was placed, skip both stages — we don't
  // want to nag a happy reviewer.
  const skipReason = await hasReviewForRequest(
    context,
    job.shop,
    job.customer_email,
    productIds,
    job.created_at,
  );
  if (skipReason) {
    await markEmailJobSkipped(context, job.id, "review-already-submitted");
    return;
  }
  const landingUrl = reviewLandingUrl(env, job.shop, job.request_token);
  const body =
    job.stage === "request"
      ? buildRequestEmail({ shop: job.shop, productIds, landingUrl })
      : buildReminderEmail({ shop: job.shop, landingUrl });
  if (env.DRY_RUN_EMAILS === "1") {
    console.log(`[email-pipeline] DRY_RUN ${job.stage} → ${job.customer_email}`, {
      orderId: job.order_id,
      shop: job.shop,
      productIds,
      landingUrl,
    });
    await markEmailJobSent(context, job.id, Date.now());
  } else {
    try {
      const result = await sendMail(context, {
        to: job.customer_email,
        subject: body.subject,
        html: body.html,
        text: body.text,
        tags: [
          { name: "shop", value: job.shop },
          { name: "stage", value: job.stage },
          { name: "order_id", value: job.order_id },
        ],
      });
      if (!result.ok) {
        await markEmailJobFailed(
          context,
          job.id,
          job.attempts + 1,
          result.error ?? "send failed",
        );
        return;
      }
      await markEmailJobSent(context, job.id, Date.now());
    } catch (err) {
      await markEmailJobFailed(
        context,
        job.id,
        job.attempts + 1,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    // Ensure the from address is set on BYOK path even when env.RESEND_FROM
    // is missing — mail.server.ts logs a banner-level warning we surface
    // via the admin Settings UI in a later phase.
    if (!env.RESEND_FROM && !env.MAIL_SENDER_FROM) {
      console.warn(
        `[email-pipeline] no sender configured — used fallback ${fromAddress(env)}`,
      );
    }
  }
  // After a successful request send, enqueue the reminder 14d out.
  if (job.stage === "request") {
    await enqueueEmailJob(context, {
      shop: job.shop,
      orderId: job.order_id,
      customerEmail: job.customer_email,
      productIds,
      stage: "reminder",
      scheduledAt: Date.now() + reminderDelayMs(),
      requestToken: job.request_token,
      parentId: job.id,
    });
  }
}

export async function runEmailPipeline(
  context: AppLoadContext,
): Promise<{ processed: number; sent: number; skipped: number; failed: number }> {
  const now = Date.now();
  const due = await listDueEmailJobs(context, now, MAX_JOBS_PER_TICK);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const job of due) {
    const before = job.status;
    try {
      await processJob(context, job);
      sent += before === "pending" ? 1 : 0;
    } catch (err) {
      failed += 1;
      await markEmailJobFailed(
        context,
        job.id,
        job.attempts + 1,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  // (re-query for accurate buckets is overkill — counts above are
  // best-effort for observability)
  void skipped;
  void newId;
  return { processed: due.length, sent, skipped, failed };
}
