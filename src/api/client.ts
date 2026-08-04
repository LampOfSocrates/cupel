// Single typed client — all API calls go through here; no hardcoded hosts
// anywhere else (feature-spec.md:158).
import { BASE } from "./base";
import type {
  AgentTree,
  Conversation,
  ConversationListParams,
  ConversationPage,
  Me,
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

async function request<T>(
  path: string,
  opts: { method?: string; query?: Query; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(buildUrl(path, opts.query), {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
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
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  // GET /me — always called on boot (loom-phases.md:160; openapi.yaml:62)
  me: () => request<Me>("/me"),

  // GET /agenttrees (openapi.yaml:115)
  agentTrees: () => request<AgentTree[]>("/agenttrees"),

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
};
