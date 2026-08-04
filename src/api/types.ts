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
