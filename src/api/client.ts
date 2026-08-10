// Single typed client — all API calls go through here; no hardcoded hosts
// anywhere else (feature-spec.md:154). URLs are built from the ACTIVE backend
// target (agentic.config.ts via src/api/target.ts).
import { getActiveTarget } from "./target";
import { authHeaders, clearAuthToken, emitAuthRequired } from "./auth";
import { llmHeaders } from "./llmKey";
import { parseSseStream } from "./sse";
import { product } from "../lib/product";
import type {
  AdminConversationListParams,
  AdminConversationPage,
  AdminUser,
  AdminUserPage,
  AdminUserUpsert,
  Agent,
  AgentCreate,
  AgentTree,
  Attachment,
  AuthTokenResponse,
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
  EvalCaseCreate,
  EvalCaseImportReport,
  EvalCaseUpdate,
  EvalSet,
  EvalSetCreate,
  EvalSetFreezeRequest,
  EvalSetItemCreate,
  EvalSetMetadataUpdate,
  EvalSetPage,
  EvalSetReplayAccepted,
  EvalSetReplayRequest,
  EvalSetUpdate,
  FeedbackRequest,
  Health,
  InstructionHistory,
  InstructionSave,
  InstructionVersion,
  JudgeRequest,
  Judgment,
  JudgmentEvent,
  JudgmentListParams,
  JudgmentPage,
  Me,
  Model,
  PageParams,
  PermissionMatrix,
  ReplayAccepted,
  ReplayRequest,
  ReplayTurnAccepted,
  ReplayTurnRequest,
  Rubric,
  RubricCreate,
  RubricPage,
  RubricUpdate,
  Evaluation,
  EvaluationScoreSummary,
  EvaluationSummaryPage,
  Selection,
  Snapshot,
  SnapshotCreate,
  SpanEvent,
  SpanPayload,
  Task,
  TaskListParams,
  TaskPage,
  TaskProgressEvent,
  TaskRef,
  TokenEvent,
  Trace,
  TurnListParams,
  TurnPage,
  TreePermission,
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
  // remap first (cupel-phases.md:75 — differently-named routes), then prefix
  // the target's baseUrl. The prod target's baseUrl is "" (same-origin) —
  // relative URLs need the page origin as base; absolute baseUrl values
  // ignore the second argument.
  const { baseUrl, remap } = getActiveTarget();
  const url = new URL(baseUrl + (remap ? remap(path) : path), globalThis.location?.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

// Central 401 handling (feature-spec.md:18 "401 anywhere → back to
// login"): every 401 clears the active target's login token and emits
// auth-required — the router-level listener (App.tsx) navigates to
// /login?return_to=<current path>. The one exception is POST /auth/token
// itself: bad credentials are the login form's own error, not a session
// expiry. No auth-mode branch — an off-mode backend simply never 401s.
async function errorFromResponse(res: Response, path: string): Promise<ApiError> {
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
  if (res.status === 401 && path !== "/auth/token") {
    clearAuthToken();
    emitAuthRequired();
  }
  // Central 409 surface (extends the central-401 pattern minimally):
  // tree_disabled means "new work blocked, history kept read-only"
  // (openapi.yaml:1974-1979) — one friendly message here, so every caller's
  // existing error rendering (chat sendError, Evaluations error alert, …) shows it
  // without per-page mapping. Callers can still branch on ApiError.code.
  if (code === "tree_disabled") {
    message = `This ${product.tree.one} is disabled — history is read-only.`;
  }
  return new ApiError(res.status, code, message);
}

// BYOK headers attach CENTRALLY here, and only on the calls whose
// generation can go live — chat/replay/judge/models (docs/deployment.md:
// 18-20, :26 "Sent per request: X-LLM-Key + X-LLM-Model headers"). The key
// never appears in URLs and is never logged.
const LIVE_PATHS = /(\/chat|\/replay|\/replay\/turn)$|^\/eval\/judge$|^\/models$/;

function liveHeaders(path: string): Record<string, string> {
  return LIVE_PATHS.test(path) ? llmHeaders() : {};
}

async function request<T>(
  path: string,
  opts: { method?: string; query?: Query; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? "GET",
    // authHeaders(): login JWT for the active target, else the static prod
    // token for requiresToken targets — precedence documented in auth.ts.
    // Attached centrally; no caller passes tokens.
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
      ...liveHeaders(path),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw await errorFromResponse(res, path);
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
// span — data: SpanEvent · judgment — data: JudgmentEvent"). judgment frames:
// "scores stream into the grid live as judging tasks finish
// (SSE)" (feature-spec.md:64); span frames: "spans appear live
// while the turn is generating (same SSE channel as tasks)"
// (feature-spec.md:146), consumed by the trace view's scoped subscription.
export type TaskStreamEvent =
  | { event: "task"; data: Task }
  | { event: "progress"; data: TaskProgressEvent }
  | { event: "span"; data: SpanEvent }
  | { event: "judgment"; data: JudgmentEvent };

// One send call covers both modes (cupel-phases.md:43: "stream: true (SSE token
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
  // POST /auth/token (openapi.yaml:96-128) — "login screen (email + password
  // ...) → POST /auth/token; token attached by the single API client"
  // (feature-spec.md:18). The caller (LoginPage) stores access_token via
  // setAuthToken; a 401 here is invalid_credentials, surfaced in the form
  // (deliberately excluded from the central 401 redirect above).
  login: (email: string, password: string) =>
    request<AuthTokenResponse>("/auth/token", {
      method: "POST",
      body: { email, password },
    }),

  // POST /auth/logout (openapi.yaml:130-144) — called best-effort on sign-out
  // ("clients call it unconditionally, never branching on the mode", :140-141);
  // the client then clears its stored token regardless of the outcome.
  logout: () => request<void>("/auth/logout", { method: "POST" }),

  // GET /me — always called on boot (cupel-phases.md:160; openapi.yaml:62)
  me: () => request<Me>("/me"),

  // GET /healthz (openapi.yaml:80-96) — backend-switcher health check
  // (feature-spec.md:155). Latency is client-measured (openapi.yaml:88):
  // the Settings page wraps this call in performance.now().
  healthz: () => request<Health>("/healthz"),

  // GET /agenttrees (openapi.yaml:115)
  agentTrees: () => request<AgentTree[]>("/agenttrees"),

  // Admin — Settings → Members / Agent trees, role-gated server-side
  // (403 Forbidden without the admin role, openapi.yaml:1966-1970).
  // GET /admin/users (openapi.yaml:169-189) — "Every user, cross-user".
  adminUsers: (params: PageParams = {}) =>
    request<AdminUserPage>("/admin/users", { query: params as Query }),

  // PUT /admin/users (openapi.yaml:190-218) — "upsert keyed by email: a new
  // email creates an invited user (invite by email)".
  putAdminUsers: (body: AdminUserUpsert[]) =>
    request<AdminUser[]>("/admin/users", { method: "PUT", body }),

  // GET /admin/users/{userId}/permissions (openapi.yaml:220-240) — "the
  // per-tree view/tune/evaluate matrix behind the Settings → Members
  // checkboxes. Same shape as Me.permissions".
  userPermissions: (userId: string) =>
    request<PermissionMatrix>(`/admin/users/${userId}/permissions`),

  // PUT — "Full replacement of the matrix ... Takes effect on the user's
  // next request" (openapi.yaml:241-265) — no live push.
  putUserPermissions: (userId: string, permissions: Record<string, TreePermission[]>) =>
    request<PermissionMatrix>(`/admin/users/${userId}/permissions`, {
      method: "PUT",
      body: { permissions },
    }),

  // PATCH /admin/agenttrees/{treeId} {enabled} (openapi.yaml:267-296) —
  // "toggles availability, never data"; disabled = new work 409s while
  // history stays readable (feature-spec.md:20).
  toggleTree: (treeId: string, enabled: boolean) =>
    request<AgentTree>(`/admin/agenttrees/${treeId}`, {
      method: "PATCH",
      body: { enabled },
    }),

  // Inspector — GET /admin/conversations (openapi.yaml:298-348):
  // "Inspector — every conversation, cross-user … Requires the inspect role
  // (403 otherwise); EVERY access is audit-logged server-side". Filters are
  // the contract's own query params (:314-340); the page renders them as its
  // filter row and mirrors them into the URL.
  adminConversations: (params: AdminConversationListParams = {}) =>
    request<AdminConversationPage>("/admin/conversations", { query: params as Query }),

  // GET /models (openapi.yaml:98-112) — "chat/run/judge model dropdowns"
  // (feature-spec.md:118). Fetched once and cached in AppContext.
  models: () => request<Model[]>("/models"),

  // GET /agenttrees/{tree}/endpoints (openapi.yaml:154-172) — "Deploy targets
  // for replay … Multi-selected in Variant for turn re-fire
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
  // — "Immutable draft snapshot (for Test as evaluation)" (:272); 201 → Snapshot.
  createSnapshot: (tree: string, agentId: string, body: SnapshotCreate) =>
    request<Snapshot>(`/agenttrees/${tree}/agents/${agentId}/snapshots`, {
      method: "POST",
      body,
    }),

  // GET /agenttrees/{tree}/agents/{agentId}/last-selection (openapi.yaml:
  // 295-313) — "Last-used conversation selection for this agent"; "empty
  // items = first-time testing" (:311). feature-spec.md:87: "the previous
  // conversation set is remembered per agent … Repeat testing = Test as
  // evaluation → Queue, two taps."
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

  // GET /agenttrees/{tree}/conversations/{conversationId}/turns (listTurns) —
  // the transcript, paged and CHRONOLOGICAL. Omitting `page` asks for the LAST
  // page: a reader opens a conversation at its end, and the response's own
  // `page` says where that landed, so "load earlier" is page - 1.
  // turn_ids goes on the wire comma-separated (contract style: form,
  // explode: false).
  turns: (tree: string, id: string, params: TurnListParams = {}) => {
    const { turn_ids, ...rest } = params;
    return request<TurnPage>(`/agenttrees/${tree}/conversations/${id}/turns`, {
      query: {
        ...(rest as Query),
        ...(turn_ids?.length ? { turn_ids: turn_ids.join(",") } : {}),
      },
    });
  },

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
      // llmHeaders(): BYOK X-LLM-Key/X-LLM-Model when a key is stored
      // (docs/deployment.md:26). authHeaders(): bearer.
      headers: { "Content-Type": "application/json", ...authHeaders(), ...llmHeaders() },
      body: JSON.stringify(req),
      signal: opts.signal,
    });
    if (!res.ok) throw await errorFromResponse(res, `/agenttrees/${tree}/chat`);
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
    const res = await fetch(buildUrl("/upload"), {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    if (!res.ok) throw await errorFromResponse(res, "/upload");
    return (await res.json()) as Attachment;
  },

  // GET /tasks (openapi.yaml:747-775) — "List tasks (polling fallback +
  // sidebar badge)"; response is "Tasks, newest first. Parents only (unless
  // parent_id given); expand via GET /tasks/{id}" (:769-771).
  tasks: (params: TaskListParams = {}) =>
    request<TaskPage>("/tasks", { query: params as Query }),

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

  // POST /feedback (postFeedback) — "👍/👎 on an assistant message ... writes
  // a scorer: human judgment — single store with /eval/judgments". Returns
  // "The appended human judgment": subject {kind: turn, id: message_id},
  // scorer {kind: human} with ref/version/model null.
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

  // GET /agenttrees/{tree}/evaluations (openapi.yaml:654-669) — "Evaluations, newest first
  // (cells omitted; fetch one for the grid)" (:663).
  evaluations: (tree: string, params: PageParams = {}) =>
    request<EvaluationSummaryPage>(`/agenttrees/${tree}/evaluations`, {
      query: params as Query,
    }),

  // GET /agenttrees/{tree}/evaluations/{evaluationId} (getEvaluation) — ONE
  // PAGE of the grid ("Cells fill incrementally as child tasks finish; live
  // fill arrives via GET /tasks/stream"), and the one conditional read in this
  // client.
  //
  // Why it does not go through request(): this is the endpoint the evaluation
  // page POLLS, so the interesting answer is 304 — "nothing you have is
  // stale" — which request() cannot express (it returns a body or throws).
  // `evaluation: null` IS that answer; the caller keeps what it already
  // rendered. `cache: "no-store"` is load-bearing: with the default policy the
  // browser may service the revalidation from its own HTTP cache and hand back
  // a synthesised 200, which would make the 304 path unobservable and the
  // saving imaginary.
  evaluation: async (
    tree: string,
    evaluationId: string,
    opts: PageParams & { etag?: string | null } = {},
  ): Promise<{ evaluation: Evaluation | null; etag: string | null }> => {
    const { etag, ...page } = opts;
    const path = `/agenttrees/${tree}/evaluations/${evaluationId}`;
    const res = await fetch(buildUrl(path, page as Query), {
      cache: "no-store",
      headers: {
        ...authHeaders(),
        ...(etag ? { "If-None-Match": etag } : {}),
      },
    });
    if (res.status === 304) return { evaluation: null, etag: etag ?? null };
    if (!res.ok) throw await errorFromResponse(res, path);
    return { evaluation: (await res.json()) as Evaluation, etag: res.headers.get("ETag") };
  },

  // GET /tasks/stream (openapi.yaml:777-813) — SSE read off a fetch body via
  // the shared parser (sse.ts works for GET too); abort the signal to
  // unsubscribe. Yields task/progress frames (see TaskStreamEvent). `onOpen`
  // fires once the response headers confirm the stream is up — QueueProvider
  // uses it to detect reconnection (an idle stream sends no frames, so frame
  // arrival alone can't signal recovery).
  taskStream: async function* (
    opts: { signal?: AbortSignal; onOpen?: () => void } = {},
  ): AsyncGenerator<TaskStreamEvent, void> {
    const res = await fetch(buildUrl("/tasks/stream"), {
      headers: authHeaders(),
      signal: opts.signal,
    });
    if (!res.ok) throw await errorFromResponse(res, "/tasks/stream");
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
  // (feature-spec.md:145)". spanId = Span.payload_ref (openapi.yaml:1690).
  spanPayload: (spanId: string) =>
    request<SpanPayload>(`/spans/${spanId}/payload`),

  // GET /eval/rubrics (openapi.yaml:868-886) — "Rubrics (for the Variant
  // judge section) … Latest version of each rubric" (:872, :881). Rubric
  // EDITOR UI is Phase 2 (:874-875).
  rubrics: (params: PageParams = {}) =>
    request<RubricPage>("/eval/rubrics", { query: params as Query }),

  // POST /eval/rubrics (openapi.yaml:1293-1311) — "Create a rubric
  // (append-only; new name = v1) … Posting an existing rubric's name appends
  // the next version".
  createRubric: (body: RubricCreate) =>
    request<Rubric>("/eval/rubrics", { method: "POST", body }),

  // PUT /eval/rubrics/{rubricId} (openapi.yaml:1313-1338) — "Save a rubric as
  // a NEW version (append-only) … Appends the next version of this rubric id —
  // never overwrites"; 201 = "The new rubric version (now latest)".
  updateRubric: (rubricId: string, body: RubricUpdate) =>
    request<Rubric>(`/eval/rubrics/${rubricId}`, { method: "PUT", body }),

  // GET /eval/cases/{caseId} (openapi.yaml:907-929) — "One eval case (judgment
  // drawer) … Phase 1 cases are auto-created from conversation turns during
  // judging (feature-spec.md:61)". "Returns the LATEST version" (:1441-1442).
  evalCase: (caseId: string) => request<EvalCase>(`/eval/cases/${caseId}`),

  // POST /eval/cases (openapi.yaml:1340-1369) — "Create an eval case
  // (handcrafted or sourced from a turn) … Exactly one creation mode".
  createEvalCase: (body: EvalCaseCreate) =>
    request<EvalCase>("/eval/cases", { method: "POST", body }),

  // PUT /eval/cases/{caseId} (openapi.yaml:1455-1483) — "Save an eval case as
  // a NEW version (append-only) … Rollback = PUT the old content again (a new
  // version)"; 201 = "The new case version (now latest)".
  updateEvalCase: (caseId: string, body: EvalCaseUpdate) =>
    request<EvalCase>(`/eval/cases/${caseId}`, { method: "PUT", body }),

  // Eval sets — the noun Casebook merged into. Global, not tree-scoped: no
  // tree in any of these paths, and one set may reference turns across trees.
  // GET /eval/sets — "Latest version of every set, items included".
  evalSets: (params: PageParams = {}) =>
    request<EvalSetPage>("/eval/sets", { query: params as Query }),

  // POST /eval/sets — "Create an eval set (version 1)"; membership changes
  // afterwards append versions through PUT, …/items or …/freeze.
  createEvalSet: (body: EvalSetCreate) =>
    request<EvalSet>("/eval/sets", { method: "POST", body }),

  // GET /eval/sets/{setId} — the set with its items. Reference items are turn
  // REFERENCES: render their transcripts by following each item's source.
  evalSet: (setId: string) => request<EvalSet>(`/eval/sets/${setId}`),

  // PATCH /eval/sets/{setId} — "Metadata only, and deliberately NOT versioned:
  // a set's name and description belong to the set, its items belong to the
  // version."
  updateEvalSetMetadata: (setId: string, body: EvalSetMetadataUpdate) =>
    request<EvalSet>(`/eval/sets/${setId}`, { method: "PATCH", body }),

  // PUT /eval/sets/{setId} — "Save set membership as a NEW version
  // (append-only) … each save is a new version carrying its FULL item list".
  updateEvalSet: (setId: string, body: EvalSetUpdate) =>
    request<EvalSet>(`/eval/sets/${setId}`, { method: "PUT", body }),

  // DELETE /eval/sets/{setId} — "Deleting a set never deletes evidence": the
  // referenced turns, the frozen cases and their judgments all survive.
  deleteEvalSet: (setId: string) =>
    request<void>(`/eval/sets/${setId}`, { method: "DELETE" }),

  // POST /eval/sets/{setId}/items — the ⊞ action. Appends a membership version,
  // and is IDEMPOTENT: "adding a referent the latest version already holds
  // appends nothing and returns that version unchanged", so the UI detects
  // "already there" by an unchanged version number rather than pre-checking.
  addEvalSetItem: (setId: string, body: EvalSetItemCreate) =>
    request<EvalSet>(`/eval/sets/${setId}/items`, { method: "POST", body }),

  // POST /eval/sets/{setId}/freeze — what "turn a casebook into an eval set"
  // became: reference items flip to frozen in place, keeping their id and
  // source. Omit item_ids for every reference item.
  freezeEvalSetItems: (setId: string, body: EvalSetFreezeRequest = {}) =>
    request<EvalSet>(`/eval/sets/${setId}/freeze`, { method: "POST", body }),

  // POST /eval/sets/{setId}/replay — 202 EvalSetReplayAccepted, "one evaluation
  // per tree touched, all children of a single parent task"; frozen items are
  // skipped. context_policy is hard-set to the contract default exactly as
  // api.replay does (widening is future work).
  replayEvalSet: (setId: string, body: EvalSetReplayRequest) =>
    request<EvalSetReplayAccepted>(`/eval/sets/${setId}/replay`, {
      method: "POST",
      body: { ...body, context_policy: "frozen" as const },
    }),

  // POST /eval/cases/import (openapi.yaml:1370-1429) — multipart file +
  // mapping (+ set_id | set_name). "Small files: 200 with the per-row report
  // inline. Above the server's size threshold: 202 TaskRef" — the caller gets
  // the status alongside the body so it can follow the queued path.
  // No Content-Type header: the browser sets the multipart boundary itself
  // (same rule as upload above).
  importEvalCases: async (
    file: File,
    mapping: { input: string; output: string; reference?: string },
    target?: { set_id?: string; set_name?: string },
  ): Promise<{ status: 200; report: EvalCaseImportReport } | { status: 202; task: TaskRef }> => {
    const form = new FormData();
    form.append("file", file);
    form.append("mapping", JSON.stringify(mapping));
    if (target?.set_id) form.append("set_id", target.set_id);
    if (target?.set_name) form.append("set_name", target.set_name);
    const res = await fetch(buildUrl("/eval/cases/import"), {
      method: "POST",
      headers: authHeaders(),
      body: form,
    });
    if (!res.ok) throw await errorFromResponse(res, "/eval/cases/import");
    const body = await res.json();
    return res.status === 202
      ? { status: 202, task: body as TaskRef }
      : { status: 200, report: body as EvalCaseImportReport };
  },

  // POST /eval/judge (openapi.yaml:931-954) — "Enqueue LLM judging …
  // {set_id | case_ids | evaluation_id, judge_model, rubric_id} → enqueued),
  // judgments append-only"; 202 → TaskRef "(parent task + child per case)".
  judge: (body: JudgeRequest) =>
    request<TaskRef>("/eval/judge", { method: "POST", body }),

  // GET /eval/evaluations/{evaluationId}/summary (openapi.yaml:1001-1022) — "Aggregate
  // scores for an evaluation … Feeds the grid's 'summary header (mean, distribution
  // sparkline)' (feature-spec.md:49), updating live as judging tasks finish
  // (feature-spec.md:64)".
  evaluationSummary: (evaluationId: string) =>
    request<EvaluationScoreSummary>(`/eval/evaluations/${evaluationId}/summary`),

  // GET /eval/judgments (listJudgments) — "Judgment history (append-only) ...
  // filter by subject or by conversation_id to re-render 👍/👎 ... on reload.
  // ... Matching judgments, newest first".
  judgments: (params: JudgmentListParams = {}) =>
    request<JudgmentPage>("/eval/judgments", { query: params as Query }),
};
