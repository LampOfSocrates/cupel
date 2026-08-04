// Hand-derived from openapi.yaml v0.2.0 (schema line refs in comments).

// openapi.yaml:1069 Me
export interface Me {
  user: { id: string; name: string; email?: string };
  permissions: Record<string, Array<"view" | "tune" | "evaluate">>;
}

// openapi.yaml:1110 AgentTree
export interface AgentTree {
  id: string;
  name: string;
  enabled: boolean;
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
// false = single JSON response (loom-phases.md:43)".
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

// openapi.yaml:1763 TaskProgress
export interface TaskProgress {
  done: number;
  total: number;
  stage?: string;
}

// openapi.yaml:1726 Task — returned by DELETE /tasks/{taskId}
// (openapi.yaml:832-847 "Cancel a task ... also stop-generation").
export interface Task {
  id: string;
  type: "chat" | "replay" | "replay_turn" | "judge";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: TaskProgress;
  parent_id?: string | null;
  result?: {
    run_id?: string | null;
    conversation_id?: string | null;
    turn_id?: string | null;
  } | null;
  error?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  children?: Task[] | null;
}
