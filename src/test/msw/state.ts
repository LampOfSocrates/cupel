// Shared MSW state — the fixtures, gates and helpers that more than one route
// module touches. Route modules live in ./routes; ./handlers.ts composes them
// into the `handlers` array and `resetHandlerState`.
//
// The `counters` object is not a style choice: route modules are ES modules and
// an imported `let` binding cannot be reassigned across a module boundary. Ids
// therefore live on one mutable object, which also keeps genuinely shared
// sequences shared — casebook replay, turn re-fire and replay all draw from
// `counters.replay`, exactly as they drew from one `replayCounter` before.
import { HttpResponse } from "msw";
import { agenticConfig } from "../../../agentic.config";
import { getActiveTarget } from "../../api/target";
import type { AgentTree, Conversation, Me } from "../../api/types";

// The test rig registers handlers at the MOCK target's baseUrl, resolved
// through the same store the client uses — vitest is a dev build,
// so the default active target IS mock (agentic.config.ts defaultTarget.dev).
export const BASE = getActiveTarget().baseUrl;

// Second base: the config's LOCAL preset — target-switch tests prove
// that after setActiveTarget("local") every fetch lands on the NEW base.
// Resolved from the one config artifact like BASE (no hardcoded hosts).
export const LOCAL_BASE = agenticConfig.targets.find((t) => t.id === "local")!.baseUrl;

// Every generated-id sequence in the fake backend. Reset wholesale so ids are
// deterministic per test, as they were when each counter was a module `let`.
export const counters = {
  adminUser: 0,
  agent: 0,
  snapshot: 0,
  judgment: 0,
  judge: 0,
  evalCase: 0,
  evalSet: 0,
  evalImport: 0,
  rubric: 0,
  casebook: 0,
  casebookItem: 0,
  attachment: 0,
  replay: 0,
  newConversation: 0,
};

export const mockMe: Me = {
  user: { id: "dev", name: "Dev User", email: "dev@example.com" },
  permissions: { agent1: ["view", "tune", "evaluate"], agent2: ["view"] },
};

// Auth fixtures — POST /auth/token (openapi.yaml:96-128) + POST
// /auth/logout (:130-144). Credentials mirror the real mock's seeded users
// (mock/auth.py SEED_USERS: admin@demo / restricted@demo, password "demo");
// the token is real-SHAPED (three dot-separated segments) — signature not
// verified client-side, the client only stores and attaches it.
export const mockAdminMe: Me = {
  user: { id: "u_admin", name: "Admin", email: "admin@demo" },
  roles: ["admin", "inspect"],
  permissions: {
    agent1: ["view", "tune", "evaluate"],
    agent2: ["view", "tune", "evaluate"],
  },
};
export const MOCK_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1X2FkbWluIn0.c2ln";

function seedTrees(): AgentTree[] {
  return [
    { id: "agent1", name: "Agent 1", enabled: true },
    { id: "agent2", name: "Agent 2", enabled: true },
  ];
}
export const mockTrees: AgentTree[] = seedTrees();

// ------------------------------------------------------- tree access gates
// The two tree rules the real backend centralises in middleware
// (mock/main.py AuthGate + need_tree/need_enabled_tree). MSW enforced neither
// before, so a page could "work" against a tree the server would refuse.
//
// notFoundTree: an absent tree AND a tree the caller cannot view both answer
// 404 not_found — "unpermitted trees never render", never 403
// (openapi.yaml NotFound: "Resource not found (or tree not permitted)";
// mock/main.py:116-119, :161-164). mockMe grants view on agent1 + agent2, so
// this is invisible to every existing test and only bites on a bad tree id.
export function treeGate(tree: string): Response | null {
  const known = mockTrees.some((t) => t.id === tree);
  const permitted = (mockMe.permissions[tree] ?? []).includes("view");
  if (known && permitted) return null;
  return HttpResponse.json(
    { code: "not_found", message: `Agent tree '${tree}' not found.` },
    { status: 404 },
  );
}

// enabledTreeGate: treeGate, then the disable gate for NEW WORK — a
// disabled tree answers 409 tree_disabled while every read keeps working
// ("existing conversations stay READABLE", feature-spec.md:20). The blocked
// set mirrors mock/main.py:426-441 exactly: chat, replay, replay/turn,
// judge-on-an-evaluation-of-this-tree, create agent, PUT instructions, POST snapshots,
// PUT last-selection, and conversation rename/delete. POST /feedback is NOT in
// the set — a thumb annotates existing history, it creates no new work.
// 404 (absent tree) wins over 409, as in the real mock.
//
// KNOWN CONTRACT GAP (deliberate divergence): openapi.yaml v0.3.0
// declares 409 on only five of these — chat, replay, replay/turn, /eval/judge
// and casebook replay. The other six (POST agents, PUT instructions, POST
// snapshots, PUT last-selection, PATCH/DELETE conversation) emit an
// UNDECLARED 409 in mock/main.py:784-932. MSW follows the reference
// implementation rather than the under-declared contract, because the
// behaviour is the specified one (feature-spec.md:20 "history is read-only").
// Pinned by a test in parity.test.ts so a v0.4.0 contract fix retires it.
export function enabledTreeGate(tree: string): Response | null {
  const missing = treeGate(tree);
  if (missing) return missing;
  if (mockTrees.find((t) => t.id === tree)?.enabled === false) {
    return HttpResponse.json(
      {
        code: "tree_disabled",
        message: `Agent tree '${tree}' is disabled — history is read-only.`,
      },
      { status: 409 },
    );
  }
  return null;
}

export const envelope = {
  system_date: "2026-08-02",
  timezone: "Europe/London",
  region: "GB",
  locale: "en-GB",
};

export function conv(
  partial: Partial<Conversation> & Pick<Conversation, "id" | "title">,
): Conversation {
  return {
    tree_id: "agent1",
    origin: "interactive",
    created_at: "2026-08-01T10:00:00Z",
    last_activity_at: "2026-08-03T10:00:00Z",
    fork_count: 0,
    ...partial,
  };
}

// BYOK: X-LLM-Key/X-LLM-Model captures on the generation-adjacent
// endpoints (chat/replay/judge/models). The headers are transport-level BY
// DESIGN — outside openapi.yaml (docs/deployment.md:26).
export const llmHeaderCaptures: Array<{
  path: string;
  url: string; // full URL — tests assert the key is NEVER in it
  key: string | null;
  model: string | null;
}> = [];
export function captureLlmHeaders(request: Request) {
  llmHeaderCaptures.push({
    path: new URL(request.url).pathname,
    url: request.url,
    key: request.headers.get("x-llm-key"),
    model: request.headers.get("x-llm-model"),
  });
}

// DELETE /tasks/{id} doubles as chat stop-generation, so the cancel set is
// written by the tasks route and read by the chat SSE loop.
export const cancelledTasks = new Set<string>();

// ---------------------------------------------------------- task stream rig
// GET /tasks/stream (openapi.yaml:777-813) — controllable SSE: tests call
// taskStreamRig.emit("progress"|"task", data) to push frames to every open
// subscriber (same streaming pattern as the chat handler, but held open
// until the client aborts). clients counts open subscriptions so tests can
// await the subscribe before emitting. The client set is shared because both
// bases serve a stream (BASE's real one and LOCAL_BASE's idle one).
export const taskStreamClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
export const sseEncoder = new TextEncoder();

export const taskStreamRig = {
  emit(event: "task" | "progress" | "span" | "judgment", data: unknown) {
    const frame = sseEncoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const client of [...taskStreamClients]) {
      try {
        client.enqueue(frame);
      } catch {
        taskStreamClients.delete(client); // consumer already gone
      }
    }
  },
  closeAll() {
    for (const client of [...taskStreamClients]) {
      try {
        client.close();
      } catch {
        // already closed by abort
      }
    }
    taskStreamClients.clear();
  },
  get clients() {
    return taskStreamClients.size;
  },
};

export function resetSharedState() {
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0;
  mockTrees.length = 0;
  mockTrees.push(...seedTrees());
  llmHeaderCaptures.length = 0;
  cancelledTasks.clear();
}
