// MSW handlers derived from openapi.yaml v0.2.0 — reused by later tasks.
// Covers: GET /me (openapi.yaml:62), GET /agenttrees (:115),
// GET /agenttrees/{tree}/conversations (:335, params search/page/page_size/
// forks_of/agent_id/origin), GET/PATCH/DELETE .../conversations/{id} (:387),
// POST /agenttrees/{tree}/chat (:452-521, SSE task/token/done/error + JSON
// mode), DELETE /tasks/{taskId} (:832-847, stop-generation),
// POST /feedback (:556-583, appends a type:human Judgment),
// GET /eval/judgments (:956-999, filters + newest first; P1-T12b extends).
import { http, HttpResponse } from "msw";
import { BASE } from "../../api/base";
import type {
  AgentTree,
  Attachment,
  ChatRequest,
  ChatResponse,
  Conversation,
  FeedbackRequest,
  Judgment,
  Me,
  Task,
  Turn,
} from "../../api/types";

export const mockMe: Me = {
  user: { id: "dev", name: "Dev User", email: "dev@example.com" },
  permissions: { agent1: ["view", "tune", "evaluate"], agent2: ["view"] },
};

export const mockTrees: AgentTree[] = [
  { id: "agent1", name: "Agent 1", enabled: true },
  { id: "agent2", name: "Agent 2", enabled: true },
];

const envelope = {
  system_date: "2026-08-02",
  timezone: "Europe/London",
  region: "GB",
  locale: "en-GB",
};

function conv(partial: Partial<Conversation> & Pick<Conversation, "id" | "title">): Conversation {
  return {
    tree_id: "agent1",
    origin: "interactive",
    created_at: "2026-08-01T10:00:00Z",
    last_activity_at: "2026-08-03T10:00:00Z",
    fork_count: 0,
    ...partial,
  };
}

// Roots (lineage null) — sorted by last activity, server-side (openapi.yaml:381).
export const mockRoots: Conversation[] = [
  conv({
    id: "c1",
    title: "Refund escalation",
    last_activity_at: "2026-08-04T09:58:00Z",
    turns: [
      {
        id: "t1",
        role: "user",
        author: "user",
        content: "How do refunds work?",
        created_at: "2026-08-04T09:57:00Z",
        envelope,
        // Stored attachment rendered on the user turn (openapi.yaml:1313-1315;
        // url null in Phase 1 per openapi.yaml:1284).
        attachments: [
          {
            id: "att-fixture",
            filename: "spec.pdf",
            content_type: "application/pdf",
            size: 12345,
            url: null,
          },
        ],
      },
      {
        id: "t2",
        role: "assistant",
        author: "refunds",
        content: "Approved refunds land in 3-5 days.",
        created_at: "2026-08-04T09:58:00Z",
        envelope,
      },
    ],
  }),
  conv({ id: "c2", title: "Billing dispute", fork_count: 2, last_activity_at: "2026-08-04T09:00:00Z" }),
  conv({ id: "c3", title: "Onboarding help", last_activity_at: "2026-08-01T10:00:00Z" }),
];

export const mockForks: Record<string, Conversation[]> = {
  c2: [
    conv({
      id: "c2f1",
      title: "Billing dispute",
      lineage: {
        parent_conversation_id: "c2",
        fork_turn_id: "t9",
        endpoint_id: "prod",
        config: { instruction_version: 15 },
      },
    }),
    conv({
      id: "c2f2",
      title: "Billing dispute",
      lineage: {
        parent_conversation_id: "c2",
        fork_turn_id: "t9",
        endpoint_id: "staging",
        config: { instruction_version: 15 },
      },
    }),
  ],
};

// Requests seen by the conversations handler — tests assert query params here.
export const conversationRequests: URL[] = [];

// ---------------------------------------------------------- judgments state
// Append-only store, held newest-first (openapi.yaml:994 "Matching judgments,
// newest first") — POST /feedback unshifts; fixtures seed via pushHumanJudgment
// (oldest first, so the newest ends up in front). P1-T12b adds llm judgments.
export const mockJudgments: Judgment[] = [];
export const feedbackRequests: FeedbackRequest[] = [];
export const judgmentRequests: URL[] = [];
let judgmentCounter = 0;

export function pushHumanJudgment(
  turn_id: string,
  conversation_id: string,
  rating: "up" | "down",
  created_at: string,
): Judgment {
  // Judgment type human: rubric/case fields null; score 1 = 👍, 0 = 👎
  // (openapi.yaml:1881-1907).
  const judgment: Judgment = {
    id: `j-${++judgmentCounter}`,
    case_id: null,
    run_id: null,
    turn_id,
    conversation_id,
    type: "human",
    judge_model: null,
    rubric_id: null,
    rubric_version: null,
    score: rating === "up" ? 1 : 0,
    reasoning: null,
    created_at,
  };
  mockJudgments.unshift(judgment);
  return judgment;
}

// -------------------------------------------------------------- upload state
// POST /upload knobs (openapi.yaml:523-554). maxBytes mirrors the real mock's
// Phase-1 limit (mock/config.py:15 MAX_UPLOAD_BYTES = 5 MiB) — tests shrink it
// to simulate 413 without building multi-MB files. `gate` (when set) is
// awaited before responding so tests can observe the uploading state.
export const uploadConfig: {
  maxBytes: number;
  gate: (() => Promise<void>) | null;
} = { maxBytes: 5 * 1024 * 1024, gate: null };

export const uploadRequests: Array<{ filename: string; size: number }> = [];
let attachmentCounter = 0;

// ---------------------------------------------------------------- chat state
// Knobs for the chat SSE handler. `gate` (when set) is awaited before each
// token and before done — tests use it to step the stream deterministically.
// `errorAfter` emits an `error` frame after N tokens instead of finishing.
export const chatConfig: {
  tokens: string[];
  delayMs: number;
  gate: (() => Promise<void>) | null;
  errorAfter: number | null;
} = { tokens: ["Hello ", "streaming ", "**world**."], delayMs: 2, gate: null, errorAfter: null };

export const chatRequests: ChatRequest[] = [];
export const cancelRequests: string[] = []; // task ids seen by DELETE /tasks/{id}
const cancelledTasks = new Set<string>();
let newConvCounter = 0;

const initialRoots = [...mockRoots];

export function resetHandlerState() {
  conversationRequests.length = 0;
  uploadRequests.length = 0;
  attachmentCounter = 0;
  uploadConfig.maxBytes = 5 * 1024 * 1024;
  uploadConfig.gate = null;
  chatRequests.length = 0;
  cancelRequests.length = 0;
  mockJudgments.length = 0;
  feedbackRequests.length = 0;
  judgmentRequests.length = 0;
  judgmentCounter = 0;
  cancelledTasks.clear();
  newConvCounter = 0;
  chatConfig.tokens = ["Hello ", "streaming ", "**world**."];
  chatConfig.delayMs = 2;
  chatConfig.gate = null;
  chatConfig.errorAfter = null;
  mockRoots.length = 0;
  mockRoots.push(...initialRoots);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const handlers = [
  http.get(`${BASE}/me`, () => HttpResponse.json(mockMe)),

  http.get(`${BASE}/agenttrees`, () => HttpResponse.json(mockTrees)),

  http.get(`${BASE}/agenttrees/:tree/conversations`, ({ request }) => {
    const url = new URL(request.url);
    conversationRequests.push(url);
    const forksOf = url.searchParams.get("forks_of");
    const search = url.searchParams.get("search")?.toLowerCase();
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("page_size") ?? 20);

    let items = forksOf ? (mockForks[forksOf] ?? []) : mockRoots;
    if (search) items = items.filter((c) => c.title.toLowerCase().includes(search));
    const total = items.length;
    items = items.slice((page - 1) * pageSize, page * pageSize);
    // Listing strips full turns? Contract includes turns in listings
    // (openapi.yaml:1376) — keep them.
    return HttpResponse.json({ items, page, page_size: pageSize, total });
  }),

  http.get(`${BASE}/agenttrees/:tree/conversations/:id`, ({ params }) => {
    const all = [...mockRoots, ...Object.values(mockForks).flat()];
    const found = all.find((c) => c.id === params.id);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "conversation not found" }, { status: 404 });
    }
    return HttpResponse.json(found);
  }),

  http.patch(`${BASE}/agenttrees/:tree/conversations/:id`, async ({ params, request }) => {
    const body = (await request.json()) as { title?: string };
    const found = mockRoots.find((c) => c.id === params.id);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "conversation not found" }, { status: 404 });
    }
    return HttpResponse.json({ ...found, title: body.title ?? found.title, turns: undefined });
  }),

  http.delete(`${BASE}/agenttrees/:tree/conversations/:id`, () =>
    new HttpResponse(null, { status: 204 }),
  ),

  // POST /agenttrees/{tree}/chat (openapi.yaml:452-521): stream=true → SSE
  // frames task/token/done/error; stream=false → single JSON ChatResponse.
  // Omitting conversation_id starts a new conversation (openapi.yaml:488).
  http.post(`${BASE}/agenttrees/:tree/chat`, async ({ request }) => {
    const body = (await request.json()) as ChatRequest;
    chatRequests.push(body);
    const isNew = !body.conversation_id;
    const convId = body.conversation_id ?? `c-new-${++newConvCounter}`;
    const taskId = `task-${convId}`;
    if (isNew) {
      mockRoots.unshift(
        conv({
          id: convId,
          title: body.message.slice(0, 40),
          last_activity_at: new Date().toISOString(),
        }),
      );
    }
    const assistantTurn = (content: string): Turn => ({
      id: `t-a-${taskId}`,
      role: "assistant",
      author: "assistant",
      content,
      created_at: new Date().toISOString(),
      envelope,
    });

    if (body.stream === false) {
      const response: ChatResponse = {
        task_id: taskId,
        conversation_id: convId,
        turn: assistantTurn(chatConfig.tokens.join("")),
      };
      return HttpResponse.json(response);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const frame = (event: string, data: unknown) =>
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        frame("task", {
          task_id: taskId,
          conversation_id: convId,
          user_turn_id: `t-u-${taskId}`,
          assistant_turn_id: `t-a-${taskId}`,
        });
        let sent = "";
        let count = 0;
        for (const token of chatConfig.tokens) {
          await (chatConfig.gate?.() ?? sleep(chatConfig.delayMs));
          if (cancelledTasks.has(taskId)) {
            // done(cancelled) carries the persisted partial content
            // (openapi.yaml:1470).
            frame("done", { status: "cancelled", turn: assistantTurn(sent) });
            controller.close();
            return;
          }
          if (chatConfig.errorAfter !== null && count >= chatConfig.errorAfter) {
            frame("error", { code: "generation_failed", message: "model exploded" });
            controller.close();
            return;
          }
          sent += token;
          count++;
          frame("token", { delta: token });
        }
        await (chatConfig.gate?.() ?? sleep(chatConfig.delayMs));
        frame("done", {
          status: cancelledTasks.has(taskId) ? "cancelled" : "completed",
          turn: assistantTurn(sent),
        });
        controller.close();
      },
    });
    return new HttpResponse(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),

  // POST /upload (openapi.yaml:523-554): multipart {file} → 201 Attachment
  // (url null in Phase 1); oversize → 413 Error, "the UI surfaces the message"
  // (openapi.yaml:535-536). Message mirrors mock/main.py:478-479.
  http.post(`${BASE}/upload`, async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");
    // No instanceof File: the parsed value is undici's File while the jsdom
    // test env's global File is jsdom's — different classes.
    if (!file || typeof file === "string") {
      return HttpResponse.json(
        { code: "bad_request", message: "multipart field 'file' is required" },
        { status: 400 },
      );
    }
    uploadRequests.push({ filename: file.name, size: file.size });
    await uploadConfig.gate?.();
    if (file.size > uploadConfig.maxBytes) {
      return HttpResponse.json(
        {
          code: "too_large",
          message: `File exceeds the ${Math.floor(uploadConfig.maxBytes / (1024 * 1024))} MB upload limit.`,
        },
        { status: 413 },
      );
    }
    const attachment: Attachment = {
      id: `att-${++attachmentCounter}`,
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      size: file.size,
      url: null,
    };
    return HttpResponse.json(attachment, { status: 201 });
  }),

  // POST /feedback (openapi.yaml:556-583): appends a type:human Judgment
  // ("message_id = Turn.id"; append-only — no delete/un-vote endpoint exists).
  http.post(`${BASE}/feedback`, async ({ request }) => {
    const body = (await request.json()) as FeedbackRequest;
    feedbackRequests.push(body);
    const all = [...mockRoots, ...Object.values(mockForks).flat()];
    const owner = all.find((c) => c.turns?.some((t) => t.id === body.message_id));
    const judgment: Judgment = {
      id: `j-fb-${++judgmentCounter}`,
      case_id: null,
      run_id: null,
      turn_id: body.message_id,
      // Streamed turns aren't in the fixtures' turn lists — accept them with a
      // null conversation_id rather than 404ing (the real mock enforces 404).
      conversation_id: owner?.id ?? null,
      type: "human",
      judge_model: null,
      rubric_id: null,
      rubric_version: null,
      score: body.rating === "up" ? 1 : 0,
      reasoning: null,
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

  // DELETE /tasks/{taskId} — cancel; doubles as chat stop-generation
  // (openapi.yaml:832-847).
  http.delete(`${BASE}/tasks/:taskId`, ({ params }) => {
    const id = params.taskId as string;
    cancelRequests.push(id);
    cancelledTasks.add(id);
    const task: Task = {
      id,
      type: "chat",
      status: "cancelled",
      progress: { done: 0, total: 1 },
      created_at: new Date().toISOString(),
    };
    return HttpResponse.json(task);
  }),
];
