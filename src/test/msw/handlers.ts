// MSW handlers derived from openapi.yaml v0.2.0 — reused by later tasks.
// Covers: GET /me (openapi.yaml:62), GET /agenttrees (:115),
// GET /agenttrees/{tree}/conversations (:335, params search/page/page_size/
// forks_of/agent_id/origin), GET/PATCH/DELETE .../conversations/{id} (:387).
import { http, HttpResponse } from "msw";
import { BASE } from "../../api/base";
import type { AgentTree, Conversation, Me } from "../../api/types";

export const mockMe: Me = {
  user: { id: "dev", name: "Dev User", email: "dev@example.com" },
  permissions: { agent1: ["view", "tune", "evaluate"], agent2: ["view"] },
};

export const mockTrees: AgentTree[] = [
  { id: "agent1", name: "Agent 1", enabled: true },
  { id: "agent2", name: "Agent 2", enabled: true },
];

const envelope = {
  system_date: "2026-08-02",
  timezone: "Europe/London",
  region: "GB",
  locale: "en-GB",
};

function conv(partial: Partial<Conversation> & Pick<Conversation, "id" | "title">): Conversation {
  return {
    tree_id: "agent1",
    origin: "interactive",
    created_at: "2026-08-01T10:00:00Z",
    last_activity_at: "2026-08-03T10:00:00Z",
    fork_count: 0,
    ...partial,
  };
}

// Roots (lineage null) — sorted by last activity, server-side (openapi.yaml:381).
export const mockRoots: Conversation[] = [
  conv({
    id: "c1",
    title: "Refund escalation",
    last_activity_at: "2026-08-04T09:58:00Z",
    turns: [
      {
        id: "t1",
        role: "user",
        author: "user",
        content: "How do refunds work?",
        created_at: "2026-08-04T09:57:00Z",
        envelope,
      },
      {
        id: "t2",
        role: "assistant",
        author: "refunds",
        content: "Approved refunds land in 3-5 days.",
        created_at: "2026-08-04T09:58:00Z",
        envelope,
      },
    ],
  }),
  conv({ id: "c2", title: "Billing dispute", fork_count: 2, last_activity_at: "2026-08-04T09:00:00Z" }),
  conv({ id: "c3", title: "Onboarding help", last_activity_at: "2026-08-01T10:00:00Z" }),
];

export const mockForks: Record<string, Conversation[]> = {
  c2: [
    conv({
      id: "c2f1",
      title: "Billing dispute",
      lineage: {
        parent_conversation_id: "c2",
        fork_turn_id: "t9",
        endpoint_id: "prod",
        config: { instruction_version: 15 },
      },
    }),
    conv({
      id: "c2f2",
      title: "Billing dispute",
      lineage: {
        parent_conversation_id: "c2",
        fork_turn_id: "t9",
        endpoint_id: "staging",
        config: { instruction_version: 15 },
      },
    }),
  ],
};

// Requests seen by the conversations handler — tests assert query params here.
export const conversationRequests: URL[] = [];

export function resetHandlerState() {
  conversationRequests.length = 0;
}

export const handlers = [
  http.get(`${BASE}/me`, () => HttpResponse.json(mockMe)),

  http.get(`${BASE}/agenttrees`, () => HttpResponse.json(mockTrees)),

  http.get(`${BASE}/agenttrees/:tree/conversations`, ({ request }) => {
    const url = new URL(request.url);
    conversationRequests.push(url);
    const forksOf = url.searchParams.get("forks_of");
    const search = url.searchParams.get("search")?.toLowerCase();
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("page_size") ?? 20);

    let items = forksOf ? (mockForks[forksOf] ?? []) : mockRoots;
    if (search) items = items.filter((c) => c.title.toLowerCase().includes(search));
    const total = items.length;
    items = items.slice((page - 1) * pageSize, page * pageSize);
    // Listing strips full turns? Contract includes turns in listings
    // (openapi.yaml:1376) — keep them.
    return HttpResponse.json({ items, page, page_size: pageSize, total });
  }),

  http.get(`${BASE}/agenttrees/:tree/conversations/:id`, ({ params }) => {
    const all = [...mockRoots, ...Object.values(mockForks).flat()];
    const found = all.find((c) => c.id === params.id);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "conversation not found" }, { status: 404 });
    }
    return HttpResponse.json(found);
  }),

  http.patch(`${BASE}/agenttrees/:tree/conversations/:id`, async ({ params, request }) => {
    const body = (await request.json()) as { title?: string };
    const found = mockRoots.find((c) => c.id === params.id);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "conversation not found" }, { status: 404 });
    }
    return HttpResponse.json({ ...found, title: body.title ?? found.title, turns: undefined });
  }),

  http.delete(`${BASE}/agenttrees/:tree/conversations/:id`, () =>
    new HttpResponse(null, { status: 204 }),
  ),
];
