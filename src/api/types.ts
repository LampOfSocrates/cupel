// Hand-derived from openapi.yaml v0.2.0 (schema line refs in comments).

// openapi.yaml:1993 Me — v0.3.0 adds optional roles (:2004-2012 "additive in
// v0.3.0, not required — Phase-1 backends omit it"; admin gates Settings →
// Members, inspect gates the Inspector).
export interface Me {
  user: { id: string; name: string; email?: string };
  roles?: Array<"admin" | "inspect">;
  permissions: Record<string, Array<"view" | "tune" | "evaluate">>;
}

// openapi.yaml:2013-2022 Me.permissions value type — also the PermissionMatrix
// value ("the same shape as Me.permissions so the admin UI and /me agree
// exactly", openapi.yaml:3048-3049).
export type TreePermission = "view" | "tune" | "evaluate";

// openapi.yaml:3009 AdminUser — "Row in Settings → Members (feature-spec.md:19
// 'user list')"; roles only — "per-tree rights live in the permission matrix"
// (:3019).
export interface AdminUser {
  id: string;
  name: string;
  email: string;
  roles: Array<"admin" | "inspect">;
  invited?: boolean;
  created_at?: string;
}

// openapi.yaml:3027 AdminUserUpsert — "Upsert keyed by email: a new email
// creates an invited user ...; an existing email updates name/roles. Null
// name/roles = leave unchanged" (:3030-3033).
export interface AdminUserUpsert {
  email: string;
  name?: string | null;
  roles?: Array<"admin" | "inspect"> | null;
}

// openapi.yaml:3042 PermissionMatrix — "Per-tree matrix for one user ... keyed
// by tree id ... Trees absent from the map grant nothing" (:3045-3049).
export interface PermissionMatrix {
  user_id: string;
  permissions: Record<string, TreePermission[]>;
}

// openapi.yaml:2976 AuthTokenRequest — "email + password" (feature-spec.md:18).
export interface AuthTokenRequest {
  email: string;
  password: string;
}

// openapi.yaml:2987 AuthTokenResponse — "Real-shaped JWT ... plus the
// authenticated user so the login screen can hydrate immediately — the app
// still calls GET /me on every boot regardless" (:2990-2994).
export interface AuthTokenResponse {
  access_token: string;
  token_type: "bearer";
  expires_in?: number | null;
  me: Me;
}

// openapi.yaml:1110 AgentTree
export interface AgentTree {
  id: string;
  name: string;
  enabled: boolean;
}

// openapi.yaml:1091 Health — GET /healthz (backend switcher,
// feature-spec.md:159 "shows status, latency, server version, and (for mock)
// the loaded seed"; latency is CLIENT-measured, openapi.yaml:88 — not a field).
export interface Health {
  status: "ok";
  version: string;
  seed?: string | null; // "Loaded seed dataset — mock only" (openapi.yaml:1100)
  // P2-PERSIST Health.storage — optional and additive; a conformant backend
  // may omit it entirely, so every read must tolerate undefined.
  storage?: {
    mode: "local" | "s3";
    restored?: boolean; // s3 only: did this boot restore from the replica?
  };
}

// openapi.yaml:1102 Model — GET /models feeds the chat model dropdown
// (feature-spec.md:122 "GET /models (chat/run/judge model dropdowns)").
export interface Model {
  id: string;
  name: string;
}

// openapi.yaml:1262 ContextEnvelope
export interface ContextEnvelope {
  system_date: string;
  timezone: string;
  region: string;
  locale: string;
  user_profile_ref?: string | null;
}

// openapi.yaml:1276 Attachment
export interface Attachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  url?: string | null;
}

// openapi.yaml:1286 Turn
export interface Turn {
  id: string;
  role: "user" | "assistant";
  author: string;
  content: string;
  content_type?: "text" | "json";
  created_at: string;
  attachments?: Attachment[];
  envelope: ContextEnvelope | null;
}

// openapi.yaml:1327 Lineage
export interface Lineage {
  parent_conversation_id: string;
  fork_turn_id: string;
  endpoint_id?: string | null;
  config?: { instruction_version?: number | null; model?: string | null } | null;
}

// openapi.yaml:1341 Conversation
export interface Conversation {
  id: string;
  tree_id: string;
  title: string;
  origin: "interactive" | "machine";
  channel?: string | null;
  agent_id?: string | null;
  created_at: string;
  last_activity_at: string;
  lineage?: Lineage | null;
  fork_count: number;
  turns?: Turn[];
}

// openapi.yaml:1379 ConversationPage
export interface ConversationPage {
  items: Conversation[];
  page: number;
  page_size: number;
  total: number;
}

// openapi.yaml:350-378 listConversations query params
export interface ConversationListParams {
  search?: string;
  page?: number;
  page_size?: number;
  forks_of?: string;
  agent_id?: string;
  origin?: "interactive" | "machine";
}

// openapi.yaml:1061 Error — {code, message}; also the SSE `error` event payload
// (openapi.yaml:476 "event: error — data: Error").
export interface ErrorBody {
  code: string;
  message: string;
}

// openapi.yaml:1391 ChatRequest — ":1398 Omit [conversation_id] to start a new
// conversation"; ":1431-1436 stream: true = SSE token stream (UI default);
// false = single JSON response (skein-phases.md:43)".
export interface ChatRequest {
  conversation_id?: string | null;
  message: string;
  client_message_id?: string | null;
  origin?: "interactive" | "machine";
  channel?: string | null;
  author?: string | null;
  attachments?: string[];
  model?: string | null;
  temperature?: number | null;
  system_prompt?: string | null;
  stream?: boolean;
}

// openapi.yaml:1438 ChatResponse — "stream=false response — the completed
// assistant turn."
export interface ChatResponse {
  task_id: string;
  conversation_id: string;
  turn: Turn;
}

// openapi.yaml:1447 ChatTaskEvent — "First SSE event; task_id enables
// stop = DELETE /tasks/{task_id} (feature-spec.md:123)."
export interface ChatTaskEvent {
  task_id: string;
  conversation_id: string;
  user_turn_id: string;
  assistant_turn_id: string;
}

// openapi.yaml:1457 TokenEvent
export interface TokenEvent {
  delta: string;
}

// openapi.yaml:1463 ChatDoneEvent — "Terminal chat SSE event — always sent,
// even on stop-generation"; ":1470 On cancelled, [turn] carries the partial
// content generated so far (persisted)."
export interface ChatDoneEvent {
  turn: Turn;
  status: "completed" | "cancelled";
}

// openapi.yaml:1475 FeedbackRequest — "message_id = Turn.id (spec wording per
// feature-spec.md:276)".
export interface FeedbackRequest {
  message_id: string;
  rating: "up" | "down";
}

// openapi.yaml:1881 Judgment — "Append-only, never overwritten"; "type human =
// thumbs via POST /feedback ... keyed by turn_id/conversation_id instead — a
// thumb has no rubric or case"; ":1905 For type human, 1 = 👍 and 0 = 👎."
export interface Judgment {
  id: string;
  case_id?: string | null;
  run_id?: string | null;
  turn_id?: string | null;
  conversation_id?: string | null;
  type: "llm" | "human";
  judge_model?: string | null;
  rubric_id?: string | null;
  rubric_version?: number | null;
  score: number;
  reasoning?: string | null;
  created_at: string;
}

// openapi.yaml:970-991 listJudgments query params.
export interface JudgmentListParams {
  case_id?: string;
  run_id?: string;
  rubric_id?: string;
  turn_id?: string;
  conversation_id?: string;
  page?: number;
  page_size?: number;
}

// openapi.yaml:1250 SelectionItem — ":1258 Absent/null = whole conversation;
// present = just these turns (feature-spec.md:44)".
export interface SelectionItem {
  conversation_id: string;
  turn_ids?: string[] | null;
}

// openapi.yaml:1241 Selection — ":1244 Conversation/turn selection remembered
// per agent (feature-spec.md:87)"; GET answer ":311 empty items = first-time
// testing" (openapi.yaml:295-332 GET/PUT .../last-selection).
export interface Selection {
  items: SelectionItem[];
}

// openapi.yaml:1130 Endpoint — "an agent deployment/backend target"
// (feature-spec.md:67).
export interface Endpoint {
  id: string;
  name: string;
  description?: string | null;
}

// openapi.yaml:1141 Agent — tree-view node data; Phase 1 treats both formats
// as plain text (openapi.yaml:1163-1164).
export interface Agent {
  id: string;
  name: string;
  parent_id: string | null;
  live_version: number;
  tools: string[];
  enabled: boolean;
  format: "text" | "yaml";
}

// openapi.yaml:1166 AgentCreate — ":1169 Add an agent under a node
// (feature-spec.md:26); null parent_id = new root"; format default text (:1179).
export interface AgentCreate {
  name: string;
  parent_id?: string | null;
  tools?: string[];
  format?: "text" | "yaml";
}

// openapi.yaml:1181 InstructionVersion — ":1189-1192 promoted_from_snapshot_id
// set when this version was a promoted draft snapshot (feature-spec.md:86)".
export interface InstructionVersion {
  version: number;
  content: string;
  format: "text" | "yaml";
  created_at: string;
  promoted_from_snapshot_id?: string | null;
}

// openapi.yaml:1194 InstructionHistory — ":1201-1203 versions: All versions,
// ascending — append-only (feature-spec.md:33)".
export interface InstructionHistory {
  agent_id: string;
  format: "text" | "yaml";
  live_version: number;
  versions: InstructionVersion[];
}

// openapi.yaml:1206 InstructionSave — ":1212-1217 snapshot_id: Promote this
// draft snapshot to the new version; runs referencing it relabel
// (feature-spec.md:86, :89)".
export interface InstructionSave {
  content: string;
  format?: "text" | "yaml";
  snapshot_id?: string | null;
}

// openapi.yaml:1219 SnapshotCreate — ":1223 content: The draft text, frozen
// verbatim; :1224-1227 base_version: Version the draft was edited from —
// feeds the 'v15-draft (a3f2)' label".
export interface SnapshotCreate {
  content: string;
  base_version?: number | null;
}

// openapi.yaml:1229 Snapshot — ":1235-1238 label example 'v15-draft (a3f2)',
// display label until promoted (feature-spec.md:86)".
export interface Snapshot {
  snapshot_id: string;
  agent_id: string;
  label: string;
  created_at: string;
}

// openapi.yaml:1807 Rubric — versioned, save = new version (feature-spec.md:132).
export interface Rubric {
  id: string;
  name: string;
  version: number;
  prompt: string;
  created_at: string;
}

// openapi.yaml:1508 JudgeConfig — "Judge section, collapsed by default
// (feature-spec.md:48)".
export interface JudgeConfig {
  judge_model: string;
  rubric_id: string;
}

// openapi.yaml:1825 EvalCase — ":1829-1831 'EvalCase = {input, output,
// reference?}' — input 'prompt + context (frozen)', reference nullable
// (reference-free rubrics allowed)"; source ":1848-1850 set when auto-created
// from a conversation turn".
export interface EvalCaseInput {
  prompt: string;
  envelope?: ContextEnvelope | null;
}

export interface EvalCaseSource {
  tree: string;
  conversation_id: string;
  turn_id: string;
}

export interface EvalCase {
  id: string;
  input: EvalCaseInput;
  output: string;
  reference?: string | null;
  source?: Partial<EvalCaseSource> | null;
  /** openapi.yaml:2903-2909 — "Additive in v0.3.0 (not required — Phase-1
   * backends omit it, read as 1): versions append on PUT /eval/cases/{id}". */
  version?: number;
  created_at?: string;
}

// openapi.yaml:3319 EvalCaseCreate — ":3328-3330 oneOf: handcrafted =
// input + output typed in the editor; sourced = the server derives input …
// and output … from the referenced turn".
export type EvalCaseCreate =
  | { input: EvalCaseInput; output: string; reference?: string | null }
  | { source: EvalCaseSource; reference?: string | null };

// openapi.yaml:3354 EvalCaseUpdate — "Full content for the NEW version
// (append-only … ) — prior versions and the judgments recorded against them
// are untouched".
export interface EvalCaseUpdate {
  input: EvalCaseInput;
  output: string;
  reference?: string | null;
}

// openapi.yaml:3373 EvalCaseImportReport — ":3376-3379 "Per-row error report
// … valid rows import even when others fail"". The identical shape arrives
// inline (200) or as Task.result.import_report (202) — openapi.yaml:1386-1389.
export interface EvalImportRowError {
  /** ":3396 1-based data-row number in the uploaded file." */
  row: number;
  column?: string | null;
  message: string;
}

export interface EvalCaseImportReport {
  set_id?: string | null;
  rows_total: number;
  rows_imported: number;
  created_case_ids: string[];
  errors: EvalImportRowError[];
}

// openapi.yaml:3400 EvalSet — ":3403-3408 "named collection of cases
// (versioned, reusable across runs/models)". Membership is versioned …: each
// PUT appends a new version with its own full case_ids".
export interface EvalSet {
  id: string;
  name: string;
  version: number;
  case_ids: string[];
  created_at: string;
}

export interface EvalSetCreate {
  name: string;
  /** ":3427 Initial membership; empty/omitted = start empty." */
  case_ids?: string[];
}

// openapi.yaml:3431 EvalSetUpdate — "The full membership for the NEW version";
// ":3441 Optional name carries a rename into the new version".
export interface EvalSetUpdate {
  case_ids: string[];
  name?: string | null;
}

// openapi.yaml:2867 RubricCreate — ":2870 Existing name appends the next
// version"; :3444 RubricUpdate — "The prompt text for the NEW rubric version".
export interface RubricCreate {
  name: string;
  prompt: string;
}

export interface RubricUpdate {
  prompt: string;
}

// openapi.yaml:1857 JudgeRequest — ":1861-1864 Exactly one of run_id /
// case_ids … run_id = 'Score this run', auto-creating cases from turns if
// none exist (feature-spec.md:61)"; rubric_version ":1876-1879 Pin a specific
// rubric version; omit for latest".
export interface JudgeRequest {
  run_id?: string | null;
  case_ids?: string[] | null;
  /** openapi.yaml:2934-2936 — "Judge every case in this eval set"; the oneOf
   * became run_id | case_ids | set_id in v0.3.0 (:2926-2929). */
  set_id?: string | null;
  /** ":2939-2941 Pin a set membership version; omit for latest." */
  set_version?: number | null;
  judge_model: string;
  rubric_id: string;
  rubric_version?: number | null;
}

// openapi.yaml:1775 TaskRef — 202 body of POST /eval/judge (:949-953).
export interface TaskRef {
  task_id: string;
}

// openapi.yaml:1796 JudgmentEvent — "A judgment appended by a finished judging
// task — 'scores stream into the grid live' (feature-spec.md:64). Join keys
// (case_id/run_id/turn_id) are on the judgment itself."
export interface JudgmentEvent {
  judgment: Judgment;
}

// openapi.yaml:1909 RunScoreSummary — "Feeds 'summary header (mean,
// distribution sparkline)' (feature-spec.md:49)"; distribution ":1925-1928
// Bucketed score counts for the sparkline".
export interface RubricScoreSummary {
  rubric_id: string;
  rubric_version: number;
  mean: number;
  count: number;
  distribution: number[];
}

export interface RunScoreSummary {
  run_id: string;
  rubrics: RubricScoreSummary[];
}

// openapi.yaml:1483 RunConfig — ":1488-1489 instruction_version XOR
// snapshot_id — a snapshot is an untested draft (feature-spec.md:86);
// neither = the live version. endpoint_ids only applies to turn re-fire."
export interface RunConfig {
  agent_id?: string | null;
  instruction_version?: number | null;
  snapshot_id?: string | null;
  model?: string | null;
  temperature?: number | null;
  endpoint_ids?: string[] | null;
  judge?: JudgeConfig | null;
}

// openapi.yaml:1516 ReplayRequest — ":1540-1546 context_policy: enum [frozen],
// default frozen — 'Phase 1 pin — replays always run under each turn's
// original envelope (feature-spec.md:77, :82)'. The client hard-sets it
// (client.ts api.replay) — callers never pass it.
export interface ReplayRequest {
  selection: SelectionItem[];
  configs: RunConfig[];
  baseline_run_id?: string | null;
  context_policy?: "frozen";
}

// openapi.yaml:1548 ReplayAccepted — "Every request returns task_id
// (feature-spec.md:106)"; run_id feeds GET …/runs/{id} for the grid.
export interface ReplayAccepted {
  task_id: string;
  run_id: string;
}

// openapi.yaml:1556 ReplayTurnRequest — ":1565 feature-spec.md:71 'body
// includes endpoints[]'"; context_policy pinned as on ReplayRequest (:1570-1574).
export interface ReplayTurnRequest {
  conversation_id: string;
  turn_id: string;
  endpoints: string[];
  config?: RunConfig | null;
  context_policy?: "frozen";
}

// openapi.yaml:1576 ReplayTurnAccepted — "returns one task_id + new
// conversation_id per endpoint" (feature-spec.md:71); run_id backs the
// fork-comparison pivot (:1581-1585).
export interface ReplayTurnAccepted {
  run_id: string;
  results: Array<{ endpoint_id: string; task_id: string; conversation_id: string }>;
}

// openapi.yaml:1596 RunSummaryItem — GET /agenttrees/{tree}/runs listing.
export interface RunSummaryItem {
  id: string;
  tree_id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  created_at: string;
  task_id: string;
  label?: string | null;
}

// openapi.yaml:1645 RunCell — ":1642 One per column, same order; fills
// incrementally (feature-spec.md:112)".
export interface RunCell {
  status: "pending" | "running" | "done" | "failed";
  content?: string | null;
  conversation_id?: string | null;
  turn_id?: string | null;
  task_id?: string | null;
  case_id?: string | null;
  latest_score?: number | null;
  error?: string | null;
}

// openapi.yaml:1607 Run — comparison-grid data: "baseline column + one column
// per run config, row per turn" (feature-spec.md:49); ":1621 Index 0 =
// baseline. Column labels relabel when a snapshot promotes."
export interface RunColumn {
  label: string;
  config: RunConfig;
}

export interface RunRow {
  source: { conversation_id: string; turn_id: string };
  cells: RunCell[];
}

export interface Run {
  id: string;
  tree_id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  created_at: string;
  task_id: string;
  columns: RunColumn[];
  rows: RunRow[];
}

// openapi.yaml:1668 Span — "Span = {id, parent_id, type: agent|llm|tool, name,
// start, end, tokens_in?, tokens_out?, cost?, model?, status, payload_ref}"
// (feature-spec.md:144); error ":1686-1689 Error message when status is error
// — 'Errors mark the span red'"; payload_ref ":1690 Id for GET
// /spans/{id}/payload".
export interface Span {
  id: string;
  parent_id: string | null;
  type: "agent" | "llm" | "tool";
  name: string;
  start: string;
  end: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost?: number | null;
  model?: string | null;
  status: "ok" | "error" | "running";
  error?: string | null;
  payload_ref: string;
}

// openapi.yaml:1692 Trace — envelope ":1700 Shown in the trace header
// (feature-spec.md:76)"; totals ":1703 Turn totals — wall time, total tokens
// in/out, cost (feature-spec.md:147)".
export interface Trace {
  turn_id: string;
  envelope: ContextEnvelope | null;
  totals: {
    wall_time_ms: number;
    tokens_in: number;
    tokens_out: number;
    cost: number;
  };
  spans: Span[];
}

// openapi.yaml:1714 SpanPayload — "LLM spans carry prompt/response; tool spans
// carry args/result (feature-spec.md:149)"; lazy-loaded (openapi.yaml:729-730).
export interface SpanPayload {
  span_id: string;
  prompt?: string | null;
  response?: string | null;
  args?: unknown;
  result?: unknown;
}

// openapi.yaml:1788 SpanEvent — "Live trace span on the tasks channel
// (feature-spec.md:150)"; `span` frame on GET /tasks/stream (openapi.yaml:793).
export interface SpanEvent {
  turn_id: string;
  span: Span;
}

// openapi.yaml:1763 TaskProgress
export interface TaskProgress {
  done: number;
  total: number;
  stage?: string;
}

// openapi.yaml:1781 TaskProgressEvent — `progress` frame on GET /tasks/stream
// (openapi.yaml:791-792: "per-unit ticks, e.g. 'Conversation 3/10 · turn 2/6'").
export interface TaskProgressEvent {
  task_id: string;
  progress: TaskProgress;
}

// openapi.yaml:747-767 GET /tasks query params — status / parent_id
// ("Children of this task; omit for the default top-level listing") / limit.
export interface TaskListParams {
  status?: Task["status"];
  parent_id?: string;
  limit?: number;
}

// openapi.yaml:1726 Task — returned by DELETE /tasks/{taskId}
// (openapi.yaml:832-847 "Cancel a task ... also stop-generation").
export interface Task {
  id: string;
  // openapi.yaml:2770-2782 — compact and import are additive in v0.3.0;
  // "import = a large POST /eval/cases/import processed in the background".
  type: "chat" | "replay" | "replay_turn" | "judge" | "compact" | "import";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: TaskProgress;
  parent_id?: string | null;
  result?: {
    run_id?: string | null;
    conversation_id?: string | null;
    turn_id?: string | null;
    /** openapi.yaml:2795-2802 — "the same per-row report a small synchronous
     * POST /eval/cases/import returns inline". */
    import_report?: EvalCaseImportReport | null;
  } | null;
  error?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  children?: Task[] | null;
}
