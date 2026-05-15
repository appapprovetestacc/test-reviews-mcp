// Pure business-logic helpers shared by both storefront and admin
// surfaces. NO env / DB / network access — every export must be safe to
// import from a worker, a test runner, or a future SSR pass.
//
// Tests live in tests/reviews-helpers.test.mjs and exercise every edge
// case below. Keep this module side-effect-free.

import type {
  ReviewStatus,
  QuestionStatus,
} from "./db/schema.server";

// ─── Review-status state machine ───────────────────────────────────
//
// pending  ──approve──▶ approved
// pending  ──reject───▶ rejected
// pending  ──spam─────▶ spam
// approved ──reject───▶ rejected
// approved ──unpublish▶ pending   (re-moderate)
// rejected ──approve──▶ approved  (manual rescue)
// spam     ──approve──▶ approved  (false positive)
//
// Any other transition is a no-op (returns the current status).

export type ReviewAction =
  | "approve"
  | "reject"
  | "mark_spam"
  | "unpublish";

const REVIEW_TRANSITIONS: Record<
  ReviewStatus,
  Partial<Record<ReviewAction, ReviewStatus>>
> = {
  pending: {
    approve: "approved",
    reject: "rejected",
    mark_spam: "spam",
  },
  approved: {
    reject: "rejected",
    unpublish: "pending",
    mark_spam: "spam",
  },
  rejected: {
    approve: "approved",
  },
  spam: {
    approve: "approved",
  },
};

export function nextReviewStatus(
  current: ReviewStatus,
  action: ReviewAction,
): ReviewStatus {
  return REVIEW_TRANSITIONS[current][action] ?? current;
}

export function isValidReviewStatus(s: string): s is ReviewStatus {
  return s === "pending" || s === "approved" || s === "rejected" || s === "spam";
}

export function isValidQuestionStatus(s: string): s is QuestionStatus {
  return s === "pending" || s === "approved" || s === "rejected";
}

// ─── Rate-limit ─────────────────────────────────────────────────────
//
// Storefront form submissions (reviews + Q&A) are rate-limited per
// IP-hash + per shop. We bucket recent submissions into a sliding
// window and reject when the count exceeds `limit`. The bucket is
// caller-owned (KV / DO / D1 / Map) — this helper is pure.

export interface RateLimitInput {
  /** Submission timestamps (epoch ms) already recorded for this key. */
  timestamps: number[];
  /** Current request time. */
  now: number;
  /** Window length in ms. */
  windowMs: number;
  /** Max submissions allowed inside the window. */
  limit: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Timestamps to persist back (old entries pruned, new one appended if allowed). */
  retained: number[];
  /** Seconds the caller should wait before retrying. */
  retryAfterSeconds: number;
}

export function checkRateLimit(input: RateLimitInput): RateLimitResult {
  const { timestamps, now, windowMs, limit } = input;
  const cutoff = now - windowMs;
  const recent = timestamps.filter((t) => t > cutoff).sort((a, b) => a - b);
  if (recent.length >= limit) {
    const oldest = recent[0]!;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + windowMs - now) / 1000),
    );
    return { allowed: false, retained: recent, retryAfterSeconds };
  }
  return {
    allowed: true,
    retained: [...recent, now],
    retryAfterSeconds: 0,
  };
}

// ─── Photo URL validation ───────────────────────────────────────────
//
// We accept only photos served from a known R2-public host or the
// configured custom domain. Hot-linking to arbitrary third-party CDNs
// is rejected — it leaks the merchant's storefront to image proxies
// and gives reviewers a vector for tracking pixels.

export interface PhotoUrlInput {
  url: string | null | undefined;
  /** Hosts where R2 serves public photo URLs (the auto-issued pub-*.r2.dev
   * and optionally a merchant-configured CNAME). Comparisons are
   * case-insensitive. */
  allowedHosts: string[];
}

export function isValidPhotoUrl(input: PhotoUrlInput): boolean {
  const { url, allowedHosts } = input;
  if (!url) return false;
  if (typeof url !== "string") return false;
  if (url.length > 1024) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  const allowed = allowedHosts.map((h) => h.toLowerCase()).filter(Boolean);
  if (!allowed.includes(host)) return false;
  // Path must look like an image — extension whitelist keeps the DB
  // from being filled with arbitrary HTML.
  const lowerPath = parsed.pathname.toLowerCase();
  return (
    lowerPath.endsWith(".jpg") ||
    lowerPath.endsWith(".jpeg") ||
    lowerPath.endsWith(".png") ||
    lowerPath.endsWith(".webp") ||
    lowerPath.endsWith(".gif")
  );
}

// ─── Verified-buyer logic ───────────────────────────────────────────
//
// A review earns the "Verified buyer" badge when the customer_email
// has at least one order_links row for the same product_id on the
// same shop. Comparisons are case-insensitive on the email and
// whitespace-normalised — Shopify gives us "Foo@Bar.com " sometimes.

export interface VerifiedBuyerInput {
  /** Email submitted on the review form. */
  reviewEmail: string;
  /** Product id the review is for. */
  reviewProductId: string;
  /** Order line items the customer has on this shop. */
  orderLinks: Array<{ customer_email: string; product_id: string }>;
}

export function isVerifiedBuyer(input: VerifiedBuyerInput): boolean {
  const email = input.reviewEmail.trim().toLowerCase();
  const productId = input.reviewProductId.trim();
  if (!email || !productId) return false;
  return input.orderLinks.some(
    (l) =>
      l.customer_email.trim().toLowerCase() === email &&
      l.product_id.trim() === productId,
  );
}

// ─── Email throttle ─────────────────────────────────────────────────
//
// We never email a customer about the same order twice on the same day
// (review-request + reminder for the same order are intentionally
// staggered). The throttle also caps total emails per recipient per
// rolling 24h window so a misconfigured bulk fulfilment doesn't fan
// out 50 emails to one person.

export interface EmailThrottleInput {
  /** Past send timestamps for this recipient (epoch ms). */
  pastSends: number[];
  /** When the new send is scheduled. */
  scheduledAt: number;
  /** Soft cap on total sends in the last 24h. */
  maxPerDay?: number;
  /** Minimum gap (ms) between any two emails to the same recipient. */
  minGapMs?: number;
}

export interface EmailThrottleResult {
  allow: boolean;
  reason?: "min-gap" | "daily-cap";
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function checkEmailThrottle(
  input: EmailThrottleInput,
): EmailThrottleResult {
  const maxPerDay = input.maxPerDay ?? 3;
  const minGapMs = input.minGapMs ?? 6 * 60 * 60 * 1000; // 6h
  const dayCutoff = input.scheduledAt - DAY_MS;
  const recent = input.pastSends.filter((t) => t > dayCutoff);
  if (recent.length >= maxPerDay) {
    return { allow: false, reason: "daily-cap" };
  }
  for (const t of input.pastSends) {
    if (Math.abs(input.scheduledAt - t) < minGapMs) {
      return { allow: false, reason: "min-gap" };
    }
  }
  return { allow: true };
}

// ─── Star rating + form sanitisation ────────────────────────────────

export function clampRating(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  const rounded = Math.round(n);
  if (rounded < 1) return 0;
  if (rounded > 5) return 5;
  return rounded;
}

const MAX_TITLE = 120;
const MAX_BODY = 4000;
const MAX_NAME = 120;
const MAX_EMAIL = 254;

export interface ReviewFormInput {
  rating: unknown;
  title: unknown;
  body: unknown;
  customerName: unknown;
  customerEmail: unknown;
  productId: unknown;
}

export interface SanitisedReview {
  rating: number;
  title: string;
  body: string;
  customerName: string;
  customerEmail: string;
  productId: string;
}

export type ValidationError = { field: string; message: string };

export function validateReviewForm(
  input: ReviewFormInput,
): { ok: true; value: SanitisedReview } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const rating = clampRating(input.rating);
  if (rating < 1) errors.push({ field: "rating", message: "Select a rating from 1 to 5." });
  const title = sanitiseLine(input.title, MAX_TITLE);
  const body = sanitiseMultiline(input.body, MAX_BODY);
  if (body.length < 5) {
    errors.push({ field: "body", message: "Tell us a little more about your experience." });
  }
  const customerName = sanitiseLine(input.customerName, MAX_NAME);
  if (customerName.length < 1) {
    errors.push({ field: "customerName", message: "Enter your name." });
  }
  const customerEmail = sanitiseLine(input.customerEmail, MAX_EMAIL).toLowerCase();
  if (!isValidEmail(customerEmail)) {
    errors.push({ field: "customerEmail", message: "Enter a valid email." });
  }
  const productId = sanitiseLine(input.productId, 64);
  if (!productId) {
    errors.push({ field: "productId", message: "Missing product." });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { rating, title, body, customerName, customerEmail, productId },
  };
}

export interface QuestionFormInput {
  body: unknown;
  customerName: unknown;
  customerEmail: unknown;
  productId: unknown;
}

export interface SanitisedQuestion {
  body: string;
  customerName: string;
  customerEmail: string;
  productId: string;
}

export function validateQuestionForm(
  input: QuestionFormInput,
): { ok: true; value: SanitisedQuestion } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const body = sanitiseMultiline(input.body, MAX_BODY);
  if (body.length < 5) {
    errors.push({ field: "body", message: "Type your question." });
  }
  const customerName = sanitiseLine(input.customerName, MAX_NAME);
  if (customerName.length < 1) {
    errors.push({ field: "customerName", message: "Enter your name." });
  }
  const customerEmail = sanitiseLine(input.customerEmail, MAX_EMAIL).toLowerCase();
  if (!isValidEmail(customerEmail)) {
    errors.push({ field: "customerEmail", message: "Enter a valid email." });
  }
  const productId = sanitiseLine(input.productId, 64);
  if (!productId) {
    errors.push({ field: "productId", message: "Missing product." });
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { body, customerName, customerEmail, productId } };
}

export function sanitiseLine(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const CONTROL_CHAR_RE = new RegExp(
  "[" +
    "\\u0000-\\u0008" +
    "\\u000B\\u000C" +
    "\\u000E-\\u001F" +
    "\\u007F" +
    "]",
  "g",
);

export function sanitiseMultiline(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHAR_RE, "")
    .trim()
    .slice(0, max);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(s: string): boolean {
  if (typeof s !== "string") return false;
  if (s.length > MAX_EMAIL) return false;
  return EMAIL_RE.test(s);
}

// ─── Aggregation helpers ────────────────────────────────────────────

export interface RatingHistogram {
  total: number;
  average: number;
  counts: { 1: number; 2: number; 3: number; 4: number; 5: number };
}

export function aggregateRatings(
  ratings: number[],
): RatingHistogram {
  const counts: RatingHistogram["counts"] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of ratings) {
    const k = clampRating(r);
    if (k >= 1 && k <= 5) {
      counts[k as 1 | 2 | 3 | 4 | 5] += 1;
      sum += k;
    }
  }
  const total = counts[1] + counts[2] + counts[3] + counts[4] + counts[5];
  return {
    total,
    average: total === 0 ? 0 : Math.round((sum / total) * 100) / 100,
    counts,
  };
}

// ─── Time helpers ───────────────────────────────────────────────────

export const DAYS_BEFORE_REQUEST = 7;
export const DAYS_BEFORE_REMINDER = 14;

export function reviewRequestDelayMs(): number {
  return DAYS_BEFORE_REQUEST * DAY_MS;
}

export function reminderDelayMs(): number {
  return DAYS_BEFORE_REMINDER * DAY_MS;
}

// ─── ID + token helpers ─────────────────────────────────────────────

export function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `${prefix}_${hex}`;
}

export async function hashIp(ip: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(`${salt}::${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex.slice(0, 32);
}

// ─── App proxy verification ─────────────────────────────────────────
//
// Shopify signs every app-proxy request with the API secret. We check
// the `signature` param against an HMAC of the alphabetically sorted
// remaining params. Spec:
// https://shopify.dev/docs/apps/build/online-store/app-proxies#calculate-a-digital-signature
export async function verifyAppProxySignature(
  params: URLSearchParams,
  apiSecret: string,
): Promise<boolean> {
  const signature = params.get("signature");
  if (!signature) return false;
  const sorted = Array.from(params.entries())
    .filter(([k]) => k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(sorted)),
  );
  let expected = "";
  for (const b of sigBytes) expected += b.toString(16).padStart(2, "0");
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

// Strip the shop+signature+path_prefix params Shopify injects on every
// app-proxy request before echoing user input back. Saves the caller a
// few defensive deletes when building response payloads.
export function appProxyQueryParams(input: URL | URLSearchParams): URLSearchParams {
  const src = input instanceof URL ? input.searchParams : input;
  const out = new URLSearchParams();
  for (const [k, v] of src.entries()) {
    if (k === "signature" || k === "shop" || k === "path_prefix" || k === "timestamp" || k === "logged_in_customer_id") {
      continue;
    }
    out.append(k, v);
  }
  return out;
}
