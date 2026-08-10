import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "./client";
import type { ChatTaskEvent, ErrorBody } from "./types";
import {
  bareAgentChat,
  bareAgentConversation,
  bareAgentOwns,
  bareAgentTurns,
  extractDelta,
  extractReply,
} from "./bareAgent";

// Persona B: a framework agent on HTTP, no OpenAPI, no contract. The shim's
// whole job is to turn whatever that endpoint already emits into the chat
// events the UI consumes — so these tests feed it the shapes real frameworks
// actually produce.

const SSE = { url: "http://agent.test/chat", stream: "sse" as const };
const JSON_MODE = { url: "http://agent.test/chat", stream: "json" as const };

function respond(body: string, contentType: string, status = 200) {
  return vi.fn(
    async (_url: string, _init: RequestInit = {}) =>
      new Response(body, { status, headers: { "content-type": contentType } }),
  );
}

const collect = async (result: Awaited<ReturnType<typeof bareAgentChat>>) => {
  const events = [];
  for await (const event of result.events) events.push(event);
  return events;
};

// The two events these tests read fields off, narrowed. Written as concrete
// finders rather than one generic: a generic K does not narrow the union.
const missing = (kind: string, events: ChatStreamEvent[]) =>
  new Error(`no ${kind} event in [${events.map((e) => e.event).join(", ")}]`);

function taskData(events: ChatStreamEvent[]): ChatTaskEvent {
  const found = events.find((event) => event.event === "task");
  if (found?.event !== "task") throw missing("task", events);
  return found.data;
}

function errorData(events: ChatStreamEvent[]): ErrorBody {
  const found = events.find((event) => event.event === "error");
  if (found?.event !== "error") throw missing("error", events);
  return found.data;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading a token frame", () => {
  it("takes plain text as the text", () => {
    expect(extractDelta("Hello")).toBe("Hello");
  });

  it("reads the shapes frameworks emit", () => {
    expect(extractDelta('{"delta":"Hel"}')).toBe("Hel");
    expect(extractDelta('{"token":"lo"}')).toBe("lo");
    expect(extractDelta('{"content":" there"}')).toBe(" there");
    // OpenAI-compatible servers are common enough to name.
    expect(extractDelta('{"choices":[{"delta":{"content":"!"}}]}')).toBe("!");
  });

  it("ends the stream on the [DONE] sentinel", () => {
    expect(extractDelta("[DONE]")).toBeNull();
  });

  it("falls back to the raw frame rather than rendering an object", () => {
    expect(extractDelta("{not json")).toBe("{not json");
    expect(extractDelta('{"unexpected":{"shape":1}}')).toBe("");
  });
});

describe("reading a single reply", () => {
  it("reads the common reply keys, and a bare string", () => {
    expect(extractReply({ reply: "hi" })).toBe("hi");
    expect(extractReply({ response: "hi" })).toBe("hi");
    expect(extractReply({ output: { text: "hi" } })).toBe("hi");
    expect(extractReply({ choices: [{ message: { content: "hi" } }] })).toBe("hi");
    expect(extractReply("hi")).toBe("hi");
  });

  it("falls back to the raw body when nothing matches", () => {
    expect(extractReply({ weird: 1 }, "raw text")).toBe("raw text");
  });
});

describe("chat over a bare endpoint", () => {
  it("streams tokens and closes with a turn carrying the whole answer", async () => {
    const fetchMock = respond(
      'data: {"delta":"Hel"}\n\ndata: {"delta":"lo"}\n\ndata: [DONE]\n\n',
      "text/event-stream",
    );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(await bareAgentChat(SSE, "agent1", { message: "hi" }));
    expect(events.map((e) => e.event)).toEqual(["task", "token", "token", "done"]);
    expect(events[3]).toMatchObject({ data: { status: "completed", turn: { content: "Hello" } } });
    // The task event's ids are minted here — a bare endpoint has none.
    expect(taskData(events)).toMatchObject({ task_id: expect.stringMatching(/^task_/) });

    // What we sent them: their message, a conversation id, a streaming flag.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(SSE.url);
    expect(JSON.parse(String(init!.body))).toMatchObject({ message: "hi", stream: true });
  });

  it("reads a single JSON reply as one token plus the turn", async () => {
    vi.stubGlobal("fetch", respond('{"reply":"one shot"}', "application/json"));
    const events = await collect(await bareAgentChat(JSON_MODE, "agent1", { message: "hi" }));
    expect(events.map((e) => e.event)).toEqual(["task", "token", "done"]);
    expect(events[2]).toMatchObject({ data: { turn: { content: "one shot" } } });
  });

  // The declared shape is a default, not a promise: an endpoint that answers
  // JSON when SSE was declared is read, not failed.
  it("reads JSON even when SSE was declared", async () => {
    vi.stubGlobal("fetch", respond('{"reply":"actually json"}', "application/json"));
    const events = await collect(await bareAgentChat(SSE, "agent1", { message: "hi" }));
    expect(events.at(-1)).toMatchObject({ data: { turn: { content: "actually json" } } });
  });

  it("surfaces the agent's own failure as a chat error event", async () => {
    vi.stubGlobal("fetch", respond("nope", "text/plain", 500));
    const events = await collect(await bareAgentChat(SSE, "agent1", { message: "hi" }));
    expect(events.map((e) => e.event)).toEqual(["task", "error"]);
    expect(errorData(events)).toMatchObject({ code: "agent_error" });
    expect(errorData(events).message).toContain("500");
  });
});

describe("conversations the shim owns", () => {
  it("keeps the transcript readable in this tab, so the UI can navigate to it", async () => {
    vi.stubGlobal("fetch", respond('{"reply":"answered"}', "application/json"));
    const events = await collect(
      await bareAgentChat(JSON_MODE, "agent1", { message: "remember this" }),
    );
    const conversationId = taskData(events).conversation_id;

    expect(bareAgentOwns(conversationId)).toBe(true);
    expect(bareAgentConversation(conversationId)).toMatchObject({
      id: conversationId,
      tree_id: "agent1",
      title: "remember this",
      turn_count: 2,
    });
    const page = bareAgentTurns(conversationId);
    expect(page.items.map((t) => [t.role, t.content])).toEqual([
      ["user", "remember this"],
      ["assistant", "answered"],
    ]);

    // A second message stays in the same conversation.
    await collect(
      await bareAgentChat(JSON_MODE, "agent1", { message: "again", conversation_id: conversationId }),
    );
    expect(bareAgentTurns(conversationId).items).toHaveLength(4);
  });

  it("owns nothing it did not start — those ids go to the backend", () => {
    expect(bareAgentOwns("c_from_the_backend")).toBe(false);
  });
});
