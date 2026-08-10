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

// openapi.yaml AdminUserPage
export type AdminUserPage = Page<AdminUser>;

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
// feature-spec.md:155 "shows status, latency, server version, and (for mock)
// the loaded seed"; latency is CLIENT-measured, openapi.yaml:88 — not a field).
export interface Health {
  status: "ok";
  version: string;
  // Health.contract_version / Health.capabilities — which contract the backend
  // implements and how much of each FAMILY it serves. Families are the
  // contract's top-level tags (openapi.yaml `tags:`), which is also what
  // cupel-ready groups its report by. Both optional and additive: a backend
  // may omit them, so a family absent from the map is UNKNOWN, not "none".
  contract_version?: string;
  capabilities?: Record<string, Capability>;
  seed?: string | null; // "Loaded seed dataset — mock only" (openapi.yaml:1100)
  // Health.storage — optional and additive; a conformant backend
  // may omit it entirely, so every read must tolerate undefined.
  storage?: {
    mode: "local" | "s3";
    restored?: boolean; // s3 only: did this boot restore from the replica?
  };
}

// openapi.yaml Capability — one family's coverage in a backend. `status` is
// the promise; the counts and `missing` only make it auditable.
export interface Capability {
  status: "full" | "partial" | "none";
  implemented?: number;
  operations?: number;
  missing?: string[];
}

// openapi.yaml:1102 Model — GET /models feeds the chat model dropdown
// (feature-spec.md:118 "GET /models (chat/run/judge model dropdowns)").
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
  /**
   * Turns in the transcript. The transcript ITSELF is not here: it is a paged
   * collection at GET …/conversations/{id}/turns (api.turns), because a
   * conversation has no length limit and this resource had no way to ask for
   * less. The count is what lets a row label itself ("14 turns") and a caller
   * decide whether to fetch at all.
   */
  turn_count: number;
}

// THE collection shape — every operation that returns a collection of user
// data answers this envelope (contract schemas ConversationPage, TaskPage,
// JudgmentPage, …; the rule itself is openapi.yaml info.description
// "Collections"). OpenAPI 3.0 has to repeat the four keys per item type;
// TypeScript does not, so here it is written once and every named page below
// is an alias. `total` is matches across ALL pages: it is what lets a screen
// say "showing 20 of 143" instead of quietly truncating.
export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
}

/** The two query params every paged operation takes. */
export interface PageParams {
  page?: number;
  page_size?: number;
}

// openapi.yaml ConversationPage
export type ConversationPage = Page<Conversation>;

// openapi.yaml TurnPage — GET …/conversations/{id}/turns.
export type TurnPage = Page<Turn>;

// openapi.yaml listTurns query params. Two things differ from every other
// paged listing, both deliberate and both contract-level: rows are
// CHRONOLOGICAL (a transcript grows only at the tail, so page 1 never
// changes under a reader), and an omitted `page` means the LAST page — where
// a reader of a transcript starts. Walking back is page-1-ward.
export interface TurnListParams extends PageParams {
  /** Fetch named turns instead of a window; unknown ids are ignored. */
  turn_ids?: string[];
}

// openapi.yaml listConversations query params
export interface ConversationListParams extends PageParams {
  search?: string;
  forks_of?: string;
  agent_id?: string;
  origin?: "interactive" | "machine";
}

// openapi.yaml:3129 AdminConversationItem — "Inspector row = an ordinary
// conversation plus the cross-user dimension (cupel-phases.md:78 'filter by
// user, tree, date, or score')" (:3134-3137). The mock omits `turns` on these
// rows: the table is a dense index and the inline reader fetches the
// transcript for the selected row.
export interface AdminConversationItem extends Conversation {
  /** ":3139 Owning user." */
  user_id: string;
  user_email?: string | null;
  /** ":3141-3144 Latest judgment score across the conversation's turns." */
  latest_score?: number | null;
}

// openapi.yaml AdminConversationPage
export type AdminConversationPage = Page<AdminConversationItem>;

// openapi.yaml listAdminConversations query params — the Inspector's
// filter row (user, tree, date range, score range) plus pagination.
export interface AdminConversationListParams extends PageParams {
  user_id?: string;
  tree?: string;
  date_from?: string;
  date_to?: string;
  score_min?: number;
  score_max?: number;
}

// openapi.yaml:1061 Error — {code, message}; also the SSE `error` event payload
// (openapi.yaml:476 "event: error — data: Error").
export interface ErrorBody {
  code: string;
  message: string;
}

// openapi.yaml:1391 ChatRequest — ":1398 Omit [conversation_id] to start a new
// conversation"; ":1431-1436 stream: true = SSE token stream (UI default);
// false = single JSON response (cupel-phases.md:43)".
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
// stop = DELETE /tasks/{task_id} (feature-spec.md:119)."
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
// feature-spec.md:272)".
export interface FeedbackRequest {
  message_id: string;
  rating: "up" | "down";
  // Optional free-text note stored as the appended judgment's
  // `reasoning`. Additive and optional in the contract, so a bare thumb sends
  // exactly the two fields it always did — omit the key, never send null.
  comment?: string;
}

// openapi.yaml JudgmentSubject — "WHAT was judged, named by a discriminator
// instead of by whichever of several nullable id columns happened to be set".
// Only the kinds something produces today are declared; `evaluation` (pairwise
// preference) is an added enum value later, not a reshape.
export interface JudgmentSubject {
  kind: "case" | "turn";
  id: string;
}

// openapi.yaml Scorer — "WHO or WHAT produced the score". kind llm: ref =
// rubric id, version = rubric version, model = judge model. kind human: all
// three null, because "a thumb runs no rubric and no model". `check` is the
// motivating future kind and needs no reshape.
export interface Scorer {
  kind: "llm" | "human";
  ref?: string | null;
  version?: number | null;
  model?: string | null;
}

// openapi.yaml Judgment — "Append-only, never overwritten … addressed by a
// subject (what was judged) and a scorer (what produced the score)".
// evaluation_id is a SCOPE, not the subject: an LLM judgment of a grid cell
// judges the CASE, and the evaluation is the batch it was produced in.
// "For scorer kind human, 1 = 👍 and 0 = 👎."
export interface Judgment {
  id: string;
  subject: JudgmentSubject;
  scorer: Scorer;
  evaluation_id?: string | null;
  score: number;
  reasoning?: string | null;
  created_at: string;
}

// openapi.yaml JudgmentPage
export type JudgmentPage = Page<Judgment>;

// openapi.yaml listJudgments query params. Equality filters, AND-ed.
// conversation_id has no matching Judgment field — it is a scope filter the
// chat view uses to re-render a whole conversation's 👍/👎 in one request.
export interface JudgmentListParams extends PageParams {
  subject_kind?: "case" | "turn";
  subject_id?: string;
  evaluation_id?: string;
  scorer_ref?: string;
  conversation_id?: string;
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
// draft snapshot to the new version; evaluations referencing it relabel
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

// openapi.yaml:1807 Rubric — versioned, save = new version (feature-spec.md:128).
export interface Rubric {
  id: string;
  name: string;
  version: number;
  prompt: string;
  created_at: string;
}

// openapi.yaml RubricPage
export type RubricPage = Page<Rubric>;

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
  /** EvalCase.version — "Additive in v0.3.0 (not required — Phase-1 backends
   * omit it, read as 1): versions append on POST /eval/cases/{id}/versions". */
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

// openapi.yaml EvalSetItem — the merged noun's member. "kind is the whole
// difference the merge collapsed: `reference` is a REFERENCE to a live turn,
// never a copy …; `frozen` names an EvalCase". source survives a freeze, so an
// item frozen from a turn still says where it came from.
export interface EvalSetItem {
  /** "Stable across membership versions for as long as the item's referent
   * stays in the set." */
  id: string;
  kind: "reference" | "frozen";
  source?: EvalCaseSource | null;
  case_id?: string | null;
  /** "Why this member is noteworthy." */
  note?: string | null;
  added_at: string;
}

// openapi.yaml EvalSetItemCreate — "Exactly one referent (oneOf): source adds a
// reference item, case_id adds a frozen one." Also the ⊞ action's body.
export type EvalSetItemCreate =
  | { source: EvalCaseSource; note?: string | null }
  | { case_id: string; note?: string | null };

// openapi.yaml EvalSet — "named collection of cases (versioned, reusable across
// runs/models)", merged with the Casebook — "a named collection of turn
// REFERENCES" — into the one noun. "Membership is versioned: every change
// appends a new version with its own full item list … name and description are
// NOT versioned."
export interface EvalSet {
  id: string;
  name: string;
  description?: string | null;
  version: number;
  items: EvalSetItem[];
  created_at: string;
}

// openapi.yaml EvalSetPage
export type EvalSetPage = Page<EvalSet>;

export interface EvalSetCreate {
  name: string;
  description?: string | null;
  /** "Initial membership (version 1); empty/omitted = start empty." */
  items?: EvalSetItemCreate[];
}

// openapi.yaml EvalSetUpdate — "The full membership for the NEW version …
// items absent from this list leave the set."
export interface EvalSetUpdate {
  items: EvalSetItemCreate[];
}

// openapi.yaml EvalSetMetadataUpdate — "Metadata only; every membership change
// goes elsewhere." A rename takes no membership version.
export interface EvalSetMetadataUpdate {
  name?: string | null;
  description?: string | null;
}

// openapi.yaml EvalSetFreezeRequest — "Which reference items to freeze into
// cases; omit item_ids for all of them."
export interface EvalSetFreezeRequest {
  item_ids?: string[] | null;
}

// openapi.yaml EvalSetReplayRequest — "Same engine as ReplayRequest applied to
// the set's REFERENCE items". context_policy is pinned to frozen by the client
// exactly as on ReplayRequest (widening is future work).
export interface EvalSetReplayRequest {
  configs: Variant[];
  context_policy?: "frozen";
}

// openapi.yaml EvalSetReplayAccepted — "One parent task; one evaluation per
// tree the set's reference items touch (evaluations are tree-scoped … a
// cross-tree set therefore yields several). Fetch each grid via
// GET /agenttrees/{tree_id}/evaluations/{evaluation_id}".
export interface EvalSetReplayAccepted {
  task_id: string;
  evaluations: Array<{ tree_id: string; evaluation_id: string }>;
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

// openapi.yaml:1857 JudgeRequest — ":1861-1864 Exactly one of evaluation_id /
// case_ids … evaluation_id = 'Judge this evaluation', auto-creating cases from turns
// none exist (feature-spec.md:61)"; rubric_version ":1876-1879 Pin a specific
// rubric version; omit for latest".
export interface JudgeRequest {
  evaluation_id?: string | null;
  case_ids?: string[] | null;
  /** openapi.yaml:2934-2936 — "Judge every case in this eval set"; the oneOf
   * became evaluation_id | case_ids | set_id in v0.3.0 (:2926-2929). */
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

// openapi.yaml JudgmentEvent — "A judgment appended by a finished judging
// task — 'scores stream into the grid live' (feature-spec.md:64). The join
// keys are on the judgment itself: subject and evaluation_id."
export interface JudgmentEvent {
  judgment: Judgment;
}

// openapi.yaml EvaluationScoreSummary — "Feeds 'summary header (mean,
// distribution sparkline)' (feature-spec.md:49)". One group per SCORER
// IDENTITY (kind + ref + version); the judge model is not part of the key, so
// the group's scorer carries model: null.
export interface ScorerScoreSummary {
  scorer: Scorer;
  mean: number;
  count: number;
  distribution: number[];
}

export interface EvaluationScoreSummary {
  evaluation_id: string;
  scorers: ScorerScoreSummary[];
}

// openapi.yaml:1483 Variant — ":1488-1489 instruction_version XOR
// snapshot_id — a snapshot is an untested draft (feature-spec.md:86);
// neither = the live version. endpoint_ids only applies to turn re-fire."
export interface Variant {
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
  configs: Variant[];
  baseline_evaluation_id?: string | null;
  context_policy?: "frozen";
}

// openapi.yaml:1548 ReplayAccepted — "Every request returns task_id
// (feature-spec.md:102)"; evaluation_id feeds GET …/evaluations/{id} for the grid.
export interface ReplayAccepted {
  task_id: string;
  evaluation_id: string;
}

// openapi.yaml:1556 ReplayTurnRequest — ":1565 feature-spec.md:71 'body
// includes endpoints[]'"; context_policy pinned as on ReplayRequest (:1570-1574).
export interface ReplayTurnRequest {
  conversation_id: string;
  turn_id: string;
  endpoints: string[];
  config?: Variant | null;
  context_policy?: "frozen";
}

// openapi.yaml:1576 ReplayTurnAccepted — "returns one task_id + new
// conversation_id per endpoint" (feature-spec.md:71); evaluation_id backs the
// fork-comparison pivot (:1581-1585).
export interface ReplayTurnAccepted {
  evaluation_id: string;
  results: Array<{ endpoint_id: string; task_id: string; conversation_id: string }>;
}

// openapi.yaml:1596 EvaluationSummaryItem — GET /agenttrees/{tree}/evaluations listing.
export interface EvaluationSummaryItem {
  id: string;
  tree_id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  created_at: string;
  task_id: string;
  label?: string | null;
}

// openapi.yaml EvaluationSummaryPage
export type EvaluationSummaryPage = Page<EvaluationSummaryItem>;

// openapi.yaml:1645 Result — ":1642 One per column, same order; fills
// incrementally (feature-spec.md:108)".
export interface Result {
  status: "pending" | "running" | "done" | "failed";
  content?: string | null;
  conversation_id?: string | null;
  turn_id?: string | null;
  task_id?: string | null;
  case_id?: string | null;
  latest_score?: number | null;
  error?: string | null;
}

// openapi.yaml:1607 Evaluation — comparison-grid data: "baseline column + one column
// per run config, row per turn" (feature-spec.md:49); ":1621 Index 0 =
// baseline. Column labels relabel when a snapshot promotes."
export interface EvaluationColumn {
  label: string;
  config: Variant;
}

export interface EvaluationRow {
  source: { conversation_id: string; turn_id: string };
  cells: Result[];
}

// openapi.yaml EvaluationRowPage — Evaluation.rows. The grid body is a product
// (rows × columns × cells) and clients POLL it while it fills, so rows are
// paged. Safe to page, unlike a newest-first listing: an evaluation's row set
// is written when the evaluation is created and only the CELLS change, so page
// N holds the same rows before, during and after the run.
export type EvaluationRowPage = Page<EvaluationRow>;

export interface Evaluation {
  id: string;
  tree_id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  created_at: string;
  task_id: string;
  /** Not paged: the caller's own configs, needed whole to read any row. */
  columns: EvaluationColumn[];
  rows: EvaluationRowPage;
}

// openapi.yaml:1668 Span — "Span = {id, parent_id, type: agent|llm|tool, name,
// start, end, tokens_in?, tokens_out?, cost?, model?, status, payload_ref}"
// (feature-spec.md:140); error ":1686-1689 Error message when status is error
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
// in/out, cost (feature-spec.md:143)".
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
// carry args/result (feature-spec.md:145)"; lazy-loaded (openapi.yaml:729-730).
export interface SpanPayload {
  span_id: string;
  prompt?: string | null;
  response?: string | null;
  args?: unknown;
  result?: unknown;
}

// openapi.yaml:1788 SpanEvent — "Live trace span on the tasks channel
// (feature-spec.md:146)"; `span` frame on GET /tasks/stream (openapi.yaml:793).
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

// openapi.yaml GET /tasks query params — status / parent_id ("Children of
// this task; omit for the default top-level listing") + paging. `limit` is
// gone: it was a top-N with no way to ask for the rest and no way to know
// there was a rest.
export interface TaskListParams extends PageParams {
  status?: Task["status"];
  parent_id?: string;
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
    evaluation_id?: string | null;
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

// openapi.yaml TaskPage
export type TaskPage = Page<Task>;
