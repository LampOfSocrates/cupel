// MSW handlers derived from openapi.yaml v0.2.0 — reused by later tasks.
// Covers: GET /me (openapi.yaml:62), GET /agenttrees (:115), GET /models (:98),
// GET /agenttrees/{tree}/conversations (:335, params search/page/page_size/
// forks_of/agent_id/origin), GET/PATCH/DELETE .../conversations/{id} (:387),
// POST /agenttrees/{tree}/chat (:452-521, SSE task/token/done/error + JSON
// mode), GET /tasks (:747-775) + GET /tasks/{id} (:815-830, children) +
// POST /tasks/{id}/retry-failed (:849-865) + DELETE /tasks/{taskId}
// (:832-847, cancel cascade / stop-generation) (P1-T08),
// POST /feedback (:556-583, appends a type:human Judgment),
// GET /eval/judgments (:956-999, filters + newest first),
// P1-T12b eval: GET /eval/rubrics (:868-886), GET /eval/cases/{id} (:907-929),
// POST /eval/judge (:931-954, 202 TaskRef + capture),
// GET /eval/runs/{id}/summary (:1001-1022),
// GET/POST /agenttrees/{tree}/agents (:175-219, tree view + add sub-agent),
// GET/PUT .../agents/{id}/instructions + POST .../snapshots (:221-293,
// append-only versions + immutable draft snapshots, P1-T10b),
// GET/PUT .../agents/{id}/last-selection (:295-332, per-agent remembered
// selection, P1-T20b).
import { http, HttpResponse } from "msw";
import { BASE } from "../../api/base";
import type {
  Agent,
  AgentCreate,
  AgentTree,
  Attachment,
  ChatRequest,
  ChatResponse,
  Conversation,
  Endpoint,
  EvalCase,
  FeedbackRequest,
  InstructionHistory,
  InstructionSave,
  JudgeRequest,
  Judgment,
  Me,
  Model,
  ReplayAccepted,
  ReplayRequest,
  ReplayTurnAccepted,
  ReplayTurnRequest,
  Rubric,
  Run,
  RunConfig,
  RunScoreSummary,
  RunSummaryItem,
  Selection,
  SelectionItem,
  Snapshot,
  SnapshotCreate,
  Task,
  Turn,
} from "../../api/types";

export const mockMe: Me = {
  user: { id: "dev", name: "Dev User", email: "dev@example.com" },
  permissions: { agent1: ["view", "tune", "evaluate"], agent2: ["view"] },
};

export const mockTrees: AgentTree[] = [
  { id: "agent1", name: "Agent 1", enabled: true },
  { id: "agent2", name: "Agent 2", enabled: true },
];

// GET /agenttrees/{tree}/endpoints (openapi.yaml:154-172, Endpoint :1130-1138
// "an agent deployment/backend target") — ids/names mirror the real mock's
// seed (mock/seed.py:15-18, :28-30).
export const mockEndpoints: Record<string, Endpoint[]> = {
  agent1: [
    { id: "ep_agent1_prod", name: "prod", description: "Production deployment" },
    { id: "ep_agent1_staging", name: "staging", description: "Staging deployment" },
  ],
  agent2: [{ id: "ep_agent2_prod", name: "prod", description: "Production deployment" }],
};
export const endpointsRequests: string[] = []; // tree ids seen by GET endpoints

// GET /models (openapi.yaml:98-112, Model :1102-1107) — mirrors the real
// mock's list (mock/config.py:6-11). Tests count fetches via modelsRequests
// to prove the context fetches once and caches (P1-T05).
export const mockModels: Model[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
  { id: "deepseek-v3", name: "DeepSeek V3" },
  { id: "gemini-flash", name: "Gemini Flash" },
];
export const modelsRequests: string[] = [];

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
let agentCounter = 0;

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
let snapshotCounter = 0;

// GET/PUT .../last-selection (openapi.yaml:295-332) — "Last-used conversation
// selection for this agent"; GET answers "empty items = first-time testing"
// (:311). Per-agent state (feature-spec.md:87 "remembered per agent") + PUT
// capture for exact-body asserts (P1-T20b).
export const mockLastSelections: Record<string, SelectionItem[]> = {};
export const lastSelectionPuts: Array<{ agentId: string; items: SelectionItem[] }> = [];

function findAgent(tree: string, agentId: string): Agent | undefined {
  return mockAgents[tree]?.find((a) => a.id === agentId);
}

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
    // seeded re-fire run below + sibling compare) read its content as the
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
// the endpoint fixtures (T13 flag resolved — the old "prod"/"staging" ids
// never existed in mockEndpoints).
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

// ---------------------------------------------------------- judgments state
// Append-only store, held newest-first (openapi.yaml:994 "Matching judgments,
// newest first") — POST /feedback unshifts; fixtures seed via pushHumanJudgment
// (oldest first, so the newest ends up in front). P1-T12b adds llm judgments.
export const mockJudgments: Judgment[] = [];
export const feedbackRequests: FeedbackRequest[] = [];
export const judgmentRequests: URL[] = [];
let judgmentCounter = 0;

export function pushHumanJudgment(
  turn_id: string,
  conversation_id: string,
  rating: "up" | "down",
  created_at: string,
): Judgment {
  // Judgment type human: rubric/case fields null; score 1 = 👍, 0 = 👎
  // (openapi.yaml:1881-1907).
  const judgment: Judgment = {
    id: `j-${++judgmentCounter}`,
    case_id: null,
    run_id: null,
    turn_id,
    conversation_id,
    type: "human",
    judge_model: null,
    rubric_id: null,
    rubric_version: null,
    score: rating === "up" ? 1 : 0,
    reasoning: null,
    created_at,
  };
  mockJudgments.unshift(judgment);
  return judgment;
}

// P1-T12b seed helper — type llm judgment: "case_id, rubric_id and
// rubric_version are non-null (the judge always runs a rubric against a
// case)" (openapi.yaml:1886-1887). Push OLDEST first: unshift keeps the store
// newest-first (openapi.yaml:994).
export function pushLlmJudgment(
  fields: Partial<Judgment> & Pick<Judgment, "case_id" | "score">,
): Judgment {
  const judgment: Judgment = {
    id: `j-${++judgmentCounter}`,
    run_id: null,
    turn_id: null,
    conversation_id: null,
    type: "llm",
    judge_model: "claude-haiku-4-5",
    rubric_id: "rub-help",
    rubric_version: 2,
    reasoning: null,
    created_at: new Date().toISOString(),
    ...fields,
  };
  mockJudgments.unshift(judgment);
  return judgment;
}

// ------------------------------------------------------------- eval fixtures
// GET /eval/rubrics (openapi.yaml:868-886) — "Latest version of each rubric";
// versioned append-only, editor UI is Phase 2 (:874-875, :890).
function seedRubrics(): Rubric[] {
  return [
    {
      id: "rub-help",
      name: "helpfulness",
      version: 2,
      prompt: "Score 0-1 how helpfully the response resolves the user's request.",
      created_at: "2026-07-10T10:00:00Z",
    },
    {
      id: "rub-acc",
      name: "accuracy",
      version: 1,
      prompt: "Score 0-1 the factual accuracy of the response.",
      created_at: "2026-07-12T10:00:00Z",
    },
  ];
}
export const mockRubrics: Rubric[] = seedRubrics();
export const rubricRequests: string[] = [];

// GET /eval/cases/{caseId} (openapi.yaml:907-929) — "EvalCase = {input,
// output, reference?}" (feature-spec.md:54); case-1 mirrors what judging
// run-old-1 would auto-create from its v3 cell (source c1/t2).
function seedEvalCases(): Record<string, EvalCase> {
  return {
    "case-1": {
      id: "case-1",
      input: { prompt: "How do refunds work?", envelope },
      output: "Refunds arrive within 3 business days.",
      reference: null,
      source: { tree: "agent1", conversation_id: "c1", turn_id: "t2" },
      created_at: "2026-08-03T12:05:00Z",
    },
  };
}
export const mockEvalCases: Record<string, EvalCase> = seedEvalCases();
export const evalCaseRequests: string[] = [];

// POST /eval/judge (openapi.yaml:931-954) — 202 TaskRef; the judging WORK is
// driven by tests (fixture mutation + taskStreamRig), like run live fill.
export const judgeRequests: JudgeRequest[] = [];
let judgeCounter = 0;

// GET /eval/runs/{runId}/summary (openapi.yaml:1001-1022) — mutable per-run
// summaries; unset runs answer the empty aggregate (no judgments yet).
export const mockRunSummaries: Record<string, RunScoreSummary> = {};
export const summaryRequests: string[] = [];

// -------------------------------------------------------------- upload state
// POST /upload knobs (openapi.yaml:523-554). maxBytes mirrors the real mock's
// Phase-1 limit (mock/config.py:15 MAX_UPLOAD_BYTES = 5 MiB) — tests shrink it
// to simulate 413 without building multi-MB files. `gate` (when set) is
// awaited before responding so tests can observe the uploading state.
export const uploadConfig: {
  maxBytes: number;
  gate: (() => Promise<void>) | null;
} = { maxBytes: 5 * 1024 * 1024, gate: null };

export const uploadRequests: Array<{ filename: string; size: number }> = [];
let attachmentCounter = 0;

// ---------------------------------------------------------------- chat state
// Knobs for the chat SSE handler. `gate` (when set) is awaited before each
// token and before done — tests use it to step the stream deterministically.
// `errorAfter` emits an `error` frame after N tokens instead of finishing.
export const chatConfig: {
  tokens: string[];
  delayMs: number;
  gate: (() => Promise<void>) | null;
  errorAfter: number | null;
} = { tokens: ["Hello ", "streaming ", "**world**."], delayMs: 2, gate: null, errorAfter: null };

// --------------------------------------------------------------- replay state
// POST /agenttrees/{tree}/replay(/turn) (openapi.yaml:586-652) — P1-T11a rig,
// reused by P1-T11's Runs flow tests. Both mirror the real mock's Phase-1 pin:
// context_policy other than "frozen" → 422 (mock/main.py:528-529, :605-606;
// openapi.yaml:1540-1546 enum [frozen]).
export const replayRequests: Array<{ tree: string; body: ReplayRequest }> = [];
export const replayTurnRequests: Array<{ tree: string; body: ReplayTurnRequest }> = [];
let replayCounter = 0;

// ----------------------------------------------------------------- runs state
// GET /agenttrees/{tree}/runs (openapi.yaml:654-669, "Runs, newest first") +
// GET …/runs/{runId} (:671-693, Run schema :1607-1643). Stored runs carry a
// label for the SUMMARY shape only (RunSummaryItem :1605 has label; Run does
// not) — the detail handler strips it. Fixtures are MUTABLE: live-fill tests
// mark cells done / flip status, then poke the /tasks/stream rig below;
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
    // c2f1/c2f2 fork fixtures above.
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
  const all = [...mockRoots, ...Object.values(mockForks).flat()];
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

// ---------------------------------------------------------------- task state
// GET /tasks + /tasks/{id} + retry-failed fixtures (openapi.yaml:747-865),
// P1-T08. Parents stored with children INLINE; the list handler strips them
// ("Parents only ... expand via GET /tasks/{id}", openapi.yaml:770-771).
// Mutable — tests flip statuses then poke taskStreamRig; reset reseeds.
function seedTasks(): Task[] {
  return [
    {
      // Running replay batch with a failed child → partial failure
      // (feature-spec.md:110); result.run_id feeds "View results".
      id: "task-seed-replay",
      type: "replay",
      status: "running",
      progress: { done: 1, total: 3, stage: "Conversation 2/3 · turn 1/2" },
      result: { run_id: "run-old-1" },
      created_at: "2026-08-04T10:05:00Z",
      started_at: "2026-08-04T10:05:01Z",
      children: [
        {
          id: "task-seed-replay-c1",
          type: "replay",
          status: "done",
          parent_id: "task-seed-replay",
          progress: { done: 2, total: 2, stage: "conv c1" },
          created_at: "2026-08-04T10:05:00Z",
          started_at: "2026-08-04T10:05:01Z",
          finished_at: "2026-08-04T10:05:20Z",
        },
        {
          id: "task-seed-replay-c2",
          type: "replay",
          status: "running",
          parent_id: "task-seed-replay",
          progress: { done: 1, total: 2, stage: "conv c2" },
          created_at: "2026-08-04T10:05:00Z",
          started_at: "2026-08-04T10:05:21Z",
        },
        {
          id: "task-seed-replay-c3",
          type: "replay",
          status: "failed",
          parent_id: "task-seed-replay",
          progress: { done: 0, total: 2 },
          error: "endpoint returned 502",
          created_at: "2026-08-04T10:05:00Z",
        },
      ],
    },
    {
      // Finished turn fork — result.conversation_id feeds "Open in Chat"
      // (Task.result, openapi.yaml:1744-1752).
      id: "task-seed-fork",
      type: "replay_turn",
      status: "done",
      progress: { done: 1, total: 1 },
      result: { conversation_id: "fork-c1-1", turn_id: "t2" },
      created_at: "2026-08-04T09:00:00Z",
      started_at: "2026-08-04T09:00:01Z",
      finished_at: "2026-08-04T09:00:20Z",
    },
  ];
}
export const mockTasks: Task[] = seedTasks();
export const taskListRequests: string[] = []; // full URLs (polling assertions)
export const taskDetailRequests: string[] = [];
export const retryFailedRequests: string[] = [];

// ---------------------------------------------------------- task stream rig
// GET /tasks/stream (openapi.yaml:777-813) — controllable SSE: tests call
// taskStreamRig.emit("progress"|"task", data) to push frames to every open
// subscriber (same streaming pattern as the T02 chat handler, but held open
// until the client aborts). clients counts open subscriptions so tests can
// await the subscribe before emitting.
const taskStreamClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const sseEncoder = new TextEncoder();

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

export const chatRequests: ChatRequest[] = [];
export const cancelRequests: string[] = []; // task ids seen by DELETE /tasks/{id}
const cancelledTasks = new Set<string>();
let newConvCounter = 0;

export function resetHandlerState() {
  conversationRequests.length = 0;
  endpointsRequests.length = 0;
  modelsRequests.length = 0;
  uploadRequests.length = 0;
  attachmentCounter = 0;
  uploadConfig.maxBytes = 5 * 1024 * 1024;
  uploadConfig.gate = null;
  chatRequests.length = 0;
  cancelRequests.length = 0;
  replayRequests.length = 0;
  replayTurnRequests.length = 0;
  replayCounter = 0;
  mockJudgments.length = 0;
  feedbackRequests.length = 0;
  judgmentRequests.length = 0;
  judgmentCounter = 0;
  cancelledTasks.clear();
  newConvCounter = 0;
  chatConfig.tokens = ["Hello ", "streaming ", "**world**."];
  chatConfig.delayMs = 2;
  chatConfig.gate = null;
  chatConfig.errorAfter = null;
  mockRoots.length = 0;
  mockRoots.push(...seedRoots());
  for (const key of Object.keys(mockForks)) delete mockForks[key];
  Object.assign(mockForks, seedForks());
  agentCreateRequests.length = 0;
  agentCounter = 0;
  for (const key of Object.keys(mockAgents)) delete mockAgents[key];
  Object.assign(mockAgents, seedAgents());
  instructionSaveRequests.length = 0;
  snapshotRequests.length = 0;
  mockSnapshots.length = 0;
  snapshotCounter = 0;
  for (const key of Object.keys(mockLastSelections)) delete mockLastSelections[key];
  lastSelectionPuts.length = 0;
  for (const key of Object.keys(mockInstructions)) delete mockInstructions[key];
  Object.assign(mockInstructions, seedInstructions());
  mockRuns.length = 0;
  mockRuns.push(...seedRuns());
  runListRequests.length = 0;
  runDetailRequests.length = 0;
  mockRubrics.length = 0;
  mockRubrics.push(...seedRubrics());
  rubricRequests.length = 0;
  for (const key of Object.keys(mockEvalCases)) delete mockEvalCases[key];
  Object.assign(mockEvalCases, seedEvalCases());
  evalCaseRequests.length = 0;
  judgeRequests.length = 0;
  judgeCounter = 0;
  for (const key of Object.keys(mockRunSummaries)) delete mockRunSummaries[key];
  summaryRequests.length = 0;
  mockTasks.length = 0;
  mockTasks.push(...seedTasks());
  taskListRequests.length = 0;
  taskDetailRequests.length = 0;
  retryFailedRequests.length = 0;
  taskStreamRig.closeAll();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const handlers = [
  http.get(`${BASE}/me`, () => HttpResponse.json(mockMe)),

  http.get(`${BASE}/agenttrees`, () => HttpResponse.json(mockTrees)),

  // GET /agenttrees/{tree}/endpoints — "Deploy targets for replay"
  // (openapi.yaml:158; feature-spec.md:121).
  http.get(`${BASE}/agenttrees/:tree/endpoints`, ({ params }) => {
    const endpoints = mockEndpoints[params.tree as string];
    if (!endpoints) {
      return HttpResponse.json({ code: "not_found", message: "tree not found" }, { status: 404 });
    }
    endpointsRequests.push(params.tree as string);
    return HttpResponse.json(endpoints);
  }),

  // GET /models (openapi.yaml:98-112) — model dropdown source
  // (feature-spec.md:122).
  http.get(`${BASE}/models`, () => {
    modelsRequests.push("models");
    return HttpResponse.json(mockModels);
  }),

  // GET /agenttrees/{tree}/agents — "Flat list of agents with parent links
  // (root has parent_id null)" (openapi.yaml:188).
  http.get(`${BASE}/agenttrees/:tree/agents`, ({ params }) => {
    const agents = mockAgents[params.tree as string];
    if (!agents) {
      return HttpResponse.json({ code: "not_found", message: "tree not found" }, { status: 404 });
    }
    return HttpResponse.json(agents);
  }),

  // POST /agenttrees/{tree}/agents — 201 "The created agent (live_version 0
  // until v1 is saved)" (openapi.yaml:215); null parent_id = new root
  // (openapi.yaml:1169).
  http.post(`${BASE}/agenttrees/:tree/agents`, async ({ params, request }) => {
    const body = (await request.json()) as AgentCreate;
    agentCreateRequests.push(body);
    const agents = mockAgents[params.tree as string];
    if (!agents) {
      return HttpResponse.json({ code: "not_found", message: "tree not found" }, { status: 404 });
    }
    const agent: Agent = {
      id: `ag-new-${++agentCounter}`,
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
    const agent = findAgent(params.tree as string, params.agentId as string);
    if (!agent) {
      return HttpResponse.json({ code: "not_found", message: "agent not found" }, { status: 404 });
    }
    const body = (await request.json()) as SnapshotCreate;
    snapshotRequests.push({ agentId: agent.id, body });
    const base = body.base_version ?? mockInstructions[agent.id]?.live_version ?? 0;
    const snapshot: Snapshot = {
      snapshot_id: `a3f${++snapshotCounter}`,
      agent_id: agent.id,
      label: `v${base}-draft (a3f${snapshotCounter})`,
      created_at: new Date().toISOString(),
    };
    mockSnapshots.push(snapshot);
    return HttpResponse.json(snapshot, { status: 201 });
  }),

  // GET .../last-selection — "Remembered selection (empty items = first-time
  // testing)" (openapi.yaml:309-311).
  http.get(`${BASE}/agenttrees/:tree/agents/:agentId/last-selection`, ({ params }) => {
    const agent = findAgent(params.tree as string, params.agentId as string);
    if (!agent) {
      return HttpResponse.json({ code: "not_found", message: "agent not found" }, { status: 404 });
    }
    return HttpResponse.json({ items: mockLastSelections[agent.id] ?? [] } satisfies Selection);
  }),

  // PUT .../last-selection — "Remember the conversation selection for this
  // agent" (openapi.yaml:315-317); 200 → "Stored selection" (:329).
  http.put(`${BASE}/agenttrees/:tree/agents/:agentId/last-selection`, async ({ params, request }) => {
    const agent = findAgent(params.tree as string, params.agentId as string);
    if (!agent) {
      return HttpResponse.json({ code: "not_found", message: "agent not found" }, { status: 404 });
    }
    const body = (await request.json()) as Selection;
    lastSelectionPuts.push({ agentId: agent.id, items: body.items });
    mockLastSelections[agent.id] = body.items;
    return HttpResponse.json({ items: body.items } satisfies Selection);
  }),

  http.get(`${BASE}/agenttrees/:tree/conversations`, ({ request }) => {
    const url = new URL(request.url);
    conversationRequests.push(url);
    const forksOf = url.searchParams.get("forks_of");
    const search = url.searchParams.get("search")?.toLowerCase();
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("page_size") ?? 20);

    let items = forksOf ? (mockForks[forksOf] ?? []) : mockRoots;
    // ?agent_id= — "view recent conversations for this agent"
    // (openapi.yaml:365-371).
    const agentId = url.searchParams.get("agent_id");
    if (agentId) items = items.filter((c) => c.agent_id === agentId);
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

  // POST /agenttrees/{tree}/chat (openapi.yaml:452-521): stream=true → SSE
  // frames task/token/done/error; stream=false → single JSON ChatResponse.
  // Omitting conversation_id starts a new conversation (openapi.yaml:488).
  http.post(`${BASE}/agenttrees/:tree/chat`, async ({ request }) => {
    const body = (await request.json()) as ChatRequest;
    chatRequests.push(body);
    const isNew = !body.conversation_id;
    const convId = body.conversation_id ?? `c-new-${++newConvCounter}`;
    const taskId = `task-${convId}`;
    if (isNew) {
      mockRoots.unshift(
        conv({
          id: convId,
          title: body.message.slice(0, 40),
          last_activity_at: new Date().toISOString(),
        }),
      );
    }
    const assistantTurn = (content: string): Turn => ({
      id: `t-a-${taskId}`,
      role: "assistant",
      author: "assistant",
      content,
      created_at: new Date().toISOString(),
      envelope,
    });

    if (body.stream === false) {
      const response: ChatResponse = {
        task_id: taskId,
        conversation_id: convId,
        turn: assistantTurn(chatConfig.tokens.join("")),
      };
      return HttpResponse.json(response);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const frame = (event: string, data: unknown) =>
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        frame("task", {
          task_id: taskId,
          conversation_id: convId,
          user_turn_id: `t-u-${taskId}`,
          assistant_turn_id: `t-a-${taskId}`,
        });
        let sent = "";
        let count = 0;
        for (const token of chatConfig.tokens) {
          await (chatConfig.gate?.() ?? sleep(chatConfig.delayMs));
          if (cancelledTasks.has(taskId)) {
            // done(cancelled) carries the persisted partial content
            // (openapi.yaml:1470).
            frame("done", { status: "cancelled", turn: assistantTurn(sent) });
            controller.close();
            return;
          }
          if (chatConfig.errorAfter !== null && count >= chatConfig.errorAfter) {
            frame("error", { code: "generation_failed", message: "model exploded" });
            controller.close();
            return;
          }
          sent += token;
          count++;
          frame("token", { delta: token });
        }
        await (chatConfig.gate?.() ?? sleep(chatConfig.delayMs));
        frame("done", {
          status: cancelledTasks.has(taskId) ? "cancelled" : "completed",
          turn: assistantTurn(sent),
        });
        controller.close();
      },
    });
    return new HttpResponse(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),

  // POST /upload (openapi.yaml:523-554): multipart {file} → 201 Attachment
  // (url null in Phase 1); oversize → 413 Error, "the UI surfaces the message"
  // (openapi.yaml:535-536). Message mirrors mock/main.py:478-479.
  http.post(`${BASE}/upload`, async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");
    // No instanceof File: the parsed value is undici's File while the jsdom
    // test env's global File is jsdom's — different classes.
    if (!file || typeof file === "string") {
      return HttpResponse.json(
        { code: "bad_request", message: "multipart field 'file' is required" },
        { status: 400 },
      );
    }
    uploadRequests.push({ filename: file.name, size: file.size });
    await uploadConfig.gate?.();
    if (file.size > uploadConfig.maxBytes) {
      return HttpResponse.json(
        {
          code: "too_large",
          message: `File exceeds the ${Math.floor(uploadConfig.maxBytes / (1024 * 1024))} MB upload limit.`,
        },
        { status: 413 },
      );
    }
    const attachment: Attachment = {
      id: `att-${++attachmentCounter}`,
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      size: file.size,
      url: null,
    };
    return HttpResponse.json(attachment, { status: 201 });
  }),

  // POST /feedback (openapi.yaml:556-583): appends a type:human Judgment
  // ("message_id = Turn.id"; append-only — no delete/un-vote endpoint exists).
  http.post(`${BASE}/feedback`, async ({ request }) => {
    const body = (await request.json()) as FeedbackRequest;
    feedbackRequests.push(body);
    const all = [...mockRoots, ...Object.values(mockForks).flat()];
    const owner = all.find((c) => c.turns?.some((t) => t.id === body.message_id));
    const judgment: Judgment = {
      id: `j-fb-${++judgmentCounter}`,
      case_id: null,
      run_id: null,
      turn_id: body.message_id,
      // Streamed turns aren't in the fixtures' turn lists — accept them with a
      // null conversation_id rather than 404ing (the real mock enforces 404).
      conversation_id: owner?.id ?? null,
      type: "human",
      judge_model: null,
      rubric_id: null,
      rubric_version: null,
      score: body.rating === "up" ? 1 : 0,
      reasoning: null,
      created_at: new Date().toISOString(),
    };
    mockJudgments.unshift(judgment);
    return HttpResponse.json(judgment, { status: 201 });
  }),

  // GET /eval/judgments (openapi.yaml:956-999): equality filters, paginated,
  // newest first (store order).
  http.get(`${BASE}/eval/judgments`, ({ request }) => {
    const url = new URL(request.url);
    judgmentRequests.push(url);
    let items = mockJudgments;
    for (const key of ["case_id", "run_id", "rubric_id", "turn_id", "conversation_id"] as const) {
      const value = url.searchParams.get(key);
      if (value) items = items.filter((j) => j[key] === value);
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("page_size") ?? 50);
    return HttpResponse.json(items.slice((page - 1) * pageSize, page * pageSize));
  }),

  // GET /eval/rubrics (openapi.yaml:868-886) — "Latest version of each rubric".
  http.get(`${BASE}/eval/rubrics`, () => {
    rubricRequests.push("rubrics");
    return HttpResponse.json(mockRubrics);
  }),

  // GET /eval/cases/{caseId} (openapi.yaml:907-929) — judgment-drawer case doc.
  http.get(`${BASE}/eval/cases/:caseId`, ({ params }) => {
    const id = params.caseId as string;
    evalCaseRequests.push(id);
    const found = mockEvalCases[id];
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "case not found" }, { status: 404 });
    }
    return HttpResponse.json(found);
  }),

  // POST /eval/judge (openapi.yaml:931-954) — 202 TaskRef "(parent task +
  // child per case)". oneOf run_id/case_ids enforced like the real mock
  // (mock/main.py:841-842); judging results are test-driven via fixture
  // mutation + taskStreamRig, mirroring the live-fill pattern.
  http.post(`${BASE}/eval/judge`, async ({ request }) => {
    const body = (await request.json()) as JudgeRequest;
    judgeRequests.push(body);
    if (!body.judge_model || !body.rubric_id) {
      return HttpResponse.json(
        { code: "invalid", message: "judge_model and rubric_id are required." },
        { status: 422 },
      );
    }
    if (Boolean(body.run_id) === Boolean(body.case_ids)) {
      return HttpResponse.json(
        { code: "invalid", message: "Exactly one of run_id / case_ids is required (openapi.yaml:1865-1867)." },
        { status: 422 },
      );
    }
    return HttpResponse.json({ task_id: `task-judge-${++judgeCounter}` }, { status: 202 });
  }),

  // GET /eval/runs/{runId}/summary (openapi.yaml:1001-1022) — per-rubric
  // aggregates; a run with no judgments answers empty rubrics.
  http.get(`${BASE}/eval/runs/:runId/summary`, ({ params }) => {
    const id = params.runId as string;
    summaryRequests.push(id);
    if (!mockRuns.some((r) => r.id === id)) {
      return HttpResponse.json({ code: "not_found", message: "run not found" }, { status: 404 });
    }
    return HttpResponse.json(mockRunSummaries[id] ?? { run_id: id, rubrics: [] });
  }),

  // POST /agenttrees/{tree}/replay/turn (openapi.yaml:623-652) → 202
  // ReplayTurnAccepted: "one task_id + new conversation_id per endpoint"
  // (feature-spec.md:71); registered before /replay for readability (MSW
  // matches full paths, order is not load-bearing).
  http.post(`${BASE}/agenttrees/:tree/replay/turn`, async ({ params, request }) => {
    const body = (await request.json()) as ReplayTurnRequest;
    replayTurnRequests.push({ tree: params.tree as string, body });
    if ((body.context_policy ?? "frozen") !== "frozen") {
      return HttpResponse.json(
        { code: "invalid", message: "Phase 1 replays always run frozen (openapi.yaml:1570-1574)." },
        { status: 422 },
      );
    }
    const n = ++replayCounter;
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
    const all = [...mockRoots, ...Object.values(mockForks).flat()];
    const parent = all.find((c) => c.id === body.conversation_id);
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
    const body = (await request.json()) as ReplayRequest;
    replayRequests.push({ tree: params.tree as string, body });
    if ((body.context_policy ?? "frozen") !== "frozen") {
      return HttpResponse.json(
        { code: "invalid", message: "Phase 1 replays always run frozen (openapi.yaml:1540-1546)." },
        { status: 422 },
      );
    }
    const n = ++replayCounter;
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
    const items: RunSummaryItem[] = mockRuns
      .filter((r) => r.tree_id === params.tree)
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
    const found = mockRuns.find((r) => r.id === params.runId);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "run not found" }, { status: 404 });
    }
    const { label: _label, ...run } = found; // label is summary-only (openapi.yaml:1605 vs :1607-1618)
    return HttpResponse.json(run);
  }),

  // GET /tasks (openapi.yaml:747-775) — "Tasks, newest first. Parents only
  // (unless parent_id given)"; status/parent_id/limit params (:755-767).
  // Registered before /tasks/:taskId so the static segment wins.
  http.get(`${BASE}/tasks`, ({ request }) => {
    taskListRequests.push(request.url);
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const parentId = url.searchParams.get("parent_id");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    let list: Task[] = parentId
      ? (mockTasks.find((t) => t.id === parentId)?.children ?? [])
      : mockTasks.map(({ children: _children, ...task }) => task);
    if (status) list = list.filter((t) => t.status === status);
    return HttpResponse.json(list.slice(0, limit));
  }),

  // GET /tasks/stream (openapi.yaml:777-813) — held open until the client
  // aborts; frames pushed via taskStreamRig.emit.
  http.get(`${BASE}/tasks/stream`, () => {
    let ctrl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctrl = controller;
        taskStreamClients.add(controller);
        controller.enqueue(sseEncoder.encode(": connected\n\n"));
      },
      cancel() {
        taskStreamClients.delete(ctrl);
      },
    });
    return new HttpResponse(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }),

  // GET /tasks/:taskId (openapi.yaml:815-830) — "Task with children
  // populated" (:826); the queue panel's expand fetch (P1-T08). After the
  // /tasks/stream handler so the static segment matches first.
  http.get(`${BASE}/tasks/:taskId`, ({ params }) => {
    const id = params.taskId as string;
    taskDetailRequests.push(id);
    const found = mockTasks.find((t) => t.id === id);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "task not found" }, { status: 404 });
    }
    return HttpResponse.json({ ...found, children: found.children ?? [] });
  }),

  // POST /tasks/:taskId/retry-failed (openapi.yaml:849-865) — "Failed
  // children re-enqueued; parent task returned" (202, :858-861).
  http.post(`${BASE}/tasks/:taskId/retry-failed`, ({ params }) => {
    const id = params.taskId as string;
    retryFailedRequests.push(id);
    const found = mockTasks.find((t) => t.id === id);
    if (!found) {
      return HttpResponse.json({ code: "not_found", message: "task not found" }, { status: 404 });
    }
    let requeued = 0;
    for (const child of found.children ?? []) {
      if (child.status === "failed") {
        child.status = "queued";
        child.error = null;
        requeued += 1;
      }
    }
    if (requeued > 0) found.status = "running";
    const { children: _children, ...parent } = found;
    return HttpResponse.json(parent, { status: 202 });
  }),

  // DELETE /tasks/{taskId} — cancel; doubles as chat stop-generation
  // (openapi.yaml:832-847). Known queue fixtures cancel with cascade
  // ("cancels queued/running children"); other ids keep the T02 synthetic
  // chat-task response (stop-generation tests).
  http.delete(`${BASE}/tasks/:taskId`, ({ params }) => {
    const id = params.taskId as string;
    cancelRequests.push(id);
    cancelledTasks.add(id);
    const found = mockTasks.find((t) => t.id === id);
    if (found) {
      if (found.status === "queued" || found.status === "running") found.status = "cancelled";
      for (const child of found.children ?? []) {
        if (child.status === "queued" || child.status === "running") child.status = "cancelled";
      }
      const { children: _children, ...task } = found;
      return HttpResponse.json(task);
    }
    const task: Task = {
      id,
      type: "chat",
      status: "cancelled",
      progress: { done: 0, total: 1 },
      created_at: new Date().toISOString(),
    };
    return HttpResponse.json(task);
  }),
];
