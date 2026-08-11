// Eval workbench: rubrics, cases (incl. CSV import), benchmarks, the judge
// trigger and per-evaluation score summaries. Mirrors the real mock's rules —
// append-only versions (latest wins), full-membership benchmark versions, and
// per-row import errors that never abort the batch.
import { http, HttpResponse } from "msw";
import type {
  EvalCase,
  EvalCaseCreate,
  EvalCaseImportReport,
  EvalCaseUpdate,
  EvalBenchmark,
  EvalBenchmarkCreate,
  EvalBenchmarkFreezeRequest,
  EvalBenchmarkItem,
  EvalBenchmarkItemCreate,
  EvalBenchmarkMetadataUpdate,
  EvalBenchmarkReplayRequest,
  EvalBenchmarkUpdate,
  JudgeRequest,
  Rubric,
  RubricCreate,
  RubricUpdate,
  EvaluationScoreSummary,
} from "../../../api/types";
import {
  apiError,
  BASE,
  captureLlmHeaders,
  counters,
  enabledTreeGate,
  envelope,
  pageOf,
} from "../state";
import { mockEvaluations } from "./evaluations";
import { mockTasks } from "./tasks";

// ------------------------------------------------------------- eval fixtures
// GET /eval/rubrics — "Latest version of each rubric"; versioned append-only.
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

// GET /eval/cases/{caseId} — "EvalCase = {input, output, reference?}"
// (feature-spec.md:54); case-1 mirrors what judging evaluation-old-1 would
// auto-create from its v3 cell (source c1/t2).
function seedEvalCases(): Record<string, EvalCase> {
  return {
    "case-1": {
      id: "case-1",
      input: { prompt: "How do refunds work?", envelope },
      output: "Refunds arrive within 3 business days.",
      reference: null,
      source: { tree: "agent1", conversation_id: "c1", turn_id: "t2" },
      agenttree: "agent1",
      // Cases are versioned append-only server-side and every stored
      // case carries one (mock/main.py latest_case ORDER BY version DESC) —
      // the fixture omitted it, so a PUT's "version + 1" had nothing to build on.
      version: 1,
      created_at: "2026-08-03T12:05:00Z",
    },
  };
}
export const mockEvalCases: Record<string, EvalCase> = seedEvalCases();
export const evalCaseRequests: string[] = [];

// POST /eval/judge — 202 TaskRef; the judging WORK is driven by tests
// (fixture mutation + taskStreamRig), like evaluation live fill.
export const judgeRequests: JudgeRequest[] = [];

// ------------------------------------------------------ eval workbench
// POST /eval/cases, GET /eval/cases/{caseId}, GET/POST /eval/benchmarks,
// GET/PATCH/DELETE /eval/benchmarks/{benchmarkId}, POST /eval/cases/import,
// and the three append-only version sub-collections — POST
// /eval/cases/{id}/versions, POST /eval/benchmarks/{id}/versions,
// POST /eval/rubrics/{id}/versions.
export const evalCaseCreates: unknown[] = [];
export const evalCaseVersionPosts: Array<{ caseId: string; body: unknown }> = [];
export const evalBenchmarkCreates: unknown[] = [];
export const evalBenchmarkVersionPosts: Array<{ benchmarkId: string; body: unknown }> = [];
export const evalBenchmarkPatches: Array<{ benchmarkId: string; body: EvalBenchmarkMetadataUpdate }> = [];
export const evalBenchmarkDeletes: string[] = [];
export const evalBenchmarkItemPosts: Array<{ benchmarkId: string; body: EvalBenchmarkItemCreate }> = [];
export const evalBenchmarkFreezes: Array<{ benchmarkId: string; body: EvalBenchmarkFreezeRequest }> = [];
export const evalBenchmarkReplays: Array<{ benchmarkId: string; body: EvalBenchmarkReplayRequest }> = [];
export const rubricCreates: unknown[] = [];
export const rubricVersionPosts: Array<{ rubricId: string; body: unknown }> = [];
export const importRequests: Array<{
  filename: string;
  agenttree: string;
  mapping: string;
  benchmark_id: string | null;
  benchmark_name: string | null;
}> = [];

// Two benchmarks, one of each member kind — the merge's whole point is that
// both live in the same collection: "refund-fails" holds a FROZEN case,
// "Refund misses" holds a turn REFERENCE (what a casebook used to be).
function seedEvalBenchmarks(): EvalBenchmark[] {
  return [
    {
      id: "set-refunds",
      name: "refund-fails",
      description: null,
      version: 3,
      items: [
        {
          id: "esi-1",
          kind: "frozen",
          source: null,
          case_id: "case-1",
          note: null,
          added_at: "2026-08-03T12:00:00Z",
        },
      ],
      created_at: "2026-08-03T12:00:00Z",
    },
    {
      id: "set-misses",
      name: "Refund misses",
      description: null,
      version: 2,
      items: [
        {
          id: "esi-2",
          kind: "reference",
          source: { tree: "agent1", conversation_id: "c1", turn_id: "t2" },
          case_id: null,
          note: "hedged answer",
          added_at: "2026-08-04T10:01:00Z",
        },
      ],
      created_at: "2026-08-04T10:01:00Z",
    },
  ];
}
export const mockEvalBenchmarks: EvalBenchmark[] = seedEvalBenchmarks();

// What an item POINTS AT — the key the server carries ids forward on and the
// one that makes POST …/items idempotent (mock/main.py referent()).
function referent(item: EvalBenchmarkItem | EvalBenchmarkItemCreate): string {
  if ("case_id" in item && item.case_id) return `case:${item.case_id}`;
  const s = (item as EvalBenchmarkItem).source!;
  return `turn:${s.tree}/${s.conversation_id}/${s.turn_id}`;
}

function toItem(input: EvalBenchmarkItemCreate): EvalBenchmarkItem {
  const frozen = "case_id" in input && Boolean(input.case_id);
  return {
    id: `esi-new-${++counters.evalBenchmarkItem}`,
    kind: frozen ? "frozen" : "reference",
    source: frozen ? null : (input as { source: EvalBenchmarkItem["source"] }).source,
    case_id: frozen ? (input as { case_id: string }).case_id : null,
    note: input.note ?? null,
    added_at: "2026-08-06T10:00:00Z",
  };
}

// Import knob: `queued` flips the endpoint to the 202 path so tests can drive
// "Above the server's size threshold: 202 TaskRef" without building a
// 200-row fixture; `report` is what the 200 path returns.
export const importConfig: {
  queued: boolean;
  report: EvalCaseImportReport;
} = {
  queued: false,
  report: {
    benchmark_id: null,
    rows_total: 3,
    rows_imported: 2,
    created_case_ids: ["case-imp-1", "case-imp-2"],
    errors: [{ row: 2, field: "answer", message: "output is empty — a case needs a candidate response." }],
  },
};

// GET /eval/evaluations/{evaluationId}/summary (getEvaluationScoreSummary) — mutable per-evaluation
// summaries; unset evaluations answer the empty aggregate (no judgments yet).
export const mockEvaluationSummaries: Record<string, EvaluationScoreSummary> = {};
export const summaryRequests: string[] = [];

export const evalHandlers = [
  // GET /eval/rubrics — "Latest version of each rubric".
  http.get(`${BASE}/eval/rubrics`, ({ request }) => {
    rubricRequests.push("rubrics");
    return HttpResponse.json(pageOf(mockRubrics, new URL(request.url), 50));
  }),

  // POST /eval/rubrics — "new name = v1"; an existing name appends the next
  // version.
  http.post(`${BASE}/eval/rubrics`, async ({ request }) => {
    const body = (await request.json()) as RubricCreate;
    rubricCreates.push(body);
    if (!body?.name || !body?.prompt) {
      return apiError("invalid", "name and prompt are required.", 422);
    }
    const existing = mockRubrics.find((r) => r.name === body.name);
    const created: Rubric = {
      id: existing?.id ?? `rub-new-${++counters.rubric}`,
      name: body.name,
      version: (existing?.version ?? 0) + 1,
      prompt: body.prompt,
      created_at: "2026-08-06T10:00:00Z",
    };
    if (existing) Object.assign(existing, created);
    else mockRubrics.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  // POST /eval/rubrics/{rubricId}/versions (createRubricVersion) — "Appends
  // the next version of this rubric id — never overwrites"; 201 = the new
  // version.
  http.post(`${BASE}/eval/rubrics/:rubricId/versions`, async ({ params, request }) => {
    const rubricId = params.rubricId as string;
    const body = (await request.json()) as RubricUpdate;
    rubricVersionPosts.push({ rubricId, body });
    const existing = mockRubrics.find((r) => r.id === rubricId);
    if (!existing) {
      return apiError("not_found", "rubric not found", 404);
    }
    if (!body?.prompt) {
      return apiError("invalid", "prompt is required.", 422);
    }
    existing.version += 1;
    existing.prompt = body.prompt;
    return HttpResponse.json(existing, { status: 201 });
  }),

  // POST /eval/cases/import — multipart; 200 with the per-row report inline,
  // or 202 TaskRef above the server's threshold (importConfig.queued drives
  // the branch). Registered BEFORE /eval/cases/:caseId so the literal path
  // wins.
  http.post(`${BASE}/eval/cases/import`, async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file") as File | null;
    importRequests.push({
      filename: file?.name ?? "",
      agenttree: String(form.get("agenttree") ?? ""),
      mapping: String(form.get("mapping") ?? ""),
      benchmark_id: (form.get("benchmark_id") as string | null) ?? null,
      benchmark_name: (form.get("benchmark_name") as string | null) ?? null,
    });
    if (importConfig.queued) {
      return HttpResponse.json({ task_id: `task-import-${++counters.evalImport}` }, { status: 202 });
    }
    return HttpResponse.json(importConfig.report, { status: 200 });
  }),

  // POST /eval/cases — oneOf: (input + output) or source; the sourced mode
  // derives input/output server-side. agenttree is required regardless of
  // mode.
  http.post(`${BASE}/eval/cases`, async ({ request }) => {
    const body = (await request.json()) as EvalCaseCreate;
    evalCaseCreates.push(body);
    if (!("agenttree" in body) || !body.agenttree) {
      return apiError("invalid", "agenttree is required.", 422);
    }
    const sourced = "source" in body && Boolean(body.source);
    const handcrafted = "input" in body && Boolean(body.input);
    if (sourced === handcrafted) {
      return apiError("invalid", "Exactly one of (input + output) / source is required.", 422);
    }
    const id = `case-new-${++counters.evalCase}`;
    const created: EvalCase = sourced
      ? {
          id,
          input: { prompt: "Derived prompt from the sourced turn", envelope },
          output: "Derived response from the sourced turn",
          reference: (body as { reference?: string | null }).reference ?? null,
          source: (body as { source: EvalCase["source"] }).source,
          agenttree: body.agenttree,
          version: 1,
          created_at: "2026-08-06T10:00:00Z",
        }
      : {
          id,
          input: (body as { input: EvalCase["input"] }).input,
          output: (body as { output: string }).output,
          reference: (body as { reference?: string | null }).reference ?? null,
          source: null,
          agenttree: body.agenttree,
          version: 1,
          created_at: "2026-08-06T10:00:00Z",
        };
    mockEvalCases[id] = created;
    return HttpResponse.json(created, { status: 201 });
  }),

  // GET /eval/benchmarks — "Latest version of every benchmark, items included".
  http.get(`${BASE}/eval/benchmarks`, ({ request }) =>
    HttpResponse.json(pageOf(mockEvalBenchmarks, new URL(request.url))),
  ),

  // POST /eval/benchmarks — created at version 1.
  http.post(`${BASE}/eval/benchmarks`, async ({ request }) => {
    const body = (await request.json()) as EvalBenchmarkCreate;
    evalBenchmarkCreates.push(body);
    if (!body?.name) {
      return apiError("invalid", "name is required.", 422);
    }
    const created: EvalBenchmark = {
      id: `set-new-${++counters.evalBenchmark}`,
      name: body.name,
      description: body.description ?? null,
      version: 1,
      items: (body.items ?? []).map(toItem),
      created_at: "2026-08-06T10:00:00Z",
    };
    mockEvalBenchmarks.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  // POST /eval/benchmarks/{benchmarkId}/items — the ⊞ action. Appends a
  // membership version, and is IDEMPOTENT: re-adding a referent the latest
  // version already holds returns that version UNCHANGED (same rule as
  // mock/main.py add_benchmark_item).
  http.post(`${BASE}/eval/benchmarks/:benchmarkId/items`, async ({ params, request }) => {
    const benchmarkId = params.benchmarkId as string;
    const body = (await request.json()) as EvalBenchmarkItemCreate;
    evalBenchmarkItemPosts.push({ benchmarkId, body });
    const existing = mockEvalBenchmarks.find((b) => b.id === benchmarkId);
    if (!existing) {
      return apiError("not_found", "benchmark not found", 404);
    }
    const item = toItem(body);
    if (existing.items.some((i) => referent(i) === referent(item))) {
      return HttpResponse.json(existing, { status: 201 });
    }
    existing.version += 1;
    existing.items = [...existing.items, item];
    return HttpResponse.json(existing, { status: 201 });
  }),

  // POST /eval/benchmarks/{benchmarkId}/freeze — reference items flip to
  // frozen in place, keeping their id and source; omitted item_ids means
  // every reference item.
  http.post(`${BASE}/eval/benchmarks/:benchmarkId/freeze`, async ({ params, request }) => {
    const benchmarkId = params.benchmarkId as string;
    const body = (await request.json()) as EvalBenchmarkFreezeRequest;
    evalBenchmarkFreezes.push({ benchmarkId, body });
    const existing = mockEvalBenchmarks.find((b) => b.id === benchmarkId);
    if (!existing) {
      return apiError("not_found", "benchmark not found", 404);
    }
    const wanted = body?.item_ids ?? null;
    const targets = existing.items.filter(
      (i) => i.kind === "reference" && (wanted === null || wanted.includes(i.id)),
    );
    if (targets.length === 0) {
      return apiError("invalid", "No reference items to freeze.", 422);
    }
    existing.version += 1;
    existing.items = existing.items.map((i) =>
      targets.includes(i)
        ? { ...i, kind: "frozen" as const, case_id: `case-for-${i.source?.turn_id}` }
        : i,
    );
    return HttpResponse.json(existing, { status: 201 });
  }),

  // POST /eval/benchmarks/{benchmarkId}/replay — 202
  // EvalBenchmarkReplayAccepted, "one evaluation per tree the benchmark's
  // reference items touch … all children of a single parent task"; frozen
  // items contribute no tree.
  http.post(`${BASE}/eval/benchmarks/:benchmarkId/replay`, async ({ params, request }) => {
    const benchmarkId = params.benchmarkId as string;
    const body = (await request.json()) as EvalBenchmarkReplayRequest;
    evalBenchmarkReplays.push({ benchmarkId, body });
    const existing = mockEvalBenchmarks.find((b) => b.id === benchmarkId);
    if (!existing) {
      return apiError("not_found", "benchmark not found", 404);
    }
    counters.replay += 1;
    const trees = [
      ...new Set(
        existing.items.filter((i) => i.kind === "reference").map((i) => i.source!.tree),
      ),
    ];
    if (trees.length === 0) {
      return apiError("invalid", "This benchmark has no turn references to replay.", 422);
    }
    return HttpResponse.json(
      {
        task_id: `task-set-${counters.replay}`,
        evaluations: trees.map((tree_id, i) => ({
          tree_id,
          evaluation_id: `evaluation-set-${counters.replay}-${i + 1}`,
        })),
      },
      { status: 202 },
    );
  }),

  // GET /eval/benchmarks/{benchmarkId} — the benchmark with its items (latest
  // version).
  http.get(`${BASE}/eval/benchmarks/:benchmarkId`, ({ params }) => {
    const found = mockEvalBenchmarks.find((b) => b.id === params.benchmarkId);
    if (!found) {
      return apiError("not_found", "benchmark not found", 404);
    }
    return HttpResponse.json(found);
  }),

  // PATCH /eval/benchmarks/{benchmarkId} — metadata only, and NOT a new
  // version.
  http.patch(`${BASE}/eval/benchmarks/:benchmarkId`, async ({ params, request }) => {
    const benchmarkId = params.benchmarkId as string;
    const body = (await request.json()) as EvalBenchmarkMetadataUpdate;
    evalBenchmarkPatches.push({ benchmarkId, body });
    const existing = mockEvalBenchmarks.find((b) => b.id === benchmarkId);
    if (!existing) {
      return apiError("not_found", "benchmark not found", 404);
    }
    if (body.name) existing.name = body.name;
    if (body.description !== undefined) existing.description = body.description;
    return HttpResponse.json(existing);
  }),

  // POST /eval/benchmarks/{benchmarkId}/versions (createEvalBenchmarkVersion)
  // — "each save is a new version carrying its FULL item list"; 201 = the
  // new version. Item ids follow their referent across versions, as the real
  // mock does.
  http.post(`${BASE}/eval/benchmarks/:benchmarkId/versions`, async ({ params, request }) => {
    const benchmarkId = params.benchmarkId as string;
    const body = (await request.json()) as EvalBenchmarkUpdate;
    evalBenchmarkVersionPosts.push({ benchmarkId, body });
    const existing = mockEvalBenchmarks.find((b) => b.id === benchmarkId);
    if (!existing) {
      return apiError("not_found", "benchmark not found", 404);
    }
    if (!body || body.items == null) {
      return apiError("invalid", "items is required.", 422);
    }
    existing.version += 1;
    existing.items = body.items.map((input) => {
      const built = toItem(input);
      const kept = existing.items.find((i) => referent(i) === referent(built));
      return kept ? { ...built, id: kept.id, added_at: kept.added_at } : built;
    });
    return HttpResponse.json(existing, { status: 201 });
  }),

  // DELETE /eval/benchmarks/{benchmarkId} — "Deleting a benchmark never
  // deletes evidence".
  http.delete(`${BASE}/eval/benchmarks/:benchmarkId`, ({ params }) => {
    const benchmarkId = params.benchmarkId as string;
    evalBenchmarkDeletes.push(benchmarkId);
    const index = mockEvalBenchmarks.findIndex((b) => b.id === benchmarkId);
    if (index < 0) {
      return apiError("not_found", "benchmark not found", 404);
    }
    mockEvalBenchmarks.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // GET /eval/cases/{caseId} — judgment-drawer case doc.
  http.get(`${BASE}/eval/cases/:caseId`, ({ params }) => {
    const id = params.caseId as string;
    evalCaseRequests.push(id);
    const found = mockEvalCases[id];
    if (!found) {
      return apiError("not_found", "case not found", 404);
    }
    return HttpResponse.json(found);
  }),

  // POST /eval/cases/{caseId}/versions (createEvalCaseVersion) — "each save
  // appends the next version, never overwrites"; 201 = the new version (now
  // latest). agenttree is not accepted here — it carries over unchanged.
  http.post(`${BASE}/eval/cases/:caseId/versions`, async ({ params, request }) => {
    const caseId = params.caseId as string;
    const body = (await request.json()) as EvalCaseUpdate;
    evalCaseVersionPosts.push({ caseId, body });
    const existing = mockEvalCases[caseId];
    if (!existing) {
      return apiError("not_found", "case not found", 404);
    }
    if (!body?.input?.prompt || body.output == null) {
      return apiError("invalid", "input.prompt and output are required.", 422);
    }
    const next: EvalCase = {
      ...existing,
      input: body.input,
      output: body.output,
      reference: body.reference ?? null,
      version: (existing.version ?? 1) + 1,
    };
    mockEvalCases[caseId] = next;
    return HttpResponse.json(next, { status: 201 });
  }),

  // POST /eval/judge — 202 TaskRef "(parent task + child per case)". oneOf
  // evaluation_id/case_ids/benchmark_id enforced like the real mock; judging
  // results are test-driven via fixture mutation + taskStreamRig, mirroring
  // the live-fill pattern.
  http.post(`${BASE}/eval/judge`, async ({ request }) => {
    captureLlmHeaders(request);
    const body = (await request.json()) as JudgeRequest;
    judgeRequests.push(body);
    if (!body.judge_model || !body.rubric_id) {
      return apiError("invalid", "judge_model and rubric_id are required.", 422, [
        { field: "rubric_id", message: "judge_model and rubric_id are required." },
      ]);
    }
    // v0.3.0 widened the oneOf to evaluation_id | case_ids | benchmark_id,
    // matching mock/main.py's judge handler.
    const selectors = [body.evaluation_id, body.case_ids, body.benchmark_id].filter(
      Boolean,
    ).length;
    if (selectors !== 1) {
      return apiError(
        "invalid",
        "Exactly one of evaluation_id / case_ids / benchmark_id is required.",
        422,
        // mock/main.py names the same field on the same complaint — details is
        // the machine half of "which selector", not a second sentence.
        [{ field: "evaluation_id", message: "Exactly one selector is required." }],
      );
    }
    // Disable rule for judge, mirroring mock/main.py's judge handler exactly:
    // judging is blocked when the RUN'S tree is disabled; case_ids/
    // benchmark_id judging is NOT tree-gated (eval cases are global,
    // feature-spec.md:111).
    if (body.evaluation_id) {
      const evaluation = mockEvaluations.find((r) => r.id === body.evaluation_id);
      if (!evaluation) {
        return apiError("not_found", "evaluation not found", 404);
      }
      const denied = enabledTreeGate(evaluation.tree_id);
      if (denied) return denied;
    }
    // The 202 is a PARENT TASK, and the real mock records the judged evaluation on
    // it (payload {"result": {"evaluation_id": …}}). The auto-judge idempotency
    // check reads exactly that to spot judging already in flight, so the
    // fixture store must carry it too.
    const taskId = `task-judge-${++counters.judge}`;
    mockTasks.unshift({
      id: taskId,
      type: "judge",
      status: "queued",
      progress: { done: 0, total: 1 },
      result: { evaluation_id: body.evaluation_id ?? null },
      created_at: "2026-08-04T11:00:00Z",
    });
    return HttpResponse.json({ task_id: taskId }, { status: 202 });
  }),

  // GET /eval/evaluations/{evaluationId}/summary (getEvaluationScoreSummary) —
  // aggregates per scorer identity; an unjudged evaluation answers no scorers.
  http.get(`${BASE}/eval/evaluations/:evaluationId/summary`, ({ params }) => {
    const id = params.evaluationId as string;
    summaryRequests.push(id);
    if (!mockEvaluations.some((r) => r.id === id)) {
      return apiError("not_found", "evaluation not found", 404);
    }
    return HttpResponse.json(mockEvaluationSummaries[id] ?? { evaluation_id: id, scorers: [] });
  }),
];

export function resetEvalWorkbench() {
  mockRubrics.length = 0;
  mockRubrics.push(...seedRubrics());
  rubricRequests.length = 0;
  for (const key of Object.keys(mockEvalCases)) delete mockEvalCases[key];
  Object.assign(mockEvalCases, seedEvalCases());
  evalCaseRequests.length = 0;
  judgeRequests.length = 0;
  mockEvalBenchmarks.length = 0;
  mockEvalBenchmarks.push(...seedEvalBenchmarks());
  evalCaseCreates.length = 0;
  evalCaseVersionPosts.length = 0;
  evalBenchmarkCreates.length = 0;
  evalBenchmarkVersionPosts.length = 0;
  evalBenchmarkPatches.length = 0;
  evalBenchmarkDeletes.length = 0;
  evalBenchmarkItemPosts.length = 0;
  evalBenchmarkFreezes.length = 0;
  evalBenchmarkReplays.length = 0;
  rubricCreates.length = 0;
  rubricVersionPosts.length = 0;
  importRequests.length = 0;
  importConfig.queued = false;
  importConfig.report = {
    benchmark_id: null,
    rows_total: 3,
    rows_imported: 2,
    created_case_ids: ["case-imp-1", "case-imp-2"],
    errors: [
      { row: 2, field: "answer", message: "output is empty — a case needs a candidate response." },
    ],
  };
  for (const key of Object.keys(mockEvaluationSummaries)) delete mockEvaluationSummaries[key];
  summaryRequests.length = 0;
}
