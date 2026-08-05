import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { api, ApiError, buildUrl, type ChatStreamEvent } from "./client";
import { setLlmKey, setLlmModel } from "./llmKey";
import { server } from "../test/msw/server";
import {
  BASE,
  chatRequests,
  conversationRequests,
  llmHeaderCaptures,
  mockLiveModels,
  mockMe,
  mockModels,
  replayRequests,
  replayTurnRequests,
} from "../test/msw/handlers";

describe("buildUrl", () => {
  it("prefixes BASE and appends query params", () => {
    expect(buildUrl("/agenttrees/agent1/conversations", { search: "billing", page: 2 })).toBe(
      `${BASE}/agenttrees/agent1/conversations?search=billing&page=2`,
    );
  });

  it("omits undefined and empty params", () => {
    expect(buildUrl("/me", { search: undefined, page: undefined })).toBe(`${BASE}/me`);
    expect(buildUrl("/me", { search: "" })).toBe(`${BASE}/me`);
  });
});

describe("api client", () => {
  it("GET /me returns the dev user", async () => {
    const me = await api.me();
    expect(me.user.id).toBe("dev");
    expect(me.permissions.agent1).toContain("view");
  });

  it("conversations() sends contract query params (openapi.yaml:350-378)", async () => {
    await api.conversations("agent1", { search: "ref", page: 3, forks_of: "c2" });
    const url = conversationRequests.at(-1)!;
    expect(url.pathname).toBe("/agenttrees/agent1/conversations");
    expect(url.searchParams.get("search")).toBe("ref");
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("forks_of")).toBe("c2");
  });

  it("non-2xx throws ApiError with the contract error shape {code, message}", async () => {
    const err = await api.conversation("agent1", "missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe("not_found");
    expect(apiErr.message).toBe("conversation not found");
  });

  it("DELETE resolves on 204 with no body", async () => {
    await expect(api.deleteConversation("agent1", "c3")).resolves.toBeUndefined();
  });

  // Both chat modes on one endpoint, flag in the body (skein-phases.md:43;
  // openapi.yaml:461-464).
  it("chat() with stream:false returns the single JSON ChatResponse", async () => {
    const result = await api.chat("agent1", { message: "hi", stream: false });
    expect(result.kind).toBe("json");
    if (result.kind !== "json") throw new Error("expected json result");
    expect(result.response.task_id).toBe("task-c-new-1");
    expect(result.response.conversation_id).toBe("c-new-1");
    expect(result.response.turn.content).toBe("Hello streaming **world**.");
    expect(chatRequests[0].stream).toBe(false);
  });

  it("chat() with stream:true yields typed task/token/done events off the SSE body", async () => {
    const result = await api.chat("agent1", {
      message: "hi",
      conversation_id: "c1",
      stream: true,
    });
    expect(result.kind).toBe("stream");
    if (result.kind !== "stream") throw new Error("expected stream result");
    const events: ChatStreamEvent[] = [];
    for await (const ev of result.events) events.push(ev);

    // task first (openapi.yaml:467-469 "first event; carries the task_id")
    expect(events[0].event).toBe("task");
    if (events[0].event === "task") {
      expect(events[0].data.task_id).toBe("task-c1");
      expect(events[0].data.conversation_id).toBe("c1");
    }
    const deltas = events
      .filter((e): e is Extract<ChatStreamEvent, { event: "token" }> => e.event === "token")
      .map((e) => e.data.delta);
    expect(deltas).toEqual(["Hello ", "streaming ", "**world**."]);
    const last = events.at(-1)!;
    expect(last.event).toBe("done");
    if (last.event === "done") {
      expect(last.data.status).toBe("completed");
      expect(last.data.turn.content).toBe("Hello streaming **world**.");
    }
  });
});

// P1-T11a — frozen-pinned replay layer. "Phase 1 pin — replays always run
// under each turn's original envelope (feature-spec.md:77, :82)"
// (openapi.yaml:1544-1546); the client hard-sets context_policy so callers
// cannot override it (it is stripped from the function signatures).
describe("replay client", () => {
  it("replay() always sends context_policy frozen and parses 202 ReplayAccepted", async () => {
    const accepted = await api.replay("agent1", {
      selection: [{ conversation_id: "c1" }, { conversation_id: "c2", turn_ids: ["t9"] }],
      configs: [{ model: "deepseek-v3" }, { instruction_version: 2 }],
    });
    expect(accepted.task_id).toBe("task-replay-1");
    expect(accepted.run_id).toBe("run-1");
    const seen = replayRequests.at(-1)!;
    expect(seen.tree).toBe("agent1");
    expect(seen.body.context_policy).toBe("frozen");
    expect(seen.body.selection).toHaveLength(2);
    expect(seen.body.configs).toHaveLength(2);
  });

  it("replayTurn() pins frozen and parses one result per endpoint (feature-spec.md:71)", async () => {
    const accepted = await api.replayTurn("agent1", {
      conversation_id: "c2",
      turn_id: "t9",
      endpoints: ["ep_agent1_prod", "ep_agent1_staging"],
    });
    expect(accepted.run_id).toBe("run-1");
    expect(accepted.results.map((r) => r.endpoint_id)).toEqual([
      "ep_agent1_prod",
      "ep_agent1_staging",
    ]);
    for (const result of accepted.results) {
      expect(result.task_id).toBeTruthy();
      expect(result.conversation_id).toBeTruthy();
    }
    expect(replayTurnRequests.at(-1)!.body.context_policy).toBe("frozen");
  });
});

// P1-T18c — BYOK header attachment, central in the client. Hard rules
// (docs/deployment.md:24-27): key from "browser localStorage only", "Sent per
// request: X-LLM-Key + X-LLM-Model headers", never in URLs. The headers are
// transport-level by design — openapi.yaml is untouched.
describe("BYOK live-LLM headers", () => {
  const KEY = "sk-or-test-vitest-key";

  it("attaches X-LLM-Key/X-LLM-Model to models/chat/replay/judge when a key is stored", async () => {
    setLlmKey(KEY);
    setLlmModel("deepseek/deepseek-chat");
    const models = await api.models();
    // live mode: curated cheap-model list (docs/deployment.md:22-23)
    expect(models).toEqual(mockLiveModels);
    await api.chat("agent1", { message: "hi", stream: false });
    await api.replay("agent1", { selection: [{ conversation_id: "c1" }], configs: [{}] });
    await api.replayTurn("agent1", {
      conversation_id: "c2",
      turn_id: "t9",
      endpoints: ["ep_agent1_prod"],
    });
    await api.judge({ run_id: "run-old-1", judge_model: "claude-haiku-4-5", rubric_id: "rub-help" });
    expect(llmHeaderCaptures.map((c) => c.path)).toEqual([
      "/models",
      "/agenttrees/agent1/chat",
      "/agenttrees/agent1/replay",
      "/agenttrees/agent1/replay/turn",
      "/eval/judge",
    ]);
    for (const c of llmHeaderCaptures) {
      expect(c.key).toBe(KEY);
      expect(c.model).toBe("deepseek/deepseek-chat");
      // the key is NEVER in the URL (docs/deployment.md hard rule)
      expect(c.url).not.toContain(KEY);
    }
  });

  it("attaches nothing when no key is stored — canned mode is the default", async () => {
    const models = await api.models();
    expect(models).toEqual(mockModels);
    await api.chat("agent1", { message: "hi", stream: false });
    for (const c of llmHeaderCaptures) {
      expect(c.key).toBeNull();
      expect(c.model).toBeNull();
    }
  });

  it("non-generation endpoints never carry the key even when one is stored", async () => {
    setLlmKey(KEY);
    let seen: string | null = "unset";
    server.use(
      http.get(`${BASE}/me`, ({ request }) => {
        seen = request.headers.get("x-llm-key");
        return HttpResponse.json(mockMe);
      }),
    );
    await api.me();
    expect(seen).toBeNull();
  });
});
