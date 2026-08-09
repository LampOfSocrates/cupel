// Conversations + fork transcripts: the listing, the transcript read, and the
// rename/delete pair that the tree-disable gate treats as writes.
import { http, HttpResponse } from "msw";
import type { Conversation } from "../../../api/types";
import { BASE, conv, enabledTreeGate, envelope, pageOf, treeGate } from "../state";

// Roots (lineage null) — sorted by last activity, server-side (openapi.yaml:381).
// Factory-seeded: the replay/turn handler mutates forks + fork_count, so
// resetHandlerState must rebuild fresh objects, not restore references.
function seedRoots(): Conversation[] {
  return [
  conv({
    id: "c1",
    title: "Refund escalation",
    agent_id: "ag_refunds",
    last_activity_at: "2026-08-04T09:58:00Z",
    turns: [
      {
        id: "t1",
        role: "user",
        author: "user",
        content: "How do refunds work?",
        created_at: "2026-08-04T09:57:00Z",
        envelope,
        // Stored attachment rendered on the user turn (openapi.yaml:1313-1315;
        // url null in Phase 1 per openapi.yaml:1284).
        attachments: [
          {
            id: "att-fixture",
            filename: "spec.pdf",
            content_type: "application/pdf",
            size: 12345,
            url: null,
          },
        ],
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
  conv({
    id: "c2",
    title: "Billing dispute",
    agent_id: "ag_concierge",
    fork_count: 2,
    last_activity_at: "2026-08-04T09:00:00Z",
    // t9 is the turn c2f1/c2f2 forked from — the fork-pivot fixtures (the
    // seeded re-fire evaluation below + sibling compare) read its content as the
    // baseline "original" cell.
    turns: [
      {
        id: "t8",
        role: "user",
        author: "user",
        content: "Why was I charged twice for order 4413?",
        created_at: "2026-08-04T08:58:00Z",
        envelope,
      },
      {
        id: "t9",
        role: "assistant",
        author: "concierge",
        content: "I see two charges; one is a pending authorization that will drop off.",
        created_at: "2026-08-04T09:00:00Z",
        envelope,
      },
    ],
  }),
  conv({ id: "c3", title: "Onboarding help", agent_id: "ag_concierge", last_activity_at: "2026-08-01T10:00:00Z" }),
  ];
}
export const mockRoots: Conversation[] = seedRoots();

// Fork transcripts: copied history strictly BEFORE the fork turn (fresh ids,
// mirroring mock/main.py:664-673) + the regenerated assistant turn appended by
// the fork task (engine.py:354-363). Endpoint ids use the ep_agent1_* form of
// the endpoint fixtures.
function seedForks(): Record<string, Conversation[]> {
  return {
  c2: [
    conv({
      id: "c2f1",
      title: "Billing dispute",
      lineage: {
        parent_conversation_id: "c2",
        fork_turn_id: "t9",
        endpoint_id: "ep_agent1_prod",
        config: { instruction_version: 15 },
      },
      turns: [
        {
          id: "c2f1-t8",
          role: "user",
          author: "user",
          content: "Why was I charged twice for order 4413?",
          created_at: "2026-08-04T08:58:00Z",
          envelope,
        },
        {
          id: "c2f1-t9",
          role: "assistant",
          author: "concierge",
          content: "Both charges are temporary holds — the duplicate reverses within 24 hours.",
          created_at: "2026-08-04T09:05:00Z",
          envelope,
        },
      ],
    }),
    conv({
      id: "c2f2",
      title: "Billing dispute",
      lineage: {
        parent_conversation_id: "c2",
        fork_turn_id: "t9",
        endpoint_id: "ep_agent1_staging",
        config: { instruction_version: 15 },
      },
      turns: [
        {
          id: "c2f2-t8",
          role: "user",
          author: "user",
          content: "Why was I charged twice for order 4413?",
          created_at: "2026-08-04T08:58:00Z",
          envelope,
        },
        {
          id: "c2f2-t9",
          role: "assistant",
          author: "concierge",
          content: "One charge is an authorization hold; it is released automatically.",
          created_at: "2026-08-04T09:06:00Z",
          envelope,
        },
      ],
    }),
  ],
  // Orphan: parent c-gone was soft-deleted — lineage survives and "the parent
  // link renders as deleted" (openapi.yaml:441-443). GET /conversations/c-gone
  // 404s; the fork itself still loads.
  "c-gone": [
    conv({
      id: "c-orphan",
      title: "Orphan fork",
      lineage: {
        parent_conversation_id: "c-gone",
        fork_turn_id: "t1",
        endpoint_id: "ep_agent1_staging",
      },
    }),
  ],
  };
}
export const mockForks: Record<string, Conversation[]> = seedForks();

// Requests seen by the conversations handler — tests assert query params here.
export const conversationRequests: URL[] = [];

/** Roots and forks as one list — the "find a conversation by id" lookup. */
export function allConversations(): Conversation[] {
  return [...mockRoots, ...Object.values(mockForks).flat()];
}

export const conversationHandlers = [
  http.get(`${BASE}/agenttrees/:tree/conversations`, ({ params, request }) => {
    const url = new URL(request.url);
    conversationRequests.push(url);
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    const forksOf = url.searchParams.get("forks_of");
    const search = url.searchParams.get("search")?.toLowerCase();
    let items = forksOf ? (mockForks[forksOf] ?? []) : mockRoots;
    // ?agent_id= — "view recent conversations for this agent"
    // (openapi.yaml:365-371).
    const agentId = url.searchParams.get("agent_id");
    if (agentId) items = items.filter((c) => c.agent_id === agentId);
    if (search) items = items.filter((c) => c.title.toLowerCase().includes(search));
    // Server-side sort (openapi.yaml:381; mock/main.py:754, :910
    // ORDER BY last_activity_at DESC) — not a property of the fixture order.
    items = items.slice().sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
    return HttpResponse.json(pageOf(items, url));
  }),

  http.get(`${BASE}/agenttrees/:tree/conversations/:id`, ({ params }) => {
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    const found = allConversations().find((c) => c.id === params.id);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "conversation not found" }, { status: 404 });
    }
    return HttpResponse.json(found);
  }),

  // PATCH/DELETE are in the disable gate's write set: "history is read-only,
  // not just readable" (mock/main.py:426-441).
  http.patch(`${BASE}/agenttrees/:tree/conversations/:id`, async ({ params, request }) => {
    const body = (await request.json()) as { title?: string };
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    const found = mockRoots.find((c) => c.id === params.id);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "conversation not found" }, { status: 404 });
    }
    // `turns` is optional on Conversation (openapi.yaml Conversation.required)
    // and PATCH answers metadata only — JSON.stringify drops the undefined.
    return HttpResponse.json({ ...found, title: body.title ?? found.title, turns: undefined });
  }),

  http.delete(`${BASE}/agenttrees/:tree/conversations/:id`, ({ params }) => {
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    return new HttpResponse(null, { status: 204 });
  }),
];

export function resetConversations() {
  conversationRequests.length = 0;
  mockRoots.length = 0;
  mockRoots.push(...seedRoots());
  for (const key of Object.keys(mockForks)) delete mockForks[key];
  Object.assign(mockForks, seedForks());
}
