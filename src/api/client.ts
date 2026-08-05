// Single typed client — all API calls go through here; no hardcoded hosts
// anywhere else (feature-spec.md:158).
import { BASE } from "./base";
import { parseSseStream } from "./sse";
import type {
  Agent,
  AgentCreate,
  AgentTree,
  Attachment,
  ChatDoneEvent,
  ChatRequest,
  ChatResponse,
  ChatTaskEvent,
  Conversation,
  ConversationListParams,
  ConversationPage,
  Endpoint,
  ErrorBody,
  EvalCase,
  FeedbackRequest,
  InstructionHistory,
  InstructionSave,
  InstructionVersion,
  JudgeRequest,
  Judgment,
  JudgmentEvent,
  JudgmentListParams,
  Me,
  Model,
  ReplayAccepted,
  ReplayRequest,
  ReplayTurnAccepted,
  ReplayTurnRequest,
  Rubric,
  Run,
  RunScoreSummary,
  RunSummaryItem,
  Selection,
  Snapshot,
  SnapshotCreate,
  SpanEvent,
  SpanPayload,
  Task,
  TaskListParams,
  TaskProgressEvent,
  TaskRef,
  TokenEvent,
  Trace,
} from "./types";

export type Query = Record<string, string | number | undefined>;

// Error schema: {code, message} (openapi.yaml:1061)
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function buildUrl(path: string, query?: Query): string {
  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function errorFromResponse(res: Response): Promise<ApiError> {
  let code = "unknown";
  let message = `${res.status} ${res.statusText}`;
  try {
    const err = await res.json();
    if (err && typeof err === "object") {
      code = err.code ?? code;
      message = err.message ?? message;
    }
  } catch {
    // non-JSON error body — keep the status fallback
  }
  return new ApiError(res.status, code, message);
}

async function request<T>(
  path: string,
  opts: { method?: string; query?: Query; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw await errorFromResponse(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// SSE events of POST /agenttrees/{tree}/chat, typed per the contract
// (openapi.yaml:466-476: "task ... token ... done ... error").
export type ChatStreamEvent =
  | { event: "task"; data: ChatTaskEvent }
  | { event: "token"; data: TokenEvent }
  | { event: "done"; data: ChatDoneEvent }
  | { event: "error"; data: ErrorBody };

// SSE events of GET /tasks/stream (openapi.yaml:789-796: "task — data: Task
// (status change) · progress — data: TaskProgressEvent (per-unit ticks) ·
// span — data: SpanEvent · judgment — data: JudgmentEvent"). judgment frames
// added in T12b ("scores stream into the grid live as judging tasks finish
// (SSE)", feature-spec.md:64); span frames added in T16 — "spans appear live
// while the turn is generating (same SSE channel as tasks)"
// (feature-spec.md:150), consumed by the trace view's scoped subscription.
export type TaskStreamEvent =
  | { event: "task"; data: Task }
  | { event: "progress"; data: TaskProgressEvent }
  | { event: "span"; data: SpanEvent }
  | { event: "judgment"; data: JudgmentEvent };

// One send call covers both modes (loom-phases.md:43: "stream: true (SSE token
// stream, the UI default) and stream: false (single JSON response ...) — same
// endpoint, flag in the request body"). The kind is decided by the response
// Content-Type, so a backend that can't stream degrades gracefully to "json".
export type ChatSendResult =
  | { kind: "stream"; events: AsyncGenerator<ChatStreamEvent, void> }
  | { kind: "json"; response: ChatResponse };

async function* chatEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent, void> {
  for await (const msg of parseSseStream(body)) {
    switch (msg.event) {
      case "task":
        yield { event: "task", data: JSON.parse(msg.data) as ChatTaskEvent };
        break;
      case "token":
        yield { event: "token", data: JSON.parse(msg.data) as TokenEvent };
        break;
      case "done":
        yield { event: "done", data: JSON.parse(msg.data) as ChatDoneEvent };
        break;
      case "error":
        yield { event: "error", data: JSON.parse(msg.data) as ErrorBody };
        break;
      default:
        // keepalives / unknown events — ignore
        break;
    }
  }
}

export const api = {
  // GET /me — always called on boot (loom-phases.md:160; openapi.yaml:62)
  me: () => request<Me>("/me"),

  // GET /agenttrees (openapi.yaml:115)
  agentTrees: () => request<AgentTree[]>("/agenttrees"),

  // GET /models (openapi.yaml:98-112) — "chat/run/judge model dropdowns"
  // (feature-spec.md:122). Fetched once and cached in AppContext.
  models: () => request<Model[]>("/models"),

  // GET /agenttrees/{tree}/endpoints (openapi.yaml:154-172) — "Deploy targets
  // for replay … Multi-selected in Run Config for turn re-fire
  // (feature-spec.md:67)".
  endpoints: (tree: string) => request<Endpoint[]>(`/agenttrees/${tree}/endpoints`),

  // GET /agenttrees/{tree}/agents (openapi.yaml:175-194) — "Flat list of
  // agents with parent links (root has parent_id null)" (:188); the tree view
  // builds the hierarchy client-side.
  agents: (tree: string) => request<Agent[]>(`/agenttrees/${tree}/agents`),

  // POST /agenttrees/{tree}/agents (openapi.yaml:195-219) — add sub-agent /
  // new root; 201 = "The created agent (live_version 0 until v1 is saved)"
  // (:215).
  createAgent: (tree: string, body: AgentCreate) =>
    request<Agent>(`/agenttrees/${tree}/agents`, { method: "POST", body }),

  // GET /agenttrees/{tree}/agents/{agentId}/instructions (openapi.yaml:221-239)
  // — "Live version pointer plus full version history (for diff/rollback)"
  // (:235).
  instructions: (tree: string, agentId: string) =>
    request<InstructionHistory>(`/agenttrees/${tree}/agents/${agentId}/instructions`),

  // PUT — "Save instructions as a NEW version (append-only)" (openapi.yaml:
  // 243); 201 = "The newly created version (now live)" (:262). snapshot_id
  // promotes a draft snapshot (:245-249); "Rollback = PUT the old version's
  // content (creates a new version)" (:249-250).
  saveInstructions: (tree: string, agentId: string, body: InstructionSave) =>
    request<InstructionVersion>(`/agenttrees/${tree}/agents/${agentId}/instructions`, {
      method: "PUT",
      body,
    }),

  // POST /agenttrees/{tree}/agents/{agentId}/snapshots (openapi.yaml:268-293)
  // — "Immutable draft snapshot (for Test in Runs)" (:272); 201 → Snapshot.
  createSnapshot: (tree: string, agentId: string, body: SnapshotCreate) =>
    request<Snapshot>(`/agenttrees/${tree}/agents/${agentId}/snapshots`, {
      method: "POST",
      body,
    }),

  // GET /agenttrees/{tree}/agents/{agentId}/last-selection (openapi.yaml:
  // 295-313) — "Last-used conversation selection for this agent"; "empty
  // items = first-time testing" (:311). feature-spec.md:87: "the previous
  // conversation set is remembered per agent … Repeat testing = Test in Runs
  // → Queue, two taps."
  lastSelection: (tree: string, agentId: string) =>
    request<Selection>(`/agenttrees/${tree}/agents/${agentId}/last-selection`),

  // PUT — "Remember the conversation selection for this agent"
  // (openapi.yaml:315-332); 200 → the stored Selection.
  putLastSelection: (tree: string, agentId: string, body: Selection) =>
    request<Selection>(`/agenttrees/${tree}/agents/${agentId}/last-selection`, {
      method: "PUT",
      body,
    }),

  // GET /agenttrees/{tree}/conversations (openapi.yaml:335)
  conversations: (tree: string, params: ConversationListParams = {}) =>
    request<ConversationPage>(`/agenttrees/${tree}/conversations`, {
      query: params as Query,
    }),

  // GET /agenttrees/{tree}/conversations/{conversationId} (openapi.yaml:387)
  conversation: (tree: string, id: string) =>
    request<Conversation>(`/agenttrees/${tree}/conversations/${id}`),

  // PATCH — rename (openapi.yaml:409; feature-spec.md:6)
  renameConversation: (tree: string, id: string, title: string) =>
    request<Conversation>(`/agenttrees/${tree}/conversations/${id}`, {
      method: "PATCH",
      body: { title },
    }),

  // DELETE — soft delete (openapi.yaml:434; feature-spec.md:6)
  deleteConversation: (tree: string, id: string) =>
    request<void>(`/agenttrees/${tree}/conversations/${id}`, {
      method: "DELETE",
    }),

  // POST /agenttrees/{tree}/chat (openapi.yaml:452-521) — SSE stream or single
  // JSON, flag in body. "Omitting conversation_id starts a new conversation"
  // (openapi.yaml:488).
  chat: async (
    tree: string,
    req: ChatRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<ChatSendResult> => {
    const res = await fetch(buildUrl(`/agenttrees/${tree}/chat`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: opts.signal,
    });
    if (!res.ok) throw await errorFromResponse(res);
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      return { kind: "json", response: (await res.json()) as ChatResponse };
    }
    if (!res.body) {
      throw new ApiError(res.status, "empty_stream", "SSE response had no body");
    }
    return { kind: "stream", events: chatEvents(res.body) };
  },

  // POST /upload — "multipart upload to /upload before send" (openapi.yaml:
  // 528-530); 201 → Attachment, "reference its id in ChatRequest.attachments"
  // (openapi.yaml:550). Oversize → 413 Error and "the UI surfaces the message"
  // (openapi.yaml:535-536). No Content-Type header: the browser sets the
  // multipart boundary itself.
  upload: async (file: File): Promise<Attachment> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(buildUrl("/upload"), { method: "POST", body: form });
    if (!res.ok) throw await errorFromResponse(res);
    return (await res.json()) as Attachment;
  },

  // GET /tasks (openapi.yaml:747-775) — "List tasks (polling fallback +
  // sidebar badge)"; response is "Tasks, newest first. Parents only (unless
  // parent_id given); expand via GET /tasks/{id}" (:769-771).
  tasks: (params: TaskListParams = {}) =>
    request<Task[]>("/tasks", { query: params as Query }),

  // GET /tasks/{taskId} (openapi.yaml:815-830) — "Task with children
  // populated" (:826); the queue panel's expand fetch.
  task: (taskId: string) => request<Task>(`/tasks/${taskId}`),

  // DELETE /tasks/{taskId} — "Cancel a task ... Doubles as chat
  // stop-generation: 'stop = DELETE /tasks/{task_id}'" (openapi.yaml:832-839).
  cancelTask: (taskId: string) =>
    request<Task>(`/tasks/${taskId}`, { method: "DELETE" }),

  // POST /tasks/{taskId}/retry-failed (openapi.yaml:849-865) — "Retry only
  // the failed children of a batch"; 202 = "Failed children re-enqueued;
  // parent task returned" (:858-861).
  retryFailedTask: (taskId: string) =>
    request<Task>(`/tasks/${taskId}/retry-failed`, { method: "POST" }),

  // POST /feedback — "👍/👎 on an assistant message ... writes a type: human
  // judgment — single store with /eval/judgments" (openapi.yaml:556-583).
  // Returns "The appended human judgment" (openapi.yaml:579).
  postFeedback: (body: FeedbackRequest) =>
    request<Judgment>("/feedback", { method: "POST", body }),

  // POST /agenttrees/{tree}/replay (openapi.yaml:586-621) → 202 ReplayAccepted.
  // context_policy is hard-set here, not a parameter (the Omit strips it from
  // the signature): Phase 1 "replays always run under each turn's original
  // envelope" (feature-spec.md:77, :82; openapi.yaml:1540-1546 enum [frozen]).
  // The client pins the invariant so no caller can override it; Phase 2 widens
  // the enum and reopens the field.
  replay: (tree: string, req: Omit<ReplayRequest, "context_policy">) =>
    request<ReplayAccepted>(`/agenttrees/${tree}/replay`, {
      method: "POST",
      body: { ...req, context_policy: "frozen" } satisfies ReplayRequest,
    }),

  // POST /agenttrees/{tree}/replay/turn (openapi.yaml:623-652) → 202
  // ReplayTurnAccepted, "one task_id + new conversation_id per endpoint"
  // (feature-spec.md:71). Same frozen pin as replay() (openapi.yaml:1570-1574).
  replayTurn: (tree: string, req: Omit<ReplayTurnRequest, "context_policy">) =>
    request<ReplayTurnAccepted>(`/agenttrees/${tree}/replay/turn`, {
      method: "POST",
      body: { ...req, context_policy: "frozen" } satisfies ReplayTurnRequest,
    }),

  // GET /agenttrees/{tree}/runs (openapi.yaml:654-669) — "Runs, newest first
  // (cells omitted; fetch a run for the grid)" (:663).
  runs: (tree: string) => request<RunSummaryItem[]>(`/agenttrees/${tree}/runs`),

  // GET /agenttrees/{tree}/runs/{runId} (openapi.yaml:671-693) — "Full run
  // with columns and per-turn cells" (:689); "Cells fill incrementally as
  // child tasks finish; live fill arrives via GET /tasks/stream" (:679-680).
  run: (tree: string, runId: string) =>
    request<Run>(`/agenttrees/${tree}/runs/${runId}`),

  // GET /tasks/stream (openapi.yaml:777-813) — SSE read off a fetch body via
  // the shared parser (sse.ts works for GET too); abort the signal to
  // unsubscribe. Yields task/progress frames (see TaskStreamEvent). `onOpen`
  // fires once the response headers confirm the stream is up — QueueProvider
  // (P1-T08) uses it to detect reconnection (an idle stream sends no frames,
  // so frame arrival alone can't signal recovery).
  taskStream: async function* (
    opts: { signal?: AbortSignal; onOpen?: () => void } = {},
  ): AsyncGenerator<TaskStreamEvent, void> {
    const res = await fetch(buildUrl("/tasks/stream"), { signal: opts.signal });
    if (!res.ok) throw await errorFromResponse(res);
    if (!res.body) {
      throw new ApiError(res.status, "empty_stream", "SSE response had no body");
    }
    opts.onOpen?.();
    for await (const msg of parseSseStream(res.body)) {
      if (msg.event === "task") {
        yield { event: "task", data: JSON.parse(msg.data) as Task };
      } else if (msg.event === "progress") {
        yield { event: "progress", data: JSON.parse(msg.data) as TaskProgressEvent };
      } else if (msg.event === "span") {
        yield { event: "span", data: JSON.parse(msg.data) as SpanEvent };
      } else if (msg.event === "judgment") {
        yield { event: "judgment", data: JSON.parse(msg.data) as JudgmentEvent };
      }
    }
  },

  // GET /agenttrees/{tree}/turns/{turnId}/trace (openapi.yaml:696-721) —
  // "Span tree for a turn … The trace (totals + flat span list with parent
  // links)" (:700, :717); header totals + envelope (openapi.yaml:705-708).
  trace: (tree: string, turnId: string) =>
    request<Trace>(`/agenttrees/${tree}/turns/${turnId}/trace`),

  // GET /spans/{spanId}/payload (openapi.yaml:723-744) — "Lazy-loaded span
  // payload … Full prompt/response for LLM spans, args/result for tool spans
  // (feature-spec.md:149)". spanId = Span.payload_ref (openapi.yaml:1690).
  spanPayload: (spanId: string) =>
    request<SpanPayload>(`/spans/${spanId}/payload`),

  // GET /eval/rubrics (openapi.yaml:868-886) — "Rubrics (for the Run Config
  // judge section) … Latest version of each rubric" (:872, :881). Rubric
  // EDITOR UI is Phase 2 (:874-875).
  rubrics: () => request<Rubric[]>("/eval/rubrics"),

  // GET /eval/cases/{caseId} (openapi.yaml:907-929) — "One eval case (judgment
  // drawer) … Phase 1 cases are auto-created from conversation turns during
  // judging (feature-spec.md:61)".
  evalCase: (caseId: string) => request<EvalCase>(`/eval/cases/${caseId}`),

  // POST /eval/judge (openapi.yaml:931-954) — "Enqueue LLM judging …
  // {set_id | case_ids | run_id, judge_model, rubric_id} → enqueued),
  // judgments append-only"; 202 → TaskRef "(parent task + child per case)".
  judge: (body: JudgeRequest) =>
    request<TaskRef>("/eval/judge", { method: "POST", body }),

  // GET /eval/runs/{runId}/summary (openapi.yaml:1001-1022) — "Aggregate
  // scores for a run … Feeds the grid's 'summary header (mean, distribution
  // sparkline)' (feature-spec.md:49), updating live as judging tasks finish
  // (feature-spec.md:64)".
  runSummary: (runId: string) =>
    request<RunScoreSummary>(`/eval/runs/${runId}/summary`),

  // GET /eval/judgments — "Judgment history (append-only) ... filter by
  // turn_id or conversation_id to re-render 👍/👎 ... on reload. ...
  // Matching judgments, newest first" (openapi.yaml:956-994).
  judgments: (params: JudgmentListParams = {}) =>
    request<Judgment[]>("/eval/judgments", { query: params as Query }),
};
