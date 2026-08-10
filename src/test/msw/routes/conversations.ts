// Conversations + fork transcripts: the listing, the transcript read, and the
// rename/delete pair that the tree-disable gate treats as writes.
import { http, HttpResponse } from "msw";
import type { ConversationFixture } from "../state";
import {
  apiError,
  BASE,
  conv,
  enabledTreeGate,
  envelope,
  pageOf,
  treeGate,
  wireConversation,
} from "../state";

// Roots (lineage null) — sorted by last activity, server-side (openapi.yaml:381).
// Factory-seeded: the replay/turn handler mutates forks + fork_count, so
// resetHandlerState must rebuild fresh objects, not restore references.
function seedRoots(): ConversationFixture[] {
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
export const mockRoots: ConversationFixture[] = seedRoots();

// Fork transcripts: copied history strictly BEFORE the fork turn (fresh ids,
// mirroring mock/main.py:664-673) + the regenerated assistant turn appended by
// the fork task (engine.py:354-363). Endpoint ids use the ep_agent1_* form of
// the endpoint fixtures.
function seedForks(): Record<string, ConversationFixture[]> {
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
  // Orphan: parent c-gone is a TOMBSTONE — lineage survives and the parent
  // link renders as deleted. GET /conversations/c-gone answers 200 with
  // deleted: true (it is deleted, not absent); the fork itself still loads.
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
export const mockForks: Record<string, ConversationFixture[]> = seedForks();

// Requests seen by the conversations handler — tests assert query params here.
export const conversationRequests: URL[] = [];
/** Full request URLs seen by listTurns — tests assert the paging the UI asks for. */
export const turnRequests: URL[] = [];

/** Roots and forks as one list — the "find a conversation by id" lookup. */
export function allConversations(): ConversationFixture[] {
  return [...mockRoots, ...mockTombstones, ...Object.values(mockForks).flat()];
}

// Tombstones: deleted conversations that still resolve BY ID and never appear
// in a listing — the mirror of the store's `deleted` column. c-gone is the
// parent of the orphan fork above, and it is what lets a UI test tell
// "deleted" apart from "absent" (which is still a 404).
function seedTombstones(): ConversationFixture[] {
  return [
    conv({
      id: "c-gone",
      title: "Deleted conversation",
      deleted: true,
      last_activity_at: "2026-08-02T10:00:00Z",
      turns: [
        {
          id: "t1",
          role: "user",
          author: "user",
          content: "This conversation was deleted.",
          created_at: "2026-08-02T10:00:00Z",
          envelope,
        },
      ],
    }),
  ];
}
export const mockTombstones: ConversationFixture[] = seedTombstones();

export const conversationHandlers = [
  http.get(`${BASE}/agenttrees/:tree/conversations`, ({ params, request }) => {
    const url = new URL(request.url);
    conversationRequests.push(url);
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    const forksOf = url.searchParams.get("forks_of");
    // ?search= per openapi.yaml listConversations: the whole value as ONE
    // substring (never tokenised), case-insensitive, matched LITERALLY, and
    // trimmed — empty after trimming means "no filter", never "match
    // nothing". It used to search the TITLE ONLY here while mock/main.py
    // searched title OR turn content, which is exactly the disagreement an
    // undefined parameter produces between two conformant backends.
    const search = url.searchParams.get("search")?.trim().toLowerCase();
    // Tombstones are never listed (openapi.yaml listConversations: no
    // include_deleted, deliberately) — they are reached by id only.
    let items = (forksOf ? (mockForks[forksOf] ?? []) : mockRoots).filter((c) => !c.deleted);
    // ?agent_id= — "view recent conversations for this agent"
    // (openapi.yaml:365-371).
    const agentId = url.searchParams.get("agent_id");
    if (agentId) items = items.filter((c) => c.agent_id === agentId);
    if (search) {
      items = items.filter(
        (c) =>
          c.title.toLowerCase().includes(search) ||
          c.turns.some((t) => t.content.toLowerCase().includes(search)),
      );
    }
    // Server-side sort (openapi.yaml:381; mock/main.py:754, :910
    // ORDER BY last_activity_at DESC) — not a property of the fixture order.
    items = items.slice().sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));
    // Rows are metadata only — the transcript is its own collection now
    // (openapi.yaml listTurns), so a listing no longer costs page size ×
    // conversation length.
    return HttpResponse.json(pageOf(items.map(wireConversation), url));
  }),

  http.get(`${BASE}/agenttrees/:tree/conversations/:id`, ({ params }) => {
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    const found = allConversations().find((c) => c.id === params.id);
    if (!found) {
      return apiError("not_found", "conversation not found", 404);
    }
    return HttpResponse.json(wireConversation(found));
  }),

  // GET …/conversations/{id}/turns (listTurns) — chronological, and an
  // omitted `page` means the LAST page, exactly as mock/main.py answers it.
  http.get(`${BASE}/agenttrees/:tree/conversations/:id/turns`, ({ params, request }) => {
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    const found = allConversations().find((c) => c.id === params.id);
    if (!found) {
      return apiError("not_found", "conversation not found", 404);
    }
    const url = new URL(request.url);
    turnRequests.push(url);
    const ids = url.searchParams.get("turn_ids");
    const wanted = ids ? new Set(ids.split(",").filter(Boolean)) : null;
    const rows = wanted ? found.turns.filter((t) => wanted.has(t.id)) : found.turns;
    const pageSize = Math.max(1, Math.min(Number(url.searchParams.get("page_size") ?? 50), 200));
    const last = Math.max(1, Math.ceil(rows.length / pageSize));
    const asked = url.searchParams.get("page");
    const page = asked == null ? last : Math.min(Math.max(1, Number(asked)), last);
    return HttpResponse.json({
      items: rows.slice((page - 1) * pageSize, page * pageSize),
      page,
      page_size: pageSize,
      total: rows.length,
    });
  }),

  // PATCH/DELETE are in the disable gate's write set: "history is read-only,
  // not just readable" (mock/main.py:426-441).
  http.patch(`${BASE}/agenttrees/:tree/conversations/:id`, async ({ params, request }) => {
    const body = (await request.json()) as { title?: string };
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    const found = allConversations().find((c) => c.id === params.id);
    if (!found) {
      return apiError("not_found", "conversation not found", 404);
    }
    if (found.deleted) {
      return apiError("conversation_deleted", "conversation is deleted", 409);
    }
    return HttpResponse.json(wireConversation({ ...found, title: body.title ?? found.title }));
  }),

  // DELETE — soft and idempotent: the row becomes a tombstone (still readable
  // by id, gone from listings) and deleting it again answers 204 again.
  http.delete(`${BASE}/agenttrees/:tree/conversations/:id`, ({ params }) => {
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    const found = allConversations().find((c) => c.id === params.id);
    if (!found) {
      return apiError("not_found", "conversation not found", 404);
    }
    found.deleted = true;
    return new HttpResponse(null, { status: 204 });
  }),
];

export function resetConversations() {
  conversationRequests.length = 0;
  turnRequests.length = 0;
  mockRoots.length = 0;
  mockRoots.push(...seedRoots());
  mockTombstones.length = 0;
  mockTombstones.push(...seedTombstones());
  for (const key of Object.keys(mockForks)) delete mockForks[key];
  Object.assign(mockForks, seedForks());
}
