// `npm run dump:mockdata` — snapshot the RUNNING demo backend into
// src/test/msw/mockdata.ts, the demo dataset the browser MSW worker
// (src/test/msw/browser.ts) layers on top of the test fixtures.
//
// Why a dump and not hand-written fixtures: the MSW handlers' own fixtures are
// sized for assertions (3 conversations, 2 traces) — enough to prove a screen
// renders, far too little to LOOK like the product. The FastAPI mock seeded by
// mock/generator.py already holds a realistic dataset; this reads it back
// through the public API, exactly as the generator writes it ("writes through
// the public API … never directly to the DB", mock/generator.py:4-6), and
// serialises it as a TS module. Nothing here parses SQLite.
//
// The output is ADDITIVE: tests keep their own fixtures (they assert on ids
// like c1/t9), and mockdata.ts is imported only by browser.ts, never by a
// test. Regenerate it whenever the seed changes; it is a build artifact you
// commit, not a file to hand-edit.
//
// Host comes from agentic.config.ts like every other script (scripts/dev.mjs
// does the same Node-type-stripping import) — no host is written here.
import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "src", "test", "msw", "mockdata.ts");

const { agenticConfig } = await import(
  pathToFileURL(path.join(ROOT, "agentic.config.ts")).href
);

// Which target the bundled demo backend answers on — the same id the app's
// `mock` families resolve through (agentic.config.ts mockTarget, default
// "mock").
const targetId = agenticConfig.mockTarget ?? "mock";
const target = agenticConfig.targets.find((t) => t.id === targetId);
if (!target?.baseUrl) {
  console.error(`No target "${targetId}" with a baseUrl in agentic.config.ts.`);
  process.exit(1);
}
const BASE = target.baseUrl;

// The generator seeds through a live server, and so does this: the mock must
// already be up (`npm run mock`, or `npm start`).
async function get(pathname, params) {
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`GET ${url.pathname}${url.search} -> ${res.status}`);
  }
  // The mock serves the built SPA and answers any unmatched path with
  // index.html rather than a 404 (mock/static.py), so a path the contract
  // does not define comes back 200 text/html. Treat that as absent — parsing
  // it would fail with "Unexpected token '<'".
  if (!res.headers.get("content-type")?.includes("application/json")) return null;
  return res.json();
}

/**
 * Walk a collection.
 *
 * Not every collection in the contract is PAGED — listAgents and listEndpoints
 * answer with a bare array — so a helper that only understands {items, total}
 * silently returns nothing for them. It did, and the demo dataset shipped with
 * zero agents until the Configure step had none to instruct.
 */
async function all(pathname, params) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const body = await get(pathname, { ...params, page, page_size: 100 });
    if (Array.isArray(body)) return body;
    if (!body?.items?.length) break;
    out.push(...body.items);
    if (out.length >= (body.total ?? out.length)) break;
  }
  return out;
}

// Mojibake repair. The seeded rows contain UTF-8 bytes that were decoded once
// as latin-1 somewhere upstream (a pound sign arriving as two characters), and
// they would render that way in the UI too. Re-decoding is attempted ONLY when
// a signature sequence is present AND the result round-trips, so text that is
// merely non-ASCII is left exactly as it came.
const MOJIBAKE = /[ÂÃ][ -¿]|â[]/;
function demojibake(text) {
  if (!MOJIBAKE.test(text)) return text;
  const fixed = Buffer.from(text, "latin1").toString("utf8");
  return fixed.includes("�") ? text : fixed;
}
function repair(value) {
  if (typeof value === "string") return demojibake(value);
  if (Array.isArray(value)) return value.map(repair);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, repair(v)]));
  }
  return value;
}

console.log(`Reading the demo backend at ${BASE} ...`);

const trees = await get("/agenttrees");
const conversationsByTree = {};
const forks = {};
const traces = {};
const spanPayloads = {};
const agents = {};
const instructions = {};
const endpoints = {};
const evaluations = [];

for (const tree of trees) {
  // --- agents + their instruction history
  const treeAgents = await all(`/agenttrees/${tree.id}/agents`);
  agents[tree.id] = treeAgents;
  for (const agent of treeAgents) {
    const history = await get(`/agenttrees/${tree.id}/agents/${agent.id}/instructions`);
    if (history) instructions[agent.id] = history;
  }

  endpoints[tree.id] = (await get(`/agenttrees/${tree.id}/endpoints`)) ?? [];

  // --- conversations, each with its full transcript (the fixture shape is
  // Conversation & {turns}, so the two calls are joined here rather than in
  // the handler).
  const roots = await all(`/agenttrees/${tree.id}/conversations`);
  const withTurns = [];
  for (const row of roots) {
    const turns = await all(`/agenttrees/${tree.id}/conversations/${row.id}/turns`);
    withTurns.push({ ...row, turns });

    if (row.fork_count > 0) {
      const children = await all(`/agenttrees/${tree.id}/conversations`, { forks_of: row.id });
      forks[row.id] = [];
      for (const child of children) {
        const childTurns = await all(`/agenttrees/${tree.id}/conversations/${child.id}/turns`);
        forks[row.id].push({ ...child, turns: childTurns });
      }
    }

    // --- traces hang off assistant turns; span payloads off the spans.
    for (const turn of turns) {
      if (turn.role !== "assistant") continue;
      const trace = await get(`/agenttrees/${tree.id}/turns/${turn.id}/trace`);
      if (!trace) continue;
      traces[turn.id] = trace;
      for (const span of trace.spans ?? []) {
        if (!span.payload_ref) continue;
        const payload = await get(`/spans/${span.payload_ref}/payload`);
        if (payload) spanPayloads[span.payload_ref] = payload;
      }
    }
  }
  conversationsByTree[tree.id] = withTurns;

  // --- evaluations, with their grid rows resolved into the fixture's array
  const summaries = await all(`/agenttrees/${tree.id}/evaluations`);
  for (const summary of summaries) {
    const detail = await get(`/agenttrees/${tree.id}/evaluations/${summary.id}`);
    if (!detail) continue;
    const rows = detail.rows?.items ?? detail.rows ?? [];
    evaluations.push({ ...detail, rows, label: summary.label ?? null });
  }
}

const judgments = await all("/eval/judgments");
const tasks = await all("/tasks");
const rubrics = await all("/eval/rubrics");
const benchmarks = await all("/eval/benchmarks");
const models = (await get("/models")) ?? [];

// Eval cases have NO list operation in the contract (/eval/cases is POST only,
// openapi.yaml:1811) — a case is reached through the benchmark that holds it.
// So the map is built by walking each benchmark's items and fetching the cases
// they name, which is also the only path the UI itself has to them.
const cases = [];
const seenCases = new Set();
for (const benchmark of benchmarks) {
  const items = await all(`/eval/benchmarks/${benchmark.id}/items`);
  for (const item of items) {
    const caseId = item.case_id ?? item.id;
    if (!caseId || seenCases.has(caseId)) continue;
    seenCases.add(caseId);
    const evalCase = await get(`/eval/cases/${caseId}`);
    if (evalCase) cases.push(evalCase);
  }
}

const data = repair({
  trees,
  agents,
  instructions,
  endpoints,
  conversationsByTree,
  forks,
  traces,
  spanPayloads,
  evaluations,
  judgments,
  tasks,
  rubrics,
  benchmarks,
  cases,
  models,
});

const lit = (value) => JSON.stringify(value, null, 2);
const caseMap = Object.fromEntries(data.cases.map((c) => [c.id, c]));
const totalConversations = Object.values(data.conversationsByTree).flat().length;

const source = `// GENERATED by scripts/dump-mockdata.mjs — do not hand-edit.
//
// A snapshot of the seeded demo backend (mock/generator.py, seed 42) read back
// through the public API. This is the dataset the BROWSER MSW worker layers on
// top of the handlers' own fixtures so \`npm run dev:msw\` shows a populated UI
// with no Python running; tests never import it and keep asserting on the
// small hand-written fixtures in ./routes.
//
// Regenerate with: npm run mock (or npm start), then npm run dump:mockdata.
import type {
  Agent,
  AgentTree,
  Endpoint,
  EvalBenchmark,
  EvalCase,
  InstructionHistory,
  Judgment,
  Model,
  Rubric,
  SpanPayload,
  Task,
  Trace,
} from "../../api/types";
import type { ConversationFixture } from "./state";

export const demoTrees: AgentTree[] = ${lit(data.trees)};

export const demoAgents: Record<string, Agent[]> = ${lit(data.agents)};

export const demoInstructions: Record<string, InstructionHistory> = ${lit(data.instructions)};

export const demoEndpoints: Record<string, Endpoint[]> = ${lit(data.endpoints)};

/** Roots per tree — the MSW conversations handler holds ONE list, so
 * src/test/msw/browser.ts pushes these and the handler scopes by tree_id. */
export const demoConversations: Record<string, ConversationFixture[]> = ${lit(data.conversationsByTree)};

export const demoForks: Record<string, ConversationFixture[]> = ${lit(data.forks)};

export const demoTraces: Record<string, Trace> = ${lit(data.traces)};

export const demoSpanPayloads: Record<string, SpanPayload> = ${lit(data.spanPayloads)};

/** Evaluations in the handler's STORED shape (rows as a flat array, plus the
 * summary-only \`label\`), not the paged wire shape the handler builds. */
export const demoEvaluations = ${lit(data.evaluations)};

export const demoJudgments: Judgment[] = ${lit(data.judgments)};

export const demoTasks: Task[] = ${lit(data.tasks)};

export const demoRubrics: Rubric[] = ${lit(data.rubrics)};

export const demoEvalCases: Record<string, EvalCase> = ${lit(caseMap)};

export const demoEvalBenchmarks: EvalBenchmark[] = ${lit(data.benchmarks)};

export const demoModels: Model[] = ${lit(data.models)};
`;

writeFileSync(OUT, source, "utf8");
console.log(
  `Wrote ${path.relative(ROOT, OUT)} - ${data.trees.length} trees, ` +
    `${totalConversations} conversations, ${Object.keys(data.traces).length} traces, ` +
    `${data.evaluations.length} evaluations, ${data.judgments.length} judgments, ` +
    `${data.tasks.length} tasks.`,
);
