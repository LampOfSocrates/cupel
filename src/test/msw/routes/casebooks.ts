// Casebooks (openapi.yaml:1643-1830). The store mirrors the real mock's rules:
// items are references, re-adding the same turn returns the EXISTING item
// (:1744), and delete removes references only.
import { http, HttpResponse } from "msw";
import type {
  Casebook,
  CasebookCreate,
  CasebookItem,
  CasebookItemCreate,
  CasebookReplayRequest,
  CasebookToEvalSetRequest,
  CasebookUpdate,
  EvalSet,
} from "../../../api/types";
import { BASE, counters } from "../state";
import { mockEvalSets } from "./evalWorkbench";

function seedCasebooks(): Casebook[] {
  return [
    {
      id: "cb-1",
      name: "Refund misses",
      description: null,
      created_at: "2026-08-04T10:00:00Z",
      items: [
        {
          id: "cbi-1",
          tree: "agent1",
          conversation_id: "c1",
          turn_id: "t2",
          note: "hedged answer",
          added_at: "2026-08-04T10:01:00Z",
        },
      ],
    },
  ];
}
export const mockCasebooks: Casebook[] = seedCasebooks();
export const casebookCreates: CasebookCreate[] = [];
export const casebookPatches: Array<{ casebookId: string; body: CasebookUpdate }> = [];
export const casebookDeletes: string[] = [];
export const casebookItemPosts: Array<{ casebookId: string; body: CasebookItemCreate }> = [];
export const casebookItemDeletes: Array<{ casebookId: string; itemId: string }> = [];
export const casebookToEvalSetRequests: Array<{
  casebookId: string;
  body: CasebookToEvalSetRequest;
}> = [];
export const casebookReplayRequests: Array<{
  casebookId: string;
  body: CasebookReplayRequest;
}> = [];

export const casebookHandlers = [
  http.get(`${BASE}/casebooks`, () => HttpResponse.json(mockCasebooks)),

  http.post(`${BASE}/casebooks`, async ({ request }) => {
    const body = (await request.json()) as CasebookCreate;
    casebookCreates.push(body);
    counters.casebook += 1;
    const created: Casebook = {
      id: `cb-new-${counters.casebook}`,
      name: body.name,
      description: body.description ?? null,
      created_at: new Date().toISOString(),
      items: [],
    };
    mockCasebooks.unshift(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  http.get(`${BASE}/casebooks/:casebookId`, ({ params }) => {
    const found = mockCasebooks.find((c) => c.id === params.casebookId);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "casebook not found" }, { status: 404 });
    }
    return HttpResponse.json(found);
  }),

  http.patch(`${BASE}/casebooks/:casebookId`, async ({ params, request }) => {
    const body = (await request.json()) as CasebookUpdate;
    casebookPatches.push({ casebookId: params.casebookId as string, body });
    const found = mockCasebooks.find((c) => c.id === params.casebookId);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "casebook not found" }, { status: 404 });
    }
    if (body.name) found.name = body.name;
    if (body.description !== undefined) found.description = body.description;
    return HttpResponse.json(found);
  }),

  http.delete(`${BASE}/casebooks/:casebookId`, ({ params }) => {
    const id = params.casebookId as string;
    casebookDeletes.push(id);
    const index = mockCasebooks.findIndex((c) => c.id === id);
    if (index < 0) {
      return HttpResponse.json({ code: "not_found", message: "casebook not found" }, { status: 404 });
    }
    mockCasebooks.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // POST …/items — "Re-adding the same turn is idempotent (returns the
  // existing item)" (openapi.yaml:1744).
  http.post(`${BASE}/casebooks/:casebookId/items`, async ({ params, request }) => {
    const casebookId = params.casebookId as string;
    const body = (await request.json()) as CasebookItemCreate;
    casebookItemPosts.push({ casebookId, body });
    const found = mockCasebooks.find((c) => c.id === casebookId);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "casebook not found" }, { status: 404 });
    }
    const existing = found.items.find(
      (i) =>
        i.tree === body.tree &&
        i.conversation_id === body.conversation_id &&
        i.turn_id === body.turn_id,
    );
    if (existing) return HttpResponse.json(existing, { status: 201 });
    counters.casebookItem += 1;
    const item: CasebookItem = {
      id: `cbi-new-${counters.casebookItem}`,
      tree: body.tree,
      conversation_id: body.conversation_id,
      turn_id: body.turn_id,
      note: body.note ?? null,
      added_at: new Date().toISOString(),
    };
    found.items.push(item);
    return HttpResponse.json(item, { status: 201 });
  }),

  http.delete(`${BASE}/casebooks/:casebookId/items/:itemId`, ({ params }) => {
    const casebookId = params.casebookId as string;
    const itemId = params.itemId as string;
    casebookItemDeletes.push({ casebookId, itemId });
    const found = mockCasebooks.find((c) => c.id === casebookId);
    const index = found?.items.findIndex((i) => i.id === itemId) ?? -1;
    if (!found || index < 0) {
      return HttpResponse.json({ code: "not_found", message: "item not found" }, { status: 404 });
    }
    found.items.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // POST …/to-eval-set (openapi.yaml:1777-1802) — 201 EvalSet whose membership
  // is one case per referenced turn.
  http.post(`${BASE}/casebooks/:casebookId/to-eval-set`, async ({ params, request }) => {
    const casebookId = params.casebookId as string;
    const body = (await request.json()) as CasebookToEvalSetRequest;
    casebookToEvalSetRequests.push({ casebookId, body });
    const found = mockCasebooks.find((c) => c.id === casebookId);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "casebook not found" }, { status: 404 });
    }
    counters.evalSet += 1;
    const created: EvalSet = {
      id: "set_id" in body ? body.set_id : `set-cb-${counters.evalSet}`,
      name: "set_name" in body ? body.set_name : "existing set",
      version: "set_id" in body ? 2 : 1,
      case_ids: found.items.map((i) => `case-for-${i.turn_id}`),
      created_at: new Date().toISOString(),
    };
    const index = mockEvalSets.findIndex((s) => s.id === created.id);
    if (index >= 0) mockEvalSets[index] = created;
    else mockEvalSets.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  // POST …/replay (openapi.yaml:1804-1830) — 202 CasebookReplayAccepted, "one
  // run per tree the casebook's items reference … all children of a single
  // parent task".
  http.post(`${BASE}/casebooks/:casebookId/replay`, async ({ params, request }) => {
    const casebookId = params.casebookId as string;
    const body = (await request.json()) as CasebookReplayRequest;
    casebookReplayRequests.push({ casebookId, body });
    const found = mockCasebooks.find((c) => c.id === casebookId);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "casebook not found" }, { status: 404 });
    }
    counters.replay += 1;
    const trees = [...new Set(found.items.map((i) => i.tree))];
    return HttpResponse.json(
      {
        task_id: `task-cb-${counters.replay}`,
        runs: trees.map((tree_id, i) => ({
          tree_id,
          run_id: `run-cb-${counters.replay}-${i + 1}`,
        })),
      },
      { status: 202 },
    );
  }),
];

export function resetCasebooks() {
  mockCasebooks.length = 0;
  mockCasebooks.push(...seedCasebooks());
  casebookCreates.length = 0;
  casebookPatches.length = 0;
  casebookDeletes.length = 0;
  casebookItemPosts.length = 0;
  casebookItemDeletes.length = 0;
  casebookToEvalSetRequests.length = 0;
  casebookReplayRequests.length = 0;
}
