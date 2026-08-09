// The judgment store and the two ways rows land in it: a human thumb
// (POST /feedback) and the listing every drawer reads (GET /eval/judgments).
import { http, HttpResponse } from "msw";
import type { FeedbackRequest, Judgment } from "../../../api/types";
import { BASE, counters } from "../state";
import { allConversations } from "./conversations";

// ---------------------------------------------------------- judgments state
// Append-only store, held newest-first (listJudgments "Matching judgments,
// newest first") — POST /feedback unshifts; fixtures seed via pushHumanJudgment
// (oldest first, so the newest ends up in front).
//
// conversation_id is NOT a Judgment field (it is a server-side scope index, see
// mock/db.py judgments), so the mirror keeps it beside each row rather than on
// it — that is what serves ?conversation_id= without inventing wire surface.
export const mockJudgments: Judgment[] = [];
const conversationScope = new Map<string, string | null>();
export const feedbackRequests: FeedbackRequest[] = [];
export const judgmentRequests: URL[] = [];

function store(judgment: Judgment, conversationId: string | null): Judgment {
  mockJudgments.unshift(judgment);
  conversationScope.set(judgment.id, conversationId);
  return judgment;
}

export function pushHumanJudgment(
  turn_id: string,
  conversation_id: string,
  rating: "up" | "down",
  created_at: string,
  // The thumb's optional comment, stored on reasoning.
  reasoning: string | null = null,
): Judgment {
  // A thumb: subject = the turn, scorer = {kind: human} with ref/version/model
  // null ("a thumb runs no rubric and no model", openapi.yaml Scorer);
  // score 1 = 👍, 0 = 👎.
  return store(
    {
      id: `j-${++counters.judgment}`,
      subject: { kind: "turn", id: turn_id },
      scorer: { kind: "human", ref: null, version: null, model: null },
      evaluation_id: null,
      score: rating === "up" ? 1 : 0,
      reasoning,
      created_at,
    },
    conversation_id,
  );
}

// Seed helper — an LLM judgment: subject is always a CASE (every judge path
// converges on one, openapi.yaml JudgmentSubject) and the scorer names the
// rubric it ran. Push OLDEST first: store() unshifts, keeping the list
// newest-first.
export function pushLlmJudgment(
  fields: Omit<Partial<Judgment>, "subject" | "scorer"> & {
    case_id: string;
    score: number;
    scorer?: Partial<Judgment["scorer"]>;
    conversation_id?: string | null;
  },
): Judgment {
  const { case_id, scorer, conversation_id, ...rest } = fields;
  return store(
    {
      id: `j-${++counters.judgment}`,
      subject: { kind: "case", id: case_id },
      scorer: {
        kind: "llm",
        ref: "rub-help",
        version: 2,
        model: "claude-haiku-4-5",
        ...scorer,
      },
      evaluation_id: null,
      reasoning: null,
      created_at: new Date().toISOString(),
      ...rest,
    },
    conversation_id ?? null,
  );
}

export const judgmentHandlers = [
  // POST /feedback (postFeedback): appends a scorer:human Judgment
  // ("message_id = Turn.id"; append-only — no delete/un-vote endpoint exists).
  http.post(`${BASE}/feedback`, async ({ request }) => {
    const body = (await request.json()) as FeedbackRequest;
    feedbackRequests.push(body);
    const owner = allConversations().find((c) => c.turns?.some((t) => t.id === body.message_id));
    const judgment: Judgment = {
      id: `j-fb-${++counters.judgment}`,
      subject: { kind: "turn", id: body.message_id },
      scorer: { kind: "human", ref: null, version: null, model: null },
      evaluation_id: null,
      score: body.rating === "up" ? 1 : 0,
      // FeedbackRequest.comment lands on reasoning, mirroring the
      // real mock (mock/main.py feedback handler); blank = no comment.
      reasoning: body.comment?.trim() || null,
      created_at: new Date().toISOString(),
    };
    // DELIBERATE DIVERGENCE (kept): the real mock 404s an unknown message_id
    // (mock/main.py feedback). MSW accepts it, scoped to no conversation,
    // because a JUST-STREAMED assistant turn only exists in the SSE frames —
    // it was never added to the conversation fixtures — and thumbing it is the
    // single most-tested chat interaction. Narrow and safe: the divergence
    // only makes MSW more permissive, and on a scope the UI never reads back.
    // Note POST /feedback is deliberately NOT in the tree_disabled write set
    // (mock/main.py "a thumb annotates existing history"), which MSW matches.
    store(judgment, owner?.id ?? null);
    return HttpResponse.json(judgment, { status: 201 });
  }),

  // GET /eval/judgments (listJudgments): equality filters, paginated, newest
  // first (store order). conversation_id filters the scope map, not the row.
  http.get(`${BASE}/eval/judgments`, ({ request }) => {
    const url = new URL(request.url);
    judgmentRequests.push(url);
    let items = mockJudgments;
    const subjectKind = url.searchParams.get("subject_kind");
    if (subjectKind) items = items.filter((j) => j.subject.kind === subjectKind);
    const subjectId = url.searchParams.get("subject_id");
    if (subjectId) items = items.filter((j) => j.subject.id === subjectId);
    const evaluationId = url.searchParams.get("evaluation_id");
    if (evaluationId) items = items.filter((j) => j.evaluation_id === evaluationId);
    const scorerRef = url.searchParams.get("scorer_ref");
    if (scorerRef) items = items.filter((j) => j.scorer.ref === scorerRef);
    const conversationId = url.searchParams.get("conversation_id");
    if (conversationId)
      items = items.filter((j) => conversationScope.get(j.id) === conversationId);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("page_size") ?? 50);
    return HttpResponse.json(items.slice((page - 1) * pageSize, page * pageSize));
  }),
];

export function resetJudgments() {
  mockJudgments.length = 0;
  conversationScope.clear();
  feedbackRequests.length = 0;
  judgmentRequests.length = 0;
}
