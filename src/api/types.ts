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
