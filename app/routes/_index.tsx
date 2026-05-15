import type {
  ActionFunctionArgs,
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import {
  Form,
  useFetcher,
  useLoaderData,
  useSearchParams,
} from "@remix-run/react";
import {
  AppProvider,
  Badge,
  Banner,
  Box,
  Button,
  ButtonGroup,
  Card,
  EmptyState,
  Frame,
  InlineStack,
  Layout,
  Page,
  Pagination,
  Tabs,
  Text,
  TextField,
  BlockStack,
  Select,
} from "@shopify/polaris";
import polarisTranslations from "@shopify/polaris/locales/en.json";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { useCallback, useEffect, useMemo, useState } from "react";
import { requireAdminLoader } from "~/lib/admin-auth.server";
import { runMigrations } from "~/lib/db/migrate.server";
import {
  answerQuestion,
  countQuestionsByStatus,
  countReviewsByStatus,
  listQuestions,
  listReviews,
  replyToReview,
  setQuestionStatus,
  setReviewStatus,
} from "~/lib/reviews.server";
import type { ReviewRow, QuestionRow } from "~/lib/db/schema.server";
import {
  isValidQuestionStatus,
  isValidReviewStatus,
  nextReviewStatus,
  type ReviewAction,
} from "~/lib/reviews-helpers";

export const meta: MetaFunction = () => [
  { title: "Reviews — Test Reviews App" },
];

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: polarisStyles },
];

const PAGE_SIZE = 10;

interface LoaderData {
  shop: string;
  tab: "reviews" | "questions";
  status: string;
  search: string;
  page: number;
  reviewItems: ReviewRow[];
  reviewTotal: number;
  questionItems: QuestionRow[];
  questionTotal: number;
  reviewCounts: Record<string, number>;
  questionCounts: Record<string, number>;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  await runMigrations(context);
  const { shop } = await requireAdminLoader(request, context);
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") === "questions" ? "questions" : "reviews";
  const status = url.searchParams.get("status") ?? "any";
  const search = (url.searchParams.get("search") ?? "").trim();
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const [reviewCounts, questionCounts] = await Promise.all([
    countReviewsByStatus(context, shop),
    countQuestionsByStatus(context, shop),
  ]);
  if (tab === "reviews") {
    const { items, total } = await listReviews(context, {
      shop,
      status: isValidReviewStatus(status) ? status : "any",
      search: search || undefined,
      limit: PAGE_SIZE,
      offset,
    });
    return json<LoaderData>({
      shop,
      tab,
      status,
      search,
      page,
      reviewItems: items,
      reviewTotal: total,
      questionItems: [],
      questionTotal: 0,
      reviewCounts,
      questionCounts,
    });
  }
  const { items, total } = await listQuestions(context, {
    shop,
    status: isValidQuestionStatus(status) ? status : "any",
    search: search || undefined,
    limit: PAGE_SIZE,
    offset,
  });
  return json<LoaderData>({
    shop,
    tab,
    status,
    search,
    page,
    reviewItems: [],
    reviewTotal: 0,
    questionItems: items,
    questionTotal: total,
    reviewCounts,
    questionCounts,
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  await runMigrations(context);
  const { shop } = await requireAdminLoader(request, context);
  const form = await request.formData();
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");
  const intentTab = String(form.get("tab") ?? "reviews");
  if (!id) {
    return json({ ok: false, error: "Missing id" }, { status: 400 });
  }
  try {
    if (intentTab === "reviews") {
      if (op === "approve" || op === "reject" || op === "mark_spam" || op === "unpublish") {
        const currentRaw = String(form.get("currentStatus") ?? "pending");
        const current = isValidReviewStatus(currentRaw) ? currentRaw : "pending";
        const next = nextReviewStatus(current, op as ReviewAction);
        await setReviewStatus(context, shop, id, next);
        return json({ ok: true, op, next });
      }
      if (op === "reply") {
        const reply = String(form.get("reply") ?? "").trim().slice(0, 4000);
        await replyToReview(context, shop, id, reply ? reply : null);
        return json({ ok: true, op });
      }
    } else {
      if (op === "approve" || op === "reject" || op === "unpublish") {
        const next = op === "approve" ? "approved" : op === "reject" ? "rejected" : "pending";
        await setQuestionStatus(context, shop, id, next);
        return json({ ok: true, op, next });
      }
      if (op === "answer") {
        const answer = String(form.get("answer") ?? "").trim().slice(0, 4000);
        await answerQuestion(context, shop, id, answer ? answer : null);
        return json({ ok: true, op });
      }
    }
  } catch (err) {
    return json(
      { ok: false, error: err instanceof Error ? err.message : "Unexpected error" },
      { status: 500 },
    );
  }
  return json({ ok: false, error: "Unknown op" }, { status: 400 });
}

export default function AdminIndex() {
  const data = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(data.search);

  useEffect(() => {
    setSearch(data.search);
  }, [data.search]);

  const tabs = useMemo(
    () => [
      {
        id: "reviews",
        content: `Reviews (${data.reviewCounts.pending ?? 0})`,
        accessibilityLabel: "Reviews",
        panelID: "reviews-panel",
      },
      {
        id: "questions",
        content: `Questions (${data.questionCounts.pending ?? 0})`,
        accessibilityLabel: "Questions",
        panelID: "questions-panel",
      },
    ],
    [data.reviewCounts, data.questionCounts],
  );
  const selectedTabIdx = data.tab === "reviews" ? 0 : 1;

  const updateParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params);
      if (value) next.set(key, value);
      else next.delete(key);
      next.set("page", "1");
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const onTabChange = useCallback(
    (idx: number) => {
      const next = new URLSearchParams(params);
      next.set("tab", idx === 0 ? "reviews" : "questions");
      next.set("status", "any");
      next.set("page", "1");
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const onSearchSubmit = useCallback(() => {
    updateParam("search", search.trim());
  }, [search, updateParam]);

  const statusOptions =
    data.tab === "reviews"
      ? [
          { label: "All", value: "any" },
          { label: `Pending (${data.reviewCounts.pending ?? 0})`, value: "pending" },
          { label: `Approved (${data.reviewCounts.approved ?? 0})`, value: "approved" },
          { label: `Rejected (${data.reviewCounts.rejected ?? 0})`, value: "rejected" },
          { label: `Spam (${data.reviewCounts.spam ?? 0})`, value: "spam" },
        ]
      : [
          { label: "All", value: "any" },
          { label: `Pending (${data.questionCounts.pending ?? 0})`, value: "pending" },
          { label: `Approved (${data.questionCounts.approved ?? 0})`, value: "approved" },
          { label: `Rejected (${data.questionCounts.rejected ?? 0})`, value: "rejected" },
        ];

  const total = data.tab === "reviews" ? data.reviewTotal : data.questionTotal;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <AppProvider i18n={polarisTranslations}>
      <Frame>
        <Page
          title="Reviews & questions"
          subtitle={`Moderate submissions for ${data.shop}`}
        >
          <Layout>
            <Layout.Section>
              <Card>
                <Tabs tabs={tabs} selected={selectedTabIdx} onSelect={onTabChange} />
                <Box padding="400">
                  <BlockStack gap="400">
                    <InlineStack gap="300" align="start" blockAlign="center">
                      <Box minWidth="220px">
                        <Select
                          label="Status"
                          labelHidden
                          options={statusOptions}
                          value={data.status}
                          onChange={(v) => updateParam("status", v)}
                        />
                      </Box>
                      <Box minWidth="320px">
                        <Form
                          method="get"
                          onSubmit={(e) => {
                            e.preventDefault();
                            onSearchSubmit();
                          }}
                        >
                          <TextField
                            label="Search"
                            labelHidden
                            placeholder="Search title, body, name or email"
                            autoComplete="off"
                            value={search}
                            onChange={setSearch}
                            connectedRight={
                              <Button submit variant="primary">
                                Search
                              </Button>
                            }
                          />
                        </Form>
                      </Box>
                    </InlineStack>

                    {data.tab === "reviews" ? (
                      <ReviewsTable items={data.reviewItems} />
                    ) : (
                      <QuestionsTable items={data.questionItems} />
                    )}

                    {totalPages > 1 ? (
                      <InlineStack align="center">
                        <Pagination
                          hasPrevious={data.page > 1}
                          hasNext={data.page < totalPages}
                          onPrevious={() =>
                            updateParam("page", String(Math.max(1, data.page - 1)))
                          }
                          onNext={() =>
                            updateParam("page", String(Math.min(totalPages, data.page + 1)))
                          }
                          label={`Page ${data.page} of ${totalPages}`}
                        />
                      </InlineStack>
                    ) : null}
                  </BlockStack>
                </Box>
              </Card>
            </Layout.Section>
          </Layout>
        </Page>
      </Frame>
    </AppProvider>
  );
}

function ReviewsTable({ items }: { items: ReviewRow[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        heading="No reviews yet"
        image="https://cdn.shopify.com/shopifycloud/web/assets/v1/empty-state.svg"
        action={{ content: "Refresh", url: "?" }}
      >
        <Text as="p" tone="subdued">
          When customers submit reviews on your storefront they appear here for moderation.
        </Text>
      </EmptyState>
    );
  }
  return (
    <BlockStack gap="300">
      {items.map((r) => (
        <ReviewRowCard key={r.id} review={r} />
      ))}
    </BlockStack>
  );
}

function ReviewRowCard({ review }: { review: ReviewRow }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [reply, setReply] = useState(review.reply ?? "");

  const onAction = useCallback(
    (op: ReviewAction) => {
      const form = new FormData();
      form.set("op", op);
      form.set("id", review.id);
      form.set("currentStatus", review.status);
      form.set("tab", "reviews");
      fetcher.submit(form, { method: "post" });
    },
    [fetcher, review.id, review.status],
  );

  const onReply = useCallback(() => {
    const form = new FormData();
    form.set("op", "reply");
    form.set("id", review.id);
    form.set("reply", reply);
    form.set("tab", "reviews");
    fetcher.submit(form, { method: "post" });
  }, [fetcher, reply, review.id]);

  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="p" variant="headingSm">
                {"★".repeat(review.rating)}
                {"☆".repeat(5 - review.rating)} {review.title || "(no title)"}
              </Text>
              <Badge tone={statusTone(review.status)}>{review.status}</Badge>
              {review.verified === 1 ? <Badge tone="success">Verified</Badge> : null}
            </InlineStack>
            <Text as="span" tone="subdued" variant="bodySm">
              {review.customer_name} · {review.customer_email} ·{" "}
              {new Date(review.created_at).toLocaleString()}
            </Text>
          </BlockStack>
        </InlineStack>
        <Text as="p">{review.body}</Text>
        {review.photo_url ? (
          <Box>
            <img
              src={review.photo_url}
              alt="Customer photo"
              style={{ maxWidth: 240, maxHeight: 240, borderRadius: 4 }}
            />
          </Box>
        ) : null}
        <TextField
          label="Merchant reply"
          autoComplete="off"
          multiline={3}
          value={reply}
          onChange={setReply}
          maxLength={4000}
          helpText="Visible publicly under this review once the review is approved."
        />
        <InlineStack gap="200">
          <ButtonGroup>
            <Button
              variant="primary"
              tone="success"
              disabled={busy || review.status === "approved"}
              onClick={() => onAction("approve")}
            >
              Approve
            </Button>
            <Button
              tone="critical"
              disabled={busy || review.status === "rejected"}
              onClick={() => onAction("reject")}
            >
              Reject
            </Button>
            <Button
              disabled={busy || review.status === "spam"}
              onClick={() => onAction("mark_spam")}
            >
              Mark spam
            </Button>
            <Button
              disabled={busy || review.status !== "approved"}
              onClick={() => onAction("unpublish")}
            >
              Unpublish
            </Button>
          </ButtonGroup>
          <Button onClick={onReply} loading={busy && fetcher.formData?.get("op") === "reply"}>
            Save reply
          </Button>
        </InlineStack>
        {fetcher.data && fetcher.data.ok === false ? (
          <Banner tone="critical" title="Action failed">
            {"error" in fetcher.data ? fetcher.data.error : "Try again."}
          </Banner>
        ) : null}
      </BlockStack>
    </Card>
  );
}

function statusTone(s: string): "info" | "success" | "warning" | "critical" | undefined {
  switch (s) {
    case "approved":
      return "success";
    case "pending":
      return "info";
    case "rejected":
      return "critical";
    case "spam":
      return "warning";
    default:
      return undefined;
  }
}

function QuestionsTable({ items }: { items: QuestionRow[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        heading="No customer questions yet"
        image="https://cdn.shopify.com/shopifycloud/web/assets/v1/empty-state.svg"
        action={{ content: "Refresh", url: "?tab=questions" }}
      >
        <Text as="p" tone="subdued">
          When shoppers ask a question on a product page it lands here.
        </Text>
      </EmptyState>
    );
  }
  return (
    <BlockStack gap="300">
      {items.map((q) => (
        <QuestionRowCard key={q.id} question={q} />
      ))}
    </BlockStack>
  );
}

function QuestionRowCard({ question }: { question: QuestionRow }) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const [answer, setAnswer] = useState(question.answer ?? "");

  const onAction = useCallback(
    (op: "approve" | "reject" | "unpublish") => {
      const form = new FormData();
      form.set("op", op);
      form.set("id", question.id);
      form.set("tab", "questions");
      fetcher.submit(form, { method: "post" });
    },
    [fetcher, question.id],
  );

  const onAnswer = useCallback(() => {
    const form = new FormData();
    form.set("op", "answer");
    form.set("id", question.id);
    form.set("answer", answer);
    form.set("tab", "questions");
    fetcher.submit(form, { method: "post" });
  }, [fetcher, answer, question.id]);

  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="start">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="p" variant="headingSm">
                Question from {question.customer_name}
              </Text>
              <Badge tone={statusTone(question.status)}>{question.status}</Badge>
            </InlineStack>
            <Text as="span" tone="subdued" variant="bodySm">
              {question.customer_email} · {new Date(question.created_at).toLocaleString()}
            </Text>
          </BlockStack>
        </InlineStack>
        <Text as="p">{question.body}</Text>
        <TextField
          label="Answer"
          autoComplete="off"
          multiline={3}
          value={answer}
          onChange={setAnswer}
          maxLength={4000}
          helpText="Public once the question is approved."
        />
        <InlineStack gap="200">
          <ButtonGroup>
            <Button
              variant="primary"
              tone="success"
              disabled={busy || question.status === "approved"}
              onClick={() => onAction("approve")}
            >
              Approve
            </Button>
            <Button
              tone="critical"
              disabled={busy || question.status === "rejected"}
              onClick={() => onAction("reject")}
            >
              Reject
            </Button>
            <Button
              disabled={busy || question.status !== "approved"}
              onClick={() => onAction("unpublish")}
            >
              Unpublish
            </Button>
          </ButtonGroup>
          <Button
            onClick={onAnswer}
            loading={busy && fetcher.formData?.get("op") === "answer"}
          >
            Save answer
          </Button>
        </InlineStack>
        {fetcher.data && fetcher.data.ok === false ? (
          <Banner tone="critical" title="Action failed">
            {"error" in fetcher.data ? fetcher.data.error : "Try again."}
          </Banner>
        ) : null}
      </BlockStack>
    </Card>
  );
}

// Allow this module to be imported by Remix v3 single-fetch without
// noisy unused-export warnings.
export const handle = { id: "reviews-admin" };

// Make TS happy about `redirect` usage at top of file even though we
// don't return it directly — `requireAdminLoader` re-throws it.
void redirect;
