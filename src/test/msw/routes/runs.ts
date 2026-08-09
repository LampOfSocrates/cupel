// Replay + turn re-fire and the run grid they materialize.
import { http, HttpResponse } from "msw";
import type {
  ReplayAccepted,
  ReplayRequest,
  ReplayTurnAccepted,
  ReplayTurnRequest,
  Run,
  RunConfig,
  RunSummaryItem,
} from "../../../api/types";
import { BASE, captureLlmHeaders, conv, counters, enabledTreeGate, treeGate } from "../state";
import { mockSnapshots } from "./agents";
import { allConversations, mockForks } from "./conversations";
import { mockEndpoints } from "./system";

// --------------------------------------------------------------- replay state
// POST /agenttrees/{tree}/replay(/turn) (openapi.yaml:586-652) — P1-T11a rig,
// reused by P1-T11's Runs flow tests. Both mirror the real mock's Phase-1 pin:
// context_policy other than "frozen" → 422 (mock/main.py:528-529, :605-606;
// openapi.yaml:1540-1546 enum [frozen]).
export const replayRequests: Array<{ tree: string; body: ReplayRequest }> = [];
export const replayTurnRequests: Array<{ tree: string; body: ReplayTurnRequest }> = [];

// ----------------------------------------------------------------- runs state
// GET /agenttrees/{tree}/runs (openapi.yaml:654-669, "Runs, newest first") +
// GET …/runs/{runId} (:671-693, Run schema :1607-1643). Stored runs carry a
// label for the SUMMARY shape only (RunSummaryItem :1605 has label; Run does
// not) — the detail handler strips it. Fixtures are MUTABLE: live-fill tests
// mark cells done / flip status, then poke the /tasks/stream rig;
// resetHandlerState reseeds.
type StoredRun = Run & { label?: string | null };

function seedRuns(): StoredRun[] {
  return [
    {
      id: "run-old-1",
      tree_id: "agent1",
      status: "done",
      created_at: "2026-08-03T12:00:00Z",
      task_id: "task-run-old-1",
      label: "Replay · 1 config(s)",
      columns: [
        { label: "baseline", config: {} },
        { label: "v3", config: { instruction_version: 3 } },
      ],
      rows: [
        {
          source: { conversation_id: "c1", turn_id: "t2" },
          cells: [
            { status: "done", content: "Approved refunds land in 3-5 days." },
            { status: "done", content: "Refunds arrive within 3 business days." },
          ],
        },
      ],
    },
    // Finished turn re-fire — the fork-pivot shape (openapi.yaml:636-639:
    // "a turn re-fire is a run whose grid pivots to 'compare forks of the
    // same turn across endpoints (column per endpoint)'"). Mirrors the real
    // mock's completed state: columns labeled with endpoint NAMES
    // (mock/main.py:634-635), single row, baseline cell carrying the ORIGINAL
    // conversation/turn (mock/main.py:643-646), endpoint cells carrying the
    // fork conversation ids (engine.py:361-363; RunCell.conversation_id =
    // "Fork holding this result", openapi.yaml:1651). Ties into the c2 →
    // c2f1/c2f2 fork fixtures in ./conversations.
    {
      id: "run-refire-1",
      tree_id: "agent1",
      status: "done",
      created_at: "2026-08-03T14:00:00Z",
      task_id: "task-run-refire-1",
      label: "Re-fire · 2 endpoint(s)",
      columns: [
        { label: "baseline", config: {} },
        { label: "prod", config: { instruction_version: 15, endpoint_ids: ["ep_agent1_prod"] } },
        { label: "staging", config: { instruction_version: 15, endpoint_ids: ["ep_agent1_staging"] } },
      ],
      rows: [
        {
          source: { conversation_id: "c2", turn_id: "t9" },
          cells: [
            {
              status: "done",
              content: "I see two charges; one is a pending authorization that will drop off.",
              conversation_id: "c2",
              turn_id: "t9",
            },
            {
              status: "done",
              content: "Both charges are temporary holds — the duplicate reverses within 24 hours.",
              conversation_id: "c2f1",
              turn_id: "c2f1-t9",
              task_id: "task-fork-old-1",
            },
            {
              status: "done",
              content: "One charge is an authorization hold; it is released automatically.",
              conversation_id: "c2f2",
              turn_id: "c2f2-t9",
              task_id: "task-fork-old-2",
            },
          ],
        },
      ],
    },
  ];
}
export const mockRuns: StoredRun[] = seedRuns();
export const runListRequests: string[] = []; // tree ids seen by GET runs
export const runDetailRequests: string[] = []; // run ids seen by GET run

// Column label mirror of the real mock (mock/main.py:110-119 config_label):
// a snapshot column carries the SNAPSHOT'S label ("v3-draft (a3f1)") looked up
// server-side — the client never derives it (feature-spec.md:86; relabel to vN
// on promotion is likewise server-side, mock/main.py:257-262).
function configLabel(cfg: RunConfig, index: number): string {
  if (cfg.snapshot_id) {
    const snap = mockSnapshots.find((s) => s.snapshot_id === cfg.snapshot_id);
    return snap?.label ?? `snapshot ${cfg.snapshot_id}`;
  }
  if (cfg.instruction_version != null) return `v${cfg.instruction_version}`;
  if (cfg.model) return cfg.model;
  return `config ${index + 1}`;
}

// Grid rows from a selection: one row per assistant turn (feature-spec.md:49),
// baseline cell done with the stored content, one pending cell per config
// (mirrors mock/main.py:144-157 assistant_rows + :570-577 cell insert).
function runRowsFromSelection(selection: ReplayRequest["selection"], configCount: number) {
  const all = allConversations();
  const rows: Run["rows"] = [];
  for (const item of selection) {
    const found = all.find((c) => c.id === item.conversation_id);
    for (const turn of found?.turns ?? []) {
      if (turn.role !== "assistant") continue;
      if (item.turn_ids != null && !item.turn_ids.includes(turn.id)) continue;
      rows.push({
        source: { conversation_id: item.conversation_id, turn_id: turn.id },
        cells: [
          { status: "done", content: turn.content },
          ...Array.from({ length: configCount }, () => ({ status: "pending" as const })),
        ],
      });
    }
  }
  return rows;
}

export const runHandlers = [
  // POST /agenttrees/{tree}/replay/turn (openapi.yaml:623-652) → 202
  // ReplayTurnAccepted: "one task_id + new conversation_id per endpoint"
  // (feature-spec.md:71); registered before /replay for readability (MSW
  // matches full paths, order is not load-bearing).
  http.post(`${BASE}/agenttrees/:tree/replay/turn`, async ({ params, request }) => {
    captureLlmHeaders(request); // P1-T18c
    const body = (await request.json()) as ReplayTurnRequest;
    replayTurnRequests.push({ tree: params.tree as string, body });
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    if ((body.context_policy ?? "frozen") !== "frozen") {
      return HttpResponse.json(
        { code: "invalid", message: "Phase 1 replays always run frozen (openapi.yaml:1570-1574)." },
        { status: 422 },
      );
    }
    const n = ++counters.replay;
    const accepted: ReplayTurnAccepted = {
      run_id: `run-${n}`,
      results: body.endpoints.map((endpoint_id, i) => ({
        endpoint_id,
        task_id: `task-fork-${n}-${i + 1}`,
        conversation_id: `c-fork-${n}-${i + 1}`,
      })),
    };
    // Materialize the forks like the real mock (mock/main.py:651-660): history
    // copied up to the re-fired turn, lineage attached (feature-spec.md:68-69).
    // The regenerated turn is NOT present yet — forks generate asynchronously,
    // so Open in Chat first shows just the copied history.
    //
    // Documented divergence, same one POST /feedback carries: mock/main.py
    // 404s a turn_id absent from the conversation, MSW accepts it (forkIndex
    // -1 → whole history copied, null baseline content). Chat compare re-fires
    // the turn it JUST streamed, and a streamed turn lives only in the SSE
    // frames here — never in the conversation fixtures.
    const parent = allConversations().find((c) => c.id === body.conversation_id);
    if (parent) {
      const turns = parent.turns ?? [];
      const forkIndex = turns.findIndex((t) => t.id === body.turn_id);
      const copied = forkIndex >= 0 ? turns.slice(0, forkIndex) : turns;
      const forks = (mockForks[parent.id] ??= []);
      for (const r of accepted.results) {
        forks.push(
          conv({
            id: r.conversation_id,
            title: parent.title,
            turns: copied,
            lineage: {
              parent_conversation_id: parent.id,
              fork_turn_id: body.turn_id,
              endpoint_id: r.endpoint_id,
              config: body.config ?? null,
            },
          }),
        );
      }
      parent.fork_count += accepted.results.length;
      // Materialize the pivot run like the real mock (mock/main.py:634-660):
      // columns labeled with endpoint NAMES, one row whose baseline cell is
      // done with the ORIGINAL conversation/turn and one pending cell per
      // endpoint (conversation_id arrives when the fork task finishes,
      // engine.py:361-363 — not modeled here; T14 tests use the seeded done
      // fixture for that state).
      const treeEndpoints = mockEndpoints[params.tree as string] ?? [];
      mockRuns.unshift({
        id: accepted.run_id,
        tree_id: params.tree as string,
        status: "running",
        created_at: new Date().toISOString(),
        task_id: `task-fork-parent-${n}`,
        label: `Re-fire · ${body.endpoints.length} endpoint(s)`,
        columns: [
          { label: "baseline", config: {} },
          ...body.endpoints.map((id) => ({
            label: treeEndpoints.find((e) => e.id === id)?.name ?? id,
            config: { ...(body.config ?? {}), endpoint_ids: [id] },
          })),
        ],
        rows: [
          {
            source: { conversation_id: body.conversation_id, turn_id: body.turn_id },
            cells: [
              {
                status: "done",
                content: forkIndex >= 0 ? turns[forkIndex].content : null,
                conversation_id: parent.id,
                turn_id: body.turn_id,
              },
              ...body.endpoints.map(() => ({ status: "pending" as const })),
            ],
          },
        ],
      });
    }
    return HttpResponse.json(accepted, { status: 202 });
  }),

  // POST /agenttrees/{tree}/replay (openapi.yaml:586-621) → 202 ReplayAccepted
  // "Work enqueued; run row appears immediately" (openapi.yaml:617).
  http.post(`${BASE}/agenttrees/:tree/replay`, async ({ params, request }) => {
    captureLlmHeaders(request); // P1-T18c
    const body = (await request.json()) as ReplayRequest;
    replayRequests.push({ tree: params.tree as string, body });
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    if ((body.context_policy ?? "frozen") !== "frozen") {
      return HttpResponse.json(
        { code: "invalid", message: "Phase 1 replays always run frozen (openapi.yaml:1540-1546)." },
        { status: 422 },
      );
    }
    const n = ++counters.replay;
    const accepted: ReplayAccepted = { task_id: `task-replay-${n}`, run_id: `run-${n}` };
    // "run row appears immediately and fills incrementally" (openapi.yaml:617)
    // — materialize the run so the detail route can GET it straight after 202:
    // baseline cells done (stored originals), config cells pending.
    mockRuns.unshift({
      id: accepted.run_id,
      tree_id: params.tree as string,
      status: "running",
      created_at: new Date().toISOString(),
      task_id: accepted.task_id,
      label: `Replay · ${body.configs.length} config(s)`,
      columns: [
        { label: "baseline", config: {} },
        ...body.configs.map((cfg, i) => ({ label: configLabel(cfg, i), config: cfg })),
      ],
      rows: runRowsFromSelection(body.selection, body.configs.length),
    });
    return HttpResponse.json(accepted, { status: 202 });
  }),

  // GET /agenttrees/{tree}/runs (openapi.yaml:654-669) — "Runs, newest first
  // (cells omitted; fetch a run for the grid)".
  http.get(`${BASE}/agenttrees/:tree/runs`, ({ params }) => {
    runListRequests.push(params.tree as string);
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    // P2-MSW: "Runs, newest first" is a SERVER rule (openapi.yaml:663;
    // mock/main.py:1291 ORDER BY rowid DESC), so sort here rather than trust
    // the fixture array's order. Stable — equal timestamps keep insert order.
    const items: RunSummaryItem[] = mockRuns
      .filter((r) => r.tree_id === params.tree)
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(({ id, tree_id, status, created_at, task_id, label }) => ({
        id,
        tree_id,
        status,
        created_at,
        task_id,
        label: label ?? null,
      }));
    return HttpResponse.json(items);
  }),

  // GET /agenttrees/{tree}/runs/{runId} (openapi.yaml:671-693) — full grid.
  http.get(`${BASE}/agenttrees/:tree/runs/:runId`, ({ params }) => {
    runDetailRequests.push(params.runId as string);
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    const found = mockRuns.find((r) => r.id === params.runId);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "run not found" }, { status: 404 });
    }
    const { label: _label, ...run } = found; // label is summary-only (openapi.yaml:1605 vs :1607-1618)
    return HttpResponse.json(run);
  }),
];

export function resetRuns() {
  replayRequests.length = 0;
  replayTurnRequests.length = 0;
  mockRuns.length = 0;
  mockRuns.push(...seedRuns());
  runListRequests.length = 0;
  runDetailRequests.length = 0;
}
