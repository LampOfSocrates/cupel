// The judgment store and the two ways rows land in it: a human thumb
// (POST /feedback) and the listing every drawer reads (GET /eval/judgments).
import { http, HttpResponse } from "msw";
import type { FeedbackRequest, Judgment } from "../../../api/types";
import { BASE, counters } from "../state";
import { allConversations } from "./conversations";

// ---------------------------------------------------------- judgments state
// Append-only store, held newest-first (openapi.yaml:994 "Matching judgments,
// newest first") — POST /feedback unshifts; fixtures seed via pushHumanJudgment
// (oldest first, so the newest ends up in front). P1-T12b adds llm judgments.
export const mockJudgments: Judgment[] = [];
export const feedbackRequests: FeedbackRequest[] = [];
export const judgmentRequests: URL[] = [];

export function pushHumanJudgment(
  turn_id: string,
  conversation_id: string,
  rating: "up" | "down",
  created_at: string,
  // P2-CHATUX: the thumb's optional comment, stored on reasoning.
  reasoning: string | null = null,
): Judgment {
  // Judgment type human: rubric/case fields null; score 1 = 👍, 0 = 👎
  // (openapi.yaml:1881-1907).
  const judgment: Judgment = {
    id: `j-${++counters.judgment}`,
    case_id: null,
    run_id: null,
    turn_id,
    conversation_id,
    type: "human",
    judge_model: null,
    rubric_id: null,
    rubric_version: null,
    score: rating === "up" ? 1 : 0,
    reasoning,
    created_at,
  };
  mockJudgments.unshift(judgment);
  return judgment;
}

// P1-T12b seed helper — type llm judgment: "case_id, rubric_id and
// rubric_version are non-null (the judge always runs a rubric against a
// case)" (openapi.yaml:1886-1887). Push OLDEST first: unshift keeps the store
// newest-first (openapi.yaml:994).
export function pushLlmJudgment(
  fields: Partial<Judgment> & Pick<Judgment, "case_id" | "score">,
): Judgment {
  const judgment: Judgment = {
    id: `j-${++counters.judgment}`,
    run_id: null,
    turn_id: null,
    conversation_id: null,
    type: "llm",
    judge_model: "claude-haiku-4-5",
    rubric_id: "rub-help",
    rubric_version: 2,
    reasoning: null,
    created_at: new Date().toISOString(),
    ...fields,
  };
  mockJudgments.unshift(judgment);
  return judgment;
}

export const judgmentHandlers = [
  // POST /feedback (openapi.yaml:556-583): appends a type:human Judgment
  // ("message_id = Turn.id"; append-only — no delete/un-vote endpoint exists).
  http.post(`${BASE}/feedback`, async ({ request }) => {
    const body = (await request.json()) as FeedbackRequest;
    feedbackRequests.push(body);
    const owner = allConversations().find((c) => c.turns?.some((t) => t.id === body.message_id));
    const judgment: Judgment = {
      id: `j-fb-${++counters.judgment}`,
      case_id: null,
      run_id: null,
      turn_id: body.message_id,
      // DELIBERATE DIVERGENCE (kept, P2-MSW): the real mock 404s an unknown
      // message_id (mock/main.py:1089). MSW accepts it with a null
      // conversation_id because a JUST-STREAMED assistant turn only exists in
      // the SSE frames — it was never added to the conversation fixtures — and
      // thumbing it is the single most-tested chat interaction. Narrow and
      // safe: the divergence only makes MSW more permissive on a field the UI
      // does not read back. Note POST /feedback is deliberately NOT in the
      // tree_disabled write set (mock/main.py:426-441 "a thumb annotates
      // existing history"), which MSW matches exactly.
      conversation_id: owner?.id ?? null,
      type: "human",
      judge_model: null,
      rubric_id: null,
      rubric_version: null,
      score: body.rating === "up" ? 1 : 0,
      // P2-CHATUX: FeedbackRequest.comment lands on reasoning, mirroring the
      // real mock (mock/main.py feedback handler); blank = no comment.
      reasoning: body.comment?.trim() || null,
      created_at: new Date().toISOString(),
    };
    mockJudgments.unshift(judgment);
    return HttpResponse.json(judgment, { status: 201 });
  }),

  // GET /eval/judgments (openapi.yaml:956-999): equality filters, paginated,
  // newest first (store order).
  http.get(`${BASE}/eval/judgments`, ({ request }) => {
    const url = new URL(request.url);
    judgmentRequests.push(url);
    let items = mockJudgments;
    for (const key of ["case_id", "run_id", "rubric_id", "turn_id", "conversation_id"] as const) {
      const value = url.searchParams.get(key);
      if (value) items = items.filter((j) => j[key] === value);
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("page_size") ?? 50);
    return HttpResponse.json(items.slice((page - 1) * pageSize, page * pageSize));
  }),
];

export function resetJudgments() {
  mockJudgments.length = 0;
  feedbackRequests.length = 0;
  judgmentRequests.length = 0;
}
