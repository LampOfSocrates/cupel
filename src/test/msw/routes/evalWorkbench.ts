// Eval workbench: rubrics, cases (incl. CSV import), sets, the judge trigger
// and per-evaluation score summaries. Mirrors the real mock's rules — append-only
// versions (latest wins), full-membership set versions, and per-row import
// errors that never abort the batch.
import { http, HttpResponse } from "msw";
import type {
  EvalCase,
  EvalCaseCreate,
  EvalCaseImportReport,
  EvalCaseUpdate,
  EvalSet,
  EvalSetCreate,
  EvalSetUpdate,
  JudgeRequest,
  Rubric,
  RubricCreate,
  RubricUpdate,
  EvaluationScoreSummary,
} from "../../../api/types";
import { BASE, captureLlmHeaders, counters, enabledTreeGate, envelope } from "../state";
import { mockEvaluations } from "./evaluations";
import { mockTasks } from "./tasks";

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
// evaluation-old-1 would auto-create from its v3 cell (source c1/t2).
function seedEvalCases(): Record<string, EvalCase> {
  return {
    "case-1": {
      id: "case-1",
      input: { prompt: "How do refunds work?", envelope },
      output: "Refunds arrive within 3 business days.",
      reference: null,
      source: { tree: "agent1", conversation_id: "c1", turn_id: "t2" },
      // Cases are versioned append-only server-side and every stored
      // case carries one (mock/main.py:1477 ORDER BY version DESC) — the
      // fixture omitted it, so a PUT's "version + 1" had nothing to build on.
      version: 1,
      created_at: "2026-08-03T12:05:00Z",
    },
  };
}
export const mockEvalCases: Record<string, EvalCase> = seedEvalCases();
export const evalCaseRequests: string[] = [];

// POST /eval/judge (openapi.yaml:931-954) — 202 TaskRef; the judging WORK is
// driven by tests (fixture mutation + taskStreamRig), like evaluation live fill.
export const judgeRequests: JudgeRequest[] = [];

// -------------------------------------------------- eval workbench (v0.3.0)
// POST /eval/cases (openapi.yaml:1340-1369), PUT /eval/cases/{caseId}
// (:1455-1483), GET/POST /eval/sets (:1484-1523), PUT /eval/sets/{setId}
// (:1524-1547), PUT /eval/rubrics/{rubricId} (:1313-1338),
// POST /eval/cases/import (:1370-1429).
export const evalCaseCreates: unknown[] = [];
export const evalCasePuts: Array<{ caseId: string; body: unknown }> = [];
export const evalSetCreates: unknown[] = [];
export const evalSetPuts: Array<{ setId: string; body: unknown }> = [];
export const rubricCreates: unknown[] = [];
export const rubricPuts: Array<{ rubricId: string; body: unknown }> = [];
export const importRequests: Array<{
  filename: string;
  mapping: string;
  set_id: string | null;
  set_name: string | null;
}> = [];

function seedEvalSets(): EvalSet[] {
  return [
    {
      id: "set-refunds",
      name: "refund-fails",
      version: 3,
      case_ids: ["case-1"],
      created_at: "2026-08-03T12:00:00Z",
    },
  ];
}
export const mockEvalSets: EvalSet[] = seedEvalSets();

// Import knob: `queued` flips the endpoint to the 202 path so tests can drive
// "Above the server's size threshold: 202 TaskRef" (openapi.yaml:1386-1389)
// without building a 200-row fixture; `report` is what the 200 path returns.
export const importConfig: {
  queued: boolean;
  report: EvalCaseImportReport;
} = {
  queued: false,
  report: {
    set_id: null,
    rows_total: 3,
    rows_imported: 2,
    created_case_ids: ["case-imp-1", "case-imp-2"],
    errors: [{ row: 2, column: "answer", message: "output is empty — a case needs a candidate response." }],
  },
};

// GET /eval/evaluations/{evaluationId}/summary (openapi.yaml:1001-1022) — mutable per-evaluation
// summaries; unset evaluations answer the empty aggregate (no judgments yet).
export const mockEvaluationSummaries: Record<string, EvaluationScoreSummary> = {};
export const summaryRequests: string[] = [];

export const evalHandlers = [
  // GET /eval/rubrics (openapi.yaml:868-886) — "Latest version of each rubric".
  http.get(`${BASE}/eval/rubrics`, () => {
    rubricRequests.push("rubrics");
    return HttpResponse.json(mockRubrics);
  }),

  // POST /eval/rubrics (openapi.yaml:1293-1311) — "new name = v1"; an existing
  // name appends the next version.
  http.post(`${BASE}/eval/rubrics`, async ({ request }) => {
    const body = (await request.json()) as RubricCreate;
    rubricCreates.push(body);
    if (!body?.name || !body?.prompt) {
      return HttpResponse.json({ code: "invalid", message: "name and prompt are required." }, { status: 422 });
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

  // PUT /eval/rubrics/{rubricId} (openapi.yaml:1313-1338) — "Appends the next
  // version of this rubric id — never overwrites"; 201 = the new version.
  http.put(`${BASE}/eval/rubrics/:rubricId`, async ({ params, request }) => {
    const rubricId = params.rubricId as string;
    const body = (await request.json()) as RubricUpdate;
    rubricPuts.push({ rubricId, body });
    const existing = mockRubrics.find((r) => r.id === rubricId);
    if (!existing) {
      return HttpResponse.json({ code: "not_found", message: "rubric not found" }, { status: 404 });
    }
    if (!body?.prompt) {
      return HttpResponse.json({ code: "invalid", message: "prompt is required." }, { status: 422 });
    }
    existing.version += 1;
    existing.prompt = body.prompt;
    return HttpResponse.json(existing, { status: 201 });
  }),

  // POST /eval/cases/import (openapi.yaml:1370-1429) — multipart; 200 with the
  // per-row report inline, or 202 TaskRef above the server's threshold
  // (importConfig.queued drives the branch). Registered BEFORE
  // /eval/cases/:caseId so the literal path wins.
  http.post(`${BASE}/eval/cases/import`, async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file") as File | null;
    importRequests.push({
      filename: file?.name ?? "",
      mapping: String(form.get("mapping") ?? ""),
      set_id: (form.get("set_id") as string | null) ?? null,
      set_name: (form.get("set_name") as string | null) ?? null,
    });
    if (importConfig.queued) {
      return HttpResponse.json({ task_id: `task-import-${++counters.evalImport}` }, { status: 202 });
    }
    return HttpResponse.json(importConfig.report, { status: 200 });
  }),

  // POST /eval/cases (openapi.yaml:1340-1369) — oneOf: (input + output) or
  // source; the sourced mode derives input/output server-side (:3322-3326).
  http.post(`${BASE}/eval/cases`, async ({ request }) => {
    const body = (await request.json()) as EvalCaseCreate;
    evalCaseCreates.push(body);
    const sourced = "source" in body && Boolean(body.source);
    const handcrafted = "input" in body && Boolean(body.input);
    if (sourced === handcrafted) {
      return HttpResponse.json(
        { code: "invalid", message: "Exactly one of (input + output) / source is required." },
        { status: 422 },
      );
    }
    const id = `case-new-${++counters.evalCase}`;
    const created: EvalCase = sourced
      ? {
          id,
          input: { prompt: "Derived prompt from the sourced turn", envelope },
          output: "Derived response from the sourced turn",
          reference: (body as { reference?: string | null }).reference ?? null,
          source: (body as { source: EvalCase["source"] }).source,
          version: 1,
          created_at: "2026-08-06T10:00:00Z",
        }
      : {
          id,
          input: (body as { input: EvalCase["input"] }).input,
          output: (body as { output: string }).output,
          reference: (body as { reference?: string | null }).reference ?? null,
          source: null,
          version: 1,
          created_at: "2026-08-06T10:00:00Z",
        };
    mockEvalCases[id] = created;
    return HttpResponse.json(created, { status: 201 });
  }),

  // GET /eval/sets (openapi.yaml:1484-1503) — "Latest version of every set".
  http.get(`${BASE}/eval/sets`, () => HttpResponse.json(mockEvalSets)),

  // POST /eval/sets (openapi.yaml:1504-1523) — created at version 1.
  http.post(`${BASE}/eval/sets`, async ({ request }) => {
    const body = (await request.json()) as EvalSetCreate;
    evalSetCreates.push(body);
    if (!body?.name) {
      return HttpResponse.json({ code: "invalid", message: "name is required." }, { status: 422 });
    }
    const created: EvalSet = {
      id: `set-new-${++counters.evalSet}`,
      name: body.name,
      version: 1,
      case_ids: body.case_ids ?? [],
      created_at: "2026-08-06T10:00:00Z",
    };
    mockEvalSets.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),

  // PUT /eval/sets/{setId} (openapi.yaml:1524-1547) — "each save is a new
  // version carrying its full case_ids list"; 201 = the new version.
  http.put(`${BASE}/eval/sets/:setId`, async ({ params, request }) => {
    const setId = params.setId as string;
    const body = (await request.json()) as EvalSetUpdate;
    evalSetPuts.push({ setId, body });
    const existing = mockEvalSets.find((s) => s.id === setId);
    if (!existing) {
      return HttpResponse.json({ code: "not_found", message: "set not found" }, { status: 404 });
    }
    if (!body || body.case_ids == null) {
      return HttpResponse.json({ code: "invalid", message: "case_ids is required." }, { status: 422 });
    }
    existing.version += 1;
    existing.case_ids = body.case_ids;
    if (body.name) existing.name = body.name;
    return HttpResponse.json(existing, { status: 201 });
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

  // PUT /eval/cases/{caseId} (openapi.yaml:1455-1483) — "each save appends the
  // next version, never overwrites"; 201 = the new version (now latest).
  http.put(`${BASE}/eval/cases/:caseId`, async ({ params, request }) => {
    const caseId = params.caseId as string;
    const body = (await request.json()) as EvalCaseUpdate;
    evalCasePuts.push({ caseId, body });
    const existing = mockEvalCases[caseId];
    if (!existing) {
      return HttpResponse.json({ code: "not_found", message: "case not found" }, { status: 404 });
    }
    if (!body?.input?.prompt || body.output == null) {
      return HttpResponse.json(
        { code: "invalid", message: "input.prompt and output are required." },
        { status: 422 },
      );
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

  // POST /eval/judge (openapi.yaml:931-954) — 202 TaskRef "(parent task +
  // child per case)". oneOf evaluation_id/case_ids enforced like the real mock
  // (mock/main.py:841-842); judging results are test-driven via fixture
  // mutation + taskStreamRig, mirroring the live-fill pattern.
  http.post(`${BASE}/eval/judge`, async ({ request }) => {
    captureLlmHeaders(request);
    const body = (await request.json()) as JudgeRequest;
    judgeRequests.push(body);
    if (!body.judge_model || !body.rubric_id) {
      return HttpResponse.json(
        { code: "invalid", message: "judge_model and rubric_id are required." },
        { status: 422 },
      );
    }
    // v0.3.0 widened the oneOf to evaluation_id | case_ids | set_id
    // (openapi.yaml:2926-2929), matching mock/main.py's judge handler.
    const selectors = [body.evaluation_id, body.case_ids, body.set_id].filter(Boolean).length;
    if (selectors !== 1) {
      return HttpResponse.json(
        {
          code: "invalid",
          message: "Exactly one of evaluation_id / case_ids / set_id is required (openapi.yaml:2926-2929).",
        },
        { status: 422 },
      );
    }
    // Disable rule for judge, mirroring mock/main.py:1798-1805 exactly:
    // judging is blocked when the RUN'S tree is disabled; case_ids/set_id
    // judging is NOT tree-gated (eval cases are global, feature-spec.md:111).
    if (body.evaluation_id) {
      const evaluation = mockEvaluations.find((r) => r.id === body.evaluation_id);
      if (!evaluation) {
        return HttpResponse.json({ code: "not_found", message: "evaluation not found" }, { status: 404 });
      }
      const denied = enabledTreeGate(evaluation.tree_id);
      if (denied) return denied;
    }
    // The 202 is a PARENT TASK, and the real mock records the judged evaluation on
    // it (payload {"result": {"evaluation_id": …}}, mock/main.py:1836-1838). The
    // auto-judge idempotency check reads exactly that to spot judging already
    // in flight, so the fixture store must carry it too.
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

  // GET /eval/evaluations/{evaluationId}/summary (openapi.yaml:1001-1022) — per-rubric
  // aggregates; an evaluation with no judgments answers empty rubrics.
  http.get(`${BASE}/eval/evaluations/:evaluationId/summary`, ({ params }) => {
    const id = params.evaluationId as string;
    summaryRequests.push(id);
    if (!mockEvaluations.some((r) => r.id === id)) {
      return HttpResponse.json({ code: "not_found", message: "evaluation not found" }, { status: 404 });
    }
    return HttpResponse.json(mockEvaluationSummaries[id] ?? { evaluation_id: id, rubrics: [] });
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
  mockEvalSets.length = 0;
  mockEvalSets.push(...seedEvalSets());
  evalCaseCreates.length = 0;
  evalCasePuts.length = 0;
  evalSetCreates.length = 0;
  evalSetPuts.length = 0;
  rubricCreates.length = 0;
  rubricPuts.length = 0;
  importRequests.length = 0;
  importConfig.queued = false;
  importConfig.report = {
    set_id: null,
    rows_total: 3,
    rows_imported: 2,
    created_case_ids: ["case-imp-1", "case-imp-2"],
    errors: [
      { row: 2, column: "answer", message: "output is empty — a case needs a candidate response." },
    ],
  };
  for (const key of Object.keys(mockEvaluationSummaries)) delete mockEvaluationSummaries[key];
  summaryRequests.length = 0;
}
