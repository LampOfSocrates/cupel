// The agent tree and everything hanging off an agent: instructions (append-only
// versions), immutable draft snapshots, and the remembered test selection.
import { http, HttpResponse } from "msw";
import type {
  Agent,
  AgentCreate,
  InstructionHistory,
  InstructionSave,
  Selection,
  SelectionItem,
  Snapshot,
  SnapshotCreate,
} from "../../../api/types";
import { BASE, counters, enabledTreeGate, treeGate } from "../state";

// GET/POST /agenttrees/{tree}/agents (openapi.yaml:175-219, Agent :1141-1164).
// Fixtures mirror the real mock's bootstrap hierarchy (mock/seed.py:19-34):
// agent1 Concierge → Refunds/Shipping, agent2 Ops → Deploys. Tests may mutate
// (e.g. flip enabled) — resetHandlerState restores from the factory.
function seedAgents(): Record<string, Agent[]> {
  return {
    agent1: [
      { id: "ag_concierge", name: "Concierge", parent_id: null, live_version: 3, tools: ["search_kb"], enabled: true, format: "text" },
      { id: "ag_refunds", name: "Refunds", parent_id: "ag_concierge", live_version: 1, tools: ["lookup_order", "refund"], enabled: true, format: "text" },
      { id: "ag_shipping", name: "Shipping", parent_id: "ag_concierge", live_version: 1, tools: ["track_parcel"], enabled: true, format: "text" },
    ],
    agent2: [
      { id: "ag_ops", name: "Ops", parent_id: null, live_version: 2, tools: ["run_query"], enabled: true, format: "text" },
      { id: "ag_deploys", name: "Deploys", parent_id: "ag_ops", live_version: 1, tools: ["rollout_status"], enabled: true, format: "text" },
    ],
  };
}
export const mockAgents: Record<string, Agent[]> = seedAgents();
export const agentCreateRequests: AgentCreate[] = [];

// ------------------------------------------------- instructions + snapshots
// GET/PUT .../instructions (openapi.yaml:221-266) + POST .../snapshots
// (:268-293). Versions ascending, append-only (openapi.yaml:1203); PUT never
// overwrites — appends live_version+1 and moves the live pointer. Fixture
// versions mirror the real mock's seed shape (mock/seed.py:39-44) with line
// changes between versions so diff tests have real hunks.
function seedInstructions(): Record<string, InstructionHistory> {
  const v = (
    version: number,
    content: string,
    created_at: string,
  ) => ({ version, content, format: "text" as const, created_at, promoted_from_snapshot_id: null });
  return {
    ag_concierge: {
      agent_id: "ag_concierge",
      format: "text",
      live_version: 3,
      versions: [
        v(1, "You are Concierge.\nBe brief.", "2026-07-01T10:00:00Z"),
        v(2, "You are Concierge.\nBe brief.\nEscalate refunds to the Refunds agent.", "2026-07-15T10:00:00Z"),
        v(3, "You are Concierge.\nBe polite and brief.\nEscalate refunds to the Refunds agent.", "2026-08-01T10:00:00Z"),
      ],
    },
    ag_refunds: {
      agent_id: "ag_refunds",
      format: "text",
      live_version: 1,
      versions: [v(1, "You are Refunds.\nEscalate disputes over £100.", "2026-07-01T10:00:00Z")],
    },
    ag_shipping: {
      agent_id: "ag_shipping",
      format: "text",
      live_version: 1,
      versions: [v(1, "You are Shipping.\nTrack parcels.", "2026-07-01T10:00:00Z")],
    },
    ag_ops: {
      agent_id: "ag_ops",
      format: "text",
      live_version: 2,
      versions: [
        v(1, "You are Ops.", "2026-07-01T10:00:00Z"),
        v(2, "You are Ops.\nRun queries carefully.", "2026-07-20T10:00:00Z"),
      ],
    },
    ag_deploys: {
      agent_id: "ag_deploys",
      format: "text",
      live_version: 1,
      versions: [v(1, "You are Deploys.", "2026-07-01T10:00:00Z")],
    },
  };
}
export const mockInstructions: Record<string, InstructionHistory> = seedInstructions();
export const instructionSaveRequests: Array<{ agentId: string; body: InstructionSave }> = [];
export const snapshotRequests: Array<{ agentId: string; body: SnapshotCreate }> = [];
export const mockSnapshots: Snapshot[] = []; // append-only — nothing deletes

// GET/PUT .../last-selection (openapi.yaml:295-332) — "Last-used conversation
// selection for this agent"; GET answers "empty items = first-time testing"
// (:311). Per-agent state (feature-spec.md:87 "remembered per agent") + PUT
// capture for exact-body asserts.
export const mockLastSelections: Record<string, SelectionItem[]> = {};
export const lastSelectionPuts: Array<{ agentId: string; items: SelectionItem[] }> = [];

function findAgent(tree: string, agentId: string): Agent | undefined {
  return mockAgents[tree]?.find((a) => a.id === agentId);
}

export const agentHandlers = [
  // GET /agenttrees/{tree}/agents — "Flat list of agents with parent links
  // (root has parent_id null)" (openapi.yaml:188).
  http.get(`${BASE}/agenttrees/:tree/agents`, ({ params }) => {
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    return HttpResponse.json(mockAgents[params.tree as string] ?? []);
  }),

  // POST /agenttrees/{tree}/agents — 201 "The created agent (live_version 0
  // until v1 is saved)" (openapi.yaml:215); null parent_id = new root
  // (openapi.yaml:1169).
  http.post(`${BASE}/agenttrees/:tree/agents`, async ({ params, request }) => {
    const body = (await request.json()) as AgentCreate;
    agentCreateRequests.push(body);
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    const agents = (mockAgents[params.tree as string] ??= []);
    const agent: Agent = {
      id: `ag-new-${++counters.agent}`,
      name: body.name,
      parent_id: body.parent_id ?? null,
      live_version: 0,
      tools: body.tools ?? [],
      enabled: true,
      format: body.format ?? "text",
    };
    agents.push(agent);
    return HttpResponse.json(agent, { status: 201 });
  }),

  // GET .../instructions — "Live version pointer plus full version history
  // (for diff/rollback)" (openapi.yaml:235). Agents with no saved versions
  // yet get live_version 0 + empty versions (openapi.yaml:215).
  http.get(`${BASE}/agenttrees/:tree/agents/:agentId/instructions`, ({ params }) => {
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    const agent = findAgent(params.tree as string, params.agentId as string);
    if (!agent) {
      return HttpResponse.json({ code: "not_found", message: "agent not found" }, { status: 404 });
    }
    const history = mockInstructions[agent.id] ?? {
      agent_id: agent.id,
      format: agent.format,
      live_version: 0,
      versions: [],
    };
    return HttpResponse.json(history);
  }),

  // PUT .../instructions — appends a new version, never overwrites
  // (openapi.yaml:243); 201 = "The newly created version (now live)" (:262);
  // snapshot_id promotes a draft (:245-249) → promoted_from_snapshot_id set.
  http.put(`${BASE}/agenttrees/:tree/agents/:agentId/instructions`, async ({ params, request }) => {
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    const agent = findAgent(params.tree as string, params.agentId as string);
    if (!agent) {
      return HttpResponse.json({ code: "not_found", message: "agent not found" }, { status: 404 });
    }
    const body = (await request.json()) as InstructionSave;
    instructionSaveRequests.push({ agentId: agent.id, body });
    const history =
      mockInstructions[agent.id] ??
      (mockInstructions[agent.id] = {
        agent_id: agent.id,
        format: agent.format,
        live_version: 0,
        versions: [],
      });
    const version = {
      version: history.live_version + 1,
      content: body.content,
      format: body.format ?? history.format,
      created_at: new Date().toISOString(),
      promoted_from_snapshot_id: body.snapshot_id ?? null,
    };
    history.versions.push(version);
    history.live_version = version.version;
    history.format = version.format;
    return HttpResponse.json(version, { status: 201 });
  }),

  // POST .../snapshots — "Immutable draft snapshot" (openapi.yaml:272); label
  // format "v15-draft (a3f2)" (openapi.yaml:1237, feature-spec.md:86); ids
  // mirror the real mock's 4-char form (mock/main.py:275).
  http.post(`${BASE}/agenttrees/:tree/agents/:agentId/snapshots`, async ({ params, request }) => {
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    const agent = findAgent(params.tree as string, params.agentId as string);
    if (!agent) {
      return HttpResponse.json({ code: "not_found", message: "agent not found" }, { status: 404 });
    }
    const body = (await request.json()) as SnapshotCreate;
    snapshotRequests.push({ agentId: agent.id, body });
    const base = body.base_version ?? mockInstructions[agent.id]?.live_version ?? 0;
    const snapshot: Snapshot = {
      snapshot_id: `a3f${++counters.snapshot}`,
      agent_id: agent.id,
      label: `v${base}-draft (a3f${counters.snapshot})`,
      created_at: new Date().toISOString(),
    };
    mockSnapshots.push(snapshot);
    return HttpResponse.json(snapshot, { status: 201 });
  }),

  // GET .../last-selection — "Remembered selection (empty items = first-time
  // testing)" (openapi.yaml:309-311).
  http.get(`${BASE}/agenttrees/:tree/agents/:agentId/last-selection`, ({ params }) => {
    const denied = treeGate(params.tree as string);
    if (denied) return denied;
    const agent = findAgent(params.tree as string, params.agentId as string);
    if (!agent) {
      return HttpResponse.json({ code: "not_found", message: "agent not found" }, { status: 404 });
    }
    return HttpResponse.json({ items: mockLastSelections[agent.id] ?? [] } satisfies Selection);
  }),

  // PUT .../last-selection — "Remember the conversation selection for this
  // agent" (openapi.yaml:315-317); 200 → "Stored selection" (:329).
  http.put(`${BASE}/agenttrees/:tree/agents/:agentId/last-selection`, async ({ params, request }) => {
    const denied = enabledTreeGate(params.tree as string);
    if (denied) return denied;
    const agent = findAgent(params.tree as string, params.agentId as string);
    if (!agent) {
      return HttpResponse.json({ code: "not_found", message: "agent not found" }, { status: 404 });
    }
    const body = (await request.json()) as Selection;
    lastSelectionPuts.push({ agentId: agent.id, items: body.items });
    mockLastSelections[agent.id] = body.items;
    return HttpResponse.json({ items: body.items } satisfies Selection);
  }),
];

export function resetAgents() {
  agentCreateRequests.length = 0;
  for (const key of Object.keys(mockAgents)) delete mockAgents[key];
  Object.assign(mockAgents, seedAgents());
  instructionSaveRequests.length = 0;
  snapshotRequests.length = 0;
  mockSnapshots.length = 0;
  for (const key of Object.keys(mockLastSelections)) delete mockLastSelections[key];
  lastSelectionPuts.length = 0;
  for (const key of Object.keys(mockInstructions)) delete mockInstructions[key];
  Object.assign(mockInstructions, seedInstructions());
}
