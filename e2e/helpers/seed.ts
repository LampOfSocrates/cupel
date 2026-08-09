import { expect, type APIRequestContext } from "@playwright/test";
import { API_ORIGIN } from "./api";

// The few API writes the journeys need as SETUP. Everything a spec
// actually asserts still goes through the UI; this is only "given a
// conversation exists". Same trick smoke.spec.ts and dod.spec.ts already use:
// the mock's generation is a pure function of its inputs (mock/util.py
// det_hash), so identical setup gives identical content every run.

/** canned_title (mock/util.py:32) truncates at 48 chars, so a message shorter
 * than that becomes the conversation title verbatim — which is how specs get
 * stable, unique accessible names to click on. */
export const TITLE_MAX = 48;

export interface SeededChat {
  conversationId: string;
  turnId: string;
  taskId: string;
}

export interface SeedOptions {
  tree?: string;
  conversationId?: string;
  token?: string;
  /** generator-style machine traffic (mock/generator.py) */
  origin?: "human" | "machine";
}

function auth(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** One completed chat turn, created outside the browser. */
export async function seedChat(
  request: APIRequestContext,
  message: string,
  opts: SeedOptions = {},
): Promise<SeededChat> {
  expect(message.length, "keep seeded messages under the title cut").toBeLessThan(TITLE_MAX);
  const tree = opts.tree ?? "agent1";
  const res = await request.post(`${API_ORIGIN}/agenttrees/${tree}/chat`, {
    data: {
      message,
      stream: false,
      conversation_id: opts.conversationId,
      ...(opts.origin === "machine"
        ? { origin: "machine", channel: "generator", author: "gen-persona-1" }
        : {}),
    },
    headers: auth(opts.token),
    timeout: 60_000,
  });
  expect(res.ok(), `seedChat failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  return {
    conversationId: body.conversation_id,
    turnId: body.turn.id,
    taskId: body.task_id,
  };
}

/** A rubric to judge against — the bootstrap seed ships none (mock/seed.py:3);
 * the generator seed ships two. Specs that assert on a rubric by name make
 * their own so the option text is unambiguous. */
export async function seedRubric(
  request: APIRequestContext,
  name: string,
  prompt = "Score 0-1: is the reply helpful and grounded?",
  token?: string,
): Promise<{ id: string; version: number; name: string }> {
  const res = await request.post(`${API_ORIGIN}/eval/rubrics`, {
    data: { name, prompt },
    headers: auth(token),
  });
  expect(res.status()).toBe(201);
  return res.json();
}

/** Fork a turn against endpoints, outside the browser (the UI path is
 * journey 4's subject). One child task + one new conversation per endpoint. */
export async function seedTurnFork(
  request: APIRequestContext,
  chat: SeededChat,
  endpointIds: string[],
  opts: SeedOptions = {},
): Promise<{
  run_id: string;
  results: { endpoint_id: string; task_id: string; conversation_id: string }[];
}> {
  const tree = opts.tree ?? "agent1";
  const res = await request.post(`${API_ORIGIN}/agenttrees/${tree}/replay/turn`, {
    data: {
      conversation_id: chat.conversationId,
      turn_id: chat.turnId,
      endpoints: endpointIds,
    },
    headers: auth(opts.token),
  });
  expect(res.status(), await res.text()).toBe(202);
  return res.json();
}

/** Queue a replay, outside the browser. */
export async function seedReplay(
  request: APIRequestContext,
  selection: { conversation_id: string; turn_ids?: string[] }[],
  configs: Record<string, unknown>[],
  opts: SeedOptions = {},
): Promise<{ task_id: string; run_id: string }> {
  const tree = opts.tree ?? "agent1";
  const res = await request.post(`${API_ORIGIN}/agenttrees/${tree}/replay`, {
    data: { selection, configs },
    headers: auth(opts.token),
  });
  expect(res.status(), await res.text()).toBe(202);
  return res.json();
}

/** Poll a task to a terminal status — used only where a journey needs work to
 * be FINISHED before it starts (never as a sleep). */
export async function awaitTask(
  request: APIRequestContext,
  taskId: string,
  token?: string,
): Promise<Record<string, unknown>> {
  let task: Record<string, unknown> = {};
  await expect
    .poll(
      async () => {
        const res = await request.get(`${API_ORIGIN}/tasks/${taskId}`, { headers: auth(token) });
        task = await res.json();
        return task.status as string;
      },
      { timeout: 60_000 },
    )
    .toMatch(/done|failed|cancelled/);
  return task;
}

/** A JWT for a seeded user (mock/auth.py SEED_USERS) — AUTH_MODE=on only. */
export async function signInApi(
  request: APIRequestContext,
  email: string,
  password = "demo",
): Promise<string> {
  const res = await request.post(`${API_ORIGIN}/auth/token`, {
    data: { email, password },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).access_token;
}
