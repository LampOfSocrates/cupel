// The bare-agent shim — persona B, the wedge (docs/plan-adopter-onboarding.md).
//
// The adopter has a framework agent (ADK / LangGraph / Mastra / CrewAI /
// PydanticAI) reachable over HTTP and NO OpenAPI document at all, so nothing
// can be matched against the contract. What they can answer is "where does
// your agent reply, and how does it stream" — and that is enough to put their
// own agent in a real chat UI, which is stage 1 of the ladder.
//
// This maps ONE family (chat) onto whatever their endpoint already does:
//   - request: POST {url} with {message, conversation_id, stream} as JSON;
//   - reply: an SSE token stream, or a single JSON body, per
//     agentEndpoint.stream (declared with --stream, else detected at
//     generation time from the endpoint's content-type).
// Everything the contract has that a bare endpoint cannot supply — task ids,
// turn ids, conversation ids — is minted here, client-side.
//
// WHAT THAT COSTS, so nobody discovers it later: conversations live in THIS
// TAB'S MEMORY until the adopter implements the conversations family (stage 2).
// A reload loses them. The sidebar's recent list is whatever serves the
// conversations family, which is not this.
import { agenticConfig } from "../../agentic.config";
import { familyAnswer } from "../lib/families";
import { parseSseStream } from "./sse";
import type { ChatStreamEvent } from "./client";
import type { ChatRequest, Conversation, Turn, TurnPage } from "./types";

export interface BareAgentConfig {
  url: string;
  stream: "sse" | "json";
}

/**
 * The shim answers only when the config declares an endpoint AND chat is the
 * adopter's own family — answering `mock` for chat means the bundled backend
 * is deliberately in front, and this must not silently take over.
 */
export function bareAgent(): BareAgentConfig | null {
  const endpoint = agenticConfig.agentEndpoint;
  if (!endpoint?.url) return null;
  return familyAnswer("chat") === "mine" ? endpoint : null;
}

// ---------------------------------------------------------------- extracting
// Framework agents disagree about where the text lives. Rather than demand one
// shape, read the shapes that exist — and when none matches, fall back to the
// raw text instead of rendering "[object Object]" at the user.

const DELTA_KEYS = ["delta", "token", "text", "content", "chunk", "message"];
const REPLY_KEYS = ["reply", "response", "answer", "output", "text", "content", "message"];

const fromKeys = (value: unknown, keys: string[]): string | null => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  // OpenAI-compatible servers are common enough to be worth naming.
  const choice = (record.choices as { delta?: { content?: string }; message?: { content?: string } }[] | undefined)?.[0];
  if (choice?.delta?.content) return choice.delta.content;
  if (choice?.message?.content) return choice.message.content;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === "string") return found;
    if (found && typeof found === "object") {
      const nested = fromKeys(found, keys);
      if (nested !== null) return nested;
    }
  }
  return null;
};

/** One SSE frame's text. `[DONE]` (OpenAI's sentinel) ends the stream. */
export function extractDelta(data: string): string | null {
  const trimmed = data.trim();
  if (trimmed === "[DONE]") return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return data;
  try {
    return fromKeys(JSON.parse(trimmed), DELTA_KEYS) ?? "";
  } catch {
    return data; // not JSON after all — it is the text
  }
}

/** A non-streaming reply body's text. */
export function extractReply(body: unknown, raw = ""): string {
  return fromKeys(body, REPLY_KEYS) ?? raw;
}

// ------------------------------------------------------------- conversations
// In-memory only, and deliberately so: persisting here would be a second
// implementation of the conversations family, which is exactly what stage 2
// asks the adopter to build for real.

const conversations = new Map<string, { conversation: Conversation; turns: Turn[] }>();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

export const bareAgentOwns = (conversationId: string) => conversations.has(conversationId);

export function bareAgentConversation(conversationId: string): Conversation | null {
  return conversations.get(conversationId)?.conversation ?? null;
}

export function bareAgentTurns(conversationId: string): TurnPage {
  const turns = conversations.get(conversationId)?.turns ?? [];
  return { items: turns, page: 1, page_size: Math.max(turns.length, 1), total: turns.length };
}

function remember(tree: string, conversationId: string | null, title: string) {
  if (conversationId && conversations.has(conversationId)) return conversationId;
  const newId = conversationId ?? id("conv");
  const now = new Date().toISOString();
  conversations.set(newId, {
    conversation: {
      id: newId,
      tree_id: tree,
      title: title.slice(0, 60) || "New conversation",
      origin: "interactive",
      created_at: now,
      last_activity_at: now,
      fork_count: 0,
      turn_count: 0,
      deleted: false,
    },
    turns: [],
  });
  return newId;
}

function append(conversationId: string, turn: Turn) {
  const entry = conversations.get(conversationId);
  if (!entry) return;
  entry.turns.push(turn);
  entry.conversation.turn_count = entry.turns.length;
  entry.conversation.last_activity_at = turn.created_at;
}

// -------------------------------------------------------------------- chat

const turnOf = (role: Turn["role"], content: string): Turn => ({
  id: id(role === "user" ? "turn_u" : "turn_a"),
  role,
  author: role,
  content,
  created_at: new Date().toISOString(),
  envelope: null,
});

/**
 * POST the message to their endpoint and emit contract chat events over
 * whatever comes back. The `task` event carries minted ids — stop-generation
 * (DELETE /tasks/{id}) has nothing to cancel on a bare endpoint, so the UI's
 * abort signal is the real stop and the task id is only there to satisfy the
 * shape the contract promises.
 */
export async function bareAgentChat(
  endpoint: BareAgentConfig,
  tree: string,
  req: ChatRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<{ kind: "stream"; events: AsyncGenerator<ChatStreamEvent, void> }> {
  const conversationId = remember(tree, req.conversation_id ?? null, req.message);
  append(conversationId, turnOf("user", req.message));

  const res = await fetch(endpoint.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream, application/json" },
    body: JSON.stringify({
      message: req.message,
      conversation_id: conversationId,
      stream: endpoint.stream === "sse",
    }),
    signal: opts.signal,
  });

  const assistantTurnId = id("turn_a");
  const events = async function* (): AsyncGenerator<ChatStreamEvent, void> {
    yield {
      event: "task",
      data: {
        task_id: id("task"),
        conversation_id: conversationId,
        user_turn_id: id("turn_u"),
        assistant_turn_id: assistantTurnId,
      },
    };

    if (!res.ok) {
      yield {
        event: "error",
        data: {
          code: "agent_error",
          message: `Your agent answered ${res.status} ${res.statusText} (${endpoint.url}).`,
          request_id: "",
        },
      };
      return;
    }

    let text = "";
    const contentType = res.headers.get("content-type") ?? "";
    // The declared shape is a default, not a contract: an endpoint that
    // answers JSON when we expected SSE is read as JSON rather than failed.
    if (endpoint.stream === "sse" && contentType.includes("text/event-stream") && res.body) {
      for await (const msg of parseSseStream(res.body)) {
        const delta = extractDelta(msg.data);
        if (delta === null) break; // [DONE]
        if (delta) {
          text += delta;
          yield { event: "token", data: { delta } };
        }
      }
    } else {
      const raw = await res.text();
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // plain text answer — extractReply falls back to it
      }
      text = extractReply(parsed, raw);
      if (text) yield { event: "token", data: { delta: text } };
    }

    const turn: Turn = { ...turnOf("assistant", text), id: assistantTurnId };
    append(conversationId, turn);
    yield { event: "done", data: { turn, status: "completed" } };
  };

  return { kind: "stream", events: events() };
}
