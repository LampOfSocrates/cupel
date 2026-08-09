import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useParams } from "react-router";
import { renderApp } from "../test/render";
import {
  cancelRequests,
  evalCaseRequests,
  judgeRequests,
  judgmentRequests,
  mockRuns,
  mockRunSummaries,
  mockTasks,
  pushLlmJudgment,
  replayTurnRequests,
  runDetailRequests,
  taskStreamRig,
} from "../test/msw/handlers";
import { RunDetailPage } from "./RunDetailPage";
import type { Run } from "../api/types";

// Contract under test — GET …/runs/{runId} (openapi.yaml:671-693): "Cells
// fill incrementally as child tasks finish (feature-spec.md:112); live fill
// arrives via GET /tasks/stream" (:679-680). Stream events (:789-792):
// "task — data: Task (status change)", "progress — data: TaskProgressEvent
// (per-unit ticks, e.g. 'Conversation 3/10 · turn 2/6')". Cancel: DELETE
// /tasks/{taskId} "Cancel a task … cancels queued/running children"
// (:832-839).

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function seedRunningRun() {
  mockRuns.unshift({
    id: "run-live",
    tree_id: "agent1",
    status: "running",
    created_at: "2026-08-04T10:00:00Z",
    task_id: "task-live",
    label: "Replay · 1 config(s)",
    columns: [
      { label: "baseline", config: {} },
      { label: "v2", config: { instruction_version: 2 } },
    ],
    rows: [
      {
        source: { conversation_id: "c1", turn_id: "t2" },
        cells: [
          { status: "done", content: "Approved refunds land in 3-5 days." },
          { status: "pending" },
        ],
      },
    ],
  });
  return mockRuns[0];
}

// Navigation probe for cell "Open in Chat ↗" targets.
function ChatProbe() {
  const { conversationId } = useParams();
  return <div>chat-probe {conversationId}</div>;
}

// Navigation probe for cell ⌁ trace targets.
function TraceProbe() {
  const { turnId } = useParams();
  return <div>trace-probe {turnId}</div>;
}

function renderDetail(runId: string) {
  return renderApp(
    <Routes>
      <Route path="/runs/:runId" element={<RunDetailPage />} />
    </Routes>,
    { route: `/runs/${runId}` },
  );
}

describe("RunDetailPage", () => {
  it("refetches the run on a family /tasks/stream event and renders the newly-done cell", async () => {
    const run = seedRunningRun();
    renderDetail("run-live");

    await screen.findByText("Run run-live");
    expect(screen.getByTestId("cell-0-1")).toHaveAttribute("data-status", "pending");
    // live-fill subscription open before we emit
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));

    // a child finished server-side: fixture mutates, then the stream ticks
    run.rows[0].cells[1] = { status: "done", content: "Refunds settle in 3 days flat." };
    taskStreamRig.emit("progress", {
      task_id: "task-live",
      progress: { done: 1, total: 2, stage: "Conversation 1/1 · turn 1/1" },
    });

    // debounced refetch (~300ms) repaints the grid + stage text
    await screen.findByText("Refunds settle in 3 days flat.");
    expect(screen.getByTestId("cell-0-1")).toHaveAttribute("data-status", "done");
    expect(screen.getByTestId("run-stage")).toHaveTextContent("Conversation 1/1 · turn 1/1");
  });

  it("ignores events from other task families", async () => {
    seedRunningRun();
    renderDetail("run-live");
    await screen.findByText("Run run-live");
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));
    const fetches = runDetailRequests.length;

    taskStreamRig.emit("progress", {
      task_id: "task-someone-else",
      progress: { done: 1, total: 4, stage: "Conversation 1/4 · turn 1/1" },
    });
    await sleep(400); // > debounce window
    expect(runDetailRequests.length).toBe(fetches);
  });

  it("stops refetching once the run status is terminal", async () => {
    const run = seedRunningRun();
    renderDetail("run-live");
    await screen.findByText("Run run-live");
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));

    // parent task done → run terminal on the next refetch
    run.status = "done";
    run.rows[0].cells[1] = { status: "done", content: "All settled." };
    taskStreamRig.emit("task", {
      id: "task-live",
      type: "replay",
      status: "done",
      progress: { done: 2, total: 2 },
      created_at: "2026-08-04T10:00:00Z",
    });

    await screen.findByText("All settled.");
    await screen.findByText("done");

    // Terminal → the page aborts its stream fetch (client-side unsubscribe;
    // MSW's jsdom transport does not propagate the abort to the handler's
    // cancel(), so clients can't be asserted — the observable guarantee is
    // that no further refetch happens).
    const fetches = runDetailRequests.length;
    taskStreamRig.emit("progress", {
      task_id: "task-live",
      progress: { done: 2, total: 2, stage: "late tick" },
    });
    await sleep(400);
    expect(runDetailRequests.length).toBe(fetches); // no further refetch
  });

  it("cancel calls DELETE /tasks/{task_id} with the run's parent task", async () => {
    const user = userEvent.setup();
    seedRunningRun();
    renderDetail("run-live");
    await screen.findByText("Run run-live");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelRequests).toEqual(["task-live"]));
  });

  // "'re-run this turn with…' on any results cell"
  // (feature-spec.md:72; sketch 04 "+ Re-run this turn with…
  // POST …/replay/turn"): done cells expose ⑂ seeded with the CELL's source
  // conversation/turn, reusing the same ForkModal as Chat.
  it("done cell ⑂ re-fires seeded with that cell's source conversation/turn", async () => {
    const user = userEvent.setup();
    renderDetail("run-old-1"); // done fixture — row source c1/t2, both cells done
    await screen.findByText("Run run-old-1");

    // one ⑂ per done cell (baseline + v3), both carrying the row's source
    const forkButtons = screen.getAllByRole("button", { name: "Re-run turn t2 with…" });
    expect(forkButtons).toHaveLength(2);
    await user.click(forkButtons[0]);

    await user.click(await screen.findByRole("combobox", { name: "Endpoints" }));
    await user.click(await screen.findByRole("option", { name: "prod" }));
    await user.click(screen.getByRole("button", { name: "Fork ⑂" }));

    await waitFor(() => expect(replayTurnRequests).toHaveLength(1));
    expect(replayTurnRequests[0].body).toEqual({
      conversation_id: "c1",
      turn_id: "t2",
      endpoints: ["ep_agent1_prod"],
      context_policy: "frozen",
    });
  });

  // Fork comparison pivot. "a turn re-fire is a run whose grid
  // pivots to 'compare forks of the same turn across endpoints (column per
  // endpoint)'" (openapi.yaml:636-639) — the SERVER delivers the pivoted
  // grid (endpoint-name columns, one row), so the page just renders it plus
  // "'Open in Chat' button on every results cell" (feature-spec.md:70):
  // endpoint cells link the fork holding the result (RunCell.conversation_id,
  // openapi.yaml:1651), the baseline cell links the ORIGINAL conversation
  // (mock/main.py:643-646). Fixture run-refire-1 mirrors the real mock's
  // completed re-fire state.
  it("re-fire run: endpoint-name columns; cell Open in Chat routes to the fork", async () => {
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route path="/runs/:runId" element={<RunDetailPage />} />
        <Route path="/chat/:conversationId" element={<ChatProbe />} />
      </Routes>,
      { route: "/runs/run-refire-1" },
    );
    await screen.findByText("Run run-refire-1");

    // column labels are endpoint NAMES, server-provided — no client reshaping
    expect(screen.getByRole("columnheader", { name: /baseline/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "prod" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "staging" })).toBeInTheDocument();

    // every done cell carries a conversation_id → one link per cell
    expect(screen.getAllByText("Open in Chat ↗")).toHaveLength(3);
    await user.click(screen.getByTestId("open-in-chat-0-1"));
    await screen.findByText("chat-probe c2f1"); // fork holding the prod result
  });

  it("re-fire run: the baseline cell's Open in Chat routes to the ORIGINAL conversation", async () => {
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route path="/runs/:runId" element={<RunDetailPage />} />
        <Route path="/chat/:conversationId" element={<ChatProbe />} />
      </Routes>,
      { route: "/runs/run-refire-1" },
    );
    await screen.findByText("Run run-refire-1");

    await user.click(screen.getByTestId("open-in-chat-0-0"));
    await screen.findByText("chat-probe c2"); // original, not a fork
  });

  it("plain replay runs get no Open in Chat links (cells carry no conversation_id)", async () => {
    renderDetail("run-old-1");
    await screen.findByText("Run run-old-1");
    expect(screen.queryByText("Open in Chat ↗")).not.toBeInTheDocument();
  });

  // "⌁ trace icon on every turn — in Chat, results grid cells, and
  // drill-in. Works on originals, forks, and replays alike"
  // (feature-spec.md:145): done cells that carry the produced turn's id
  // (RunCell.turn_id) route to that turn's trace — endpoint cells to the fork
  // replay's turn, the baseline cell to the ORIGINAL turn.
  it("done cells with a turn_id expose ⌁ routing to that turn's trace", async () => {
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route path="/runs/:runId" element={<RunDetailPage />} />
        <Route path="/trace/:turnId" element={<TraceProbe />} />
      </Routes>,
      { route: "/runs/run-refire-1" },
    );
    await screen.findByText("Run run-refire-1");

    // all 3 cells of the re-fire fixture carry a turn_id → 3 ⌁ (original + 2 forks)
    expect(screen.getAllByRole("button", { name: /Open trace for turn/ })).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Open trace for turn c2f1-t9" }));
    await screen.findByText("trace-probe c2f1-t9");
  });

  it("cells without a turn_id get no ⌁", async () => {
    renderDetail("run-old-1"); // plain replay fixture — cells carry no turn_id
    await screen.findByText("Run run-old-1");
    expect(
      screen.queryByRole("button", { name: /Open trace for turn/ }),
    ).not.toBeInTheDocument();
  });

  it("terminal stored runs render without a cancel affordance or subscription", async () => {
    renderDetail("run-old-1"); // seeded done fixture
    await screen.findByText("Run run-old-1");
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await sleep(50);
    expect(taskStreamRig.clients).toBe(0);
  });
});

// Eval layer. Contract under test:
// - GET /eval/runs/{runId}/summary "Aggregates per rubric" feeding the
//   "summary header (mean, distribution sparkline)" (openapi.yaml:1001-1022;
//   feature-spec.md:49), "updates live" (feature-spec.md:64)
// - RunCell.case_id + latest_score — "the join key for 'score column reads
//   latest judgment per (case, rubric)' and the judgment drawer"
//   (openapi.yaml:1654-1664; feature-spec.md:62)
// - judgment frames on /tasks/stream (JudgmentEvent, openapi.yaml:1796-1804)
// - drawer endpoints: "GET /eval/judgments?case_id=, GET /eval/cases/{id}"
//   (feature-spec.md:233); history append-only (feature-spec.md:59 "persisted
//   forever, never overwritten … Re-judging appends")
// - POST /eval/judge {run_id, judge_model, rubric_id} → 202 TaskRef
//   (openapi.yaml:931-954).
describe("RunDetailPage — eval (P1-T12b)", () => {
  it("renders the summary header: per-rubric mean + count + inline distribution", async () => {
    mockRunSummaries["run-old-1"] = {
      run_id: "run-old-1",
      rubrics: [
        { rubric_id: "rub-help", rubric_version: 2, mean: 0.74, count: 2, distribution: [0, 0, 1, 0, 1] },
        { rubric_id: "rub-acc", rubric_version: 1, mean: 0.5, count: 2, distribution: [0, 1, 0, 1, 0] },
      ],
    };
    renderDetail("run-old-1");
    const summary = await screen.findByTestId("run-summary");
    // rubric NAMES resolved via GET /eval/rubrics (ids until it lands)
    await waitFor(() => expect(summary).toHaveTextContent("helpfulness v2"));
    expect(summary).toHaveTextContent("mean 0.74 · n=2");
    expect(summary).toHaveTextContent("accuracy v1");
    expect(summary).toHaveTextContent("mean 0.50 · n=2");
    // distribution: one CSS bar per bucket — no chart lib
    expect(screen.getByTestId("dist-rub-help-v2").children).toHaveLength(5);
  });

  it("unjudged runs render no summary header and no chips", async () => {
    renderDetail("run-old-1");
    await screen.findByText("Run run-old-1");
    expect(screen.queryByTestId("run-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("score-chip-0-1")).not.toBeInTheDocument();
  });

  it("score chip renders latest_score on judged cells; click opens the drawer with case + append-only history", async () => {
    const user = userEvent.setup();
    const run = mockRuns.find((r) => r.id === "run-old-1")!;
    Object.assign(run.rows[0].cells[1], { case_id: "case-1", latest_score: 0.87 });
    // Two judgments for the SAME case — a re-judge appended, both kept
    // (feature-spec.md:59). Pushed oldest-first; served newest-first.
    pushLlmJudgment({
      case_id: "case-1", run_id: "run-old-1", score: 0.61, rubric_version: 1,
      reasoning: "Adequate but thin.", created_at: "2026-08-03T12:10:00Z",
    });
    pushLlmJudgment({
      case_id: "case-1", run_id: "run-old-1", score: 0.87, rubric_version: 2,
      reasoning: "Cites supporting detail.", created_at: "2026-08-04T09:00:00Z",
    });

    renderDetail("run-old-1");
    await screen.findByText("Run run-old-1");
    const chip = screen.getByTestId("score-chip-0-1");
    expect(chip).toHaveTextContent("0.87"); // denormalized latest score
    expect(screen.queryByTestId("score-chip-0-0")).not.toBeInTheDocument(); // baseline unjudged

    await user.click(chip);
    const drawer = await screen.findByRole("dialog");
    // case doc (GET /eval/cases/case-1): input prompt + frozen envelope + output
    expect(within(drawer).getByText("How do refunds work?")).toBeInTheDocument();
    expect(within(drawer).getByTestId("envelope-chip")).toHaveTextContent("2026-08-02 · Europe/London");
    expect(within(drawer).getByText("Refunds arrive within 3 business days.")).toBeInTheDocument();
    expect(evalCaseRequests).toEqual(["case-1"]);

    // history (GET /eval/judgments?case_id=case-1): newest first, BOTH kept
    const entries = await within(drawer).findAllByTestId("judgment-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent("0.87");
    expect(entries[0]).toHaveTextContent("claude-haiku-4-5 · helpfulness v2");
    expect(entries[0]).toHaveTextContent("Cites supporting detail.");
    expect(entries[1]).toHaveTextContent("0.61");
    expect(entries[1]).toHaveTextContent("helpfulness v1");
    expect(within(drawer).getByTestId("judgment-history-heading")).toHaveTextContent("append-only");
    expect(judgmentRequests.at(-1)?.searchParams.get("case_id")).toBe("case-1");
  });

  it("manual 'Judge this run' POSTs /eval/judge and streams scores + summary live until the judge task finishes", async () => {
    const user = userEvent.setup();
    renderDetail("run-old-1");
    await screen.findByText("Run run-old-1");
    // done run, nothing judging → no stream subscription
    expect(taskStreamRig.clients).toBe(0);

    await user.click(screen.getByRole("button", { name: "⚖ Judge this run" }));
    const form = await screen.findByTestId("judge-form");
    const judgeBtn = within(form).getByRole("button", { name: "Judge" });
    expect(judgeBtn).toBeDisabled(); // JudgeRequest requires judge_model + rubric_id
    await user.click(within(form).getByRole("combobox", { name: "Judge model" }));
    await user.click(await screen.findByRole("option", { name: "Claude Haiku 4.5" }));
    await user.click(within(form).getByRole("combobox", { name: "Rubric" }));
    await user.click(await screen.findByRole("option", { name: "helpfulness v2" }));
    await user.click(judgeBtn);

    await waitFor(() =>
      expect(judgeRequests).toEqual([
        { run_id: "run-old-1", judge_model: "claude-haiku-4-5", rubric_id: "rub-help" },
      ]),
    );
    // 202 task_id → judging badge + a stream subscription for its family
    await screen.findByTestId("judging-badge");
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));

    // a judging child finished server-side: cell scored + summary aggregated,
    // then the judgment frame ticks ("scores stream into the grid live",
    // feature-spec.md:64)
    const run = mockRuns.find((r) => r.id === "run-old-1")!;
    Object.assign(run.rows[0].cells[1], { case_id: "case-1", latest_score: 0.87 });
    mockRunSummaries["run-old-1"] = {
      run_id: "run-old-1",
      rubrics: [
        { rubric_id: "rub-help", rubric_version: 2, mean: 0.87, count: 1, distribution: [0, 0, 0, 0, 1] },
      ],
    };
    taskStreamRig.emit("judgment", {
      judgment: {
        id: "j-live", case_id: "case-1", run_id: "run-old-1", turn_id: "t2",
        conversation_id: "c1", type: "llm", judge_model: "claude-haiku-4-5",
        rubric_id: "rub-help", rubric_version: 2, score: 0.87,
        reasoning: "Cites supporting detail.", created_at: "2026-08-04T10:00:00Z",
      },
    });

    // debounced refetch repaints chip + live summary header
    await screen.findByTestId("score-chip-0-1");
    await waitFor(() =>
      expect(screen.getByTestId("run-summary")).toHaveTextContent("mean 0.87 · n=1"),
    );

    // judge parent task terminal → judging state clears
    taskStreamRig.emit("task", {
      id: "task-judge-1", type: "judge", status: "done",
      progress: { done: 1, total: 1 }, created_at: "2026-08-04T10:00:00Z",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("judging-badge")).not.toBeInTheDocument(),
    );
  });

  it("judgment frames from OTHER runs don't trigger a refetch", async () => {
    const user = userEvent.setup();
    renderDetail("run-old-1");
    await screen.findByText("Run run-old-1");
    // subscribe by starting a judge (only live path that opens the stream here)
    await user.click(screen.getByRole("button", { name: "⚖ Judge this run" }));
    const form = await screen.findByTestId("judge-form");
    await user.click(within(form).getByRole("combobox", { name: "Judge model" }));
    await user.click(await screen.findByRole("option", { name: "Claude Haiku 4.5" }));
    await user.click(within(form).getByRole("combobox", { name: "Rubric" }));
    await user.click(await screen.findByRole("option", { name: "helpfulness v2" }));
    await user.click(within(form).getByRole("button", { name: "Judge" }));
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));

    const fetches = runDetailRequests.length;
    taskStreamRig.emit("judgment", {
      judgment: {
        id: "j-other", case_id: "case-x", run_id: "run-someone-else", turn_id: null,
        conversation_id: null, type: "llm", judge_model: "claude-haiku-4-5",
        rubric_id: "rub-help", rubric_version: 2, score: 0.5,
        reasoning: null, created_at: "2026-08-04T10:00:00Z",
      },
    });
    await sleep(400); // > debounce window
    expect(runDetailRequests.length).toBe(fetches);
  });

  it("a finished run without judge config never calls POST /eval/judge", async () => {
    const run = seedRunningRun(); // configs carry no judge
    renderDetail("run-live");
    await screen.findByText("Run run-live");
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));

    run.status = "done";
    taskStreamRig.emit("task", {
      id: "task-live", type: "replay", status: "done",
      progress: { done: 2, total: 2 }, created_at: "2026-08-04T10:00:00Z",
    });
    await screen.findByText("done");
    await sleep(100);
    expect(judgeRequests).toHaveLength(0);
  });
});

// Auto-judge. The rule under test: judge a run that IS done and
// carries a judge config and has not been judged yet, NOT "a run this page
// watched finish" (the bug: opening a finished run's link produced
// no scores at all). Idempotency is read from the append-only store —
// GET /eval/judgments?run_id=&rubric_id= (openapi.yaml:1575-1614) — plus the
// in-flight judge parent task (Task.result.run_id, mock/main.py:1836-1838),
// so reload / remount / a second tab cannot append duplicate judgments.
const AUTO_JUDGE = { judge_model: "claude-haiku-4-5", rubric_id: "rub-help" };

/** A run whose SECOND column config carries a judge — the shape a "judge on"
 * replay produces (RunConfig.judge, openapi.yaml:1508-1514). */
function seedJudgeConfigRun(status: Run["status"], id = "run-auto") {
  mockRuns.unshift({
    id,
    tree_id: "agent1",
    status,
    created_at: "2026-08-04T10:00:00Z",
    task_id: `task-${id}`,
    label: "Replay · 1 config(s)",
    columns: [
      { label: "baseline", config: {} },
      { label: "v2", config: { instruction_version: 2, judge: AUTO_JUDGE } },
    ],
    rows: [
      {
        source: { conversation_id: "c1", turn_id: "t2" },
        cells: [
          { status: "done", content: "Approved refunds land in 3-5 days." },
          status === "done"
            ? { status: "done", content: "Refunds settle in 3 days flat." }
            : { status: "pending" },
        ],
      },
    ],
  });
  return mockRuns[0];
}

/** The idempotency probe this page makes before auto-judging. */
const priorJudgmentProbes = () =>
  judgmentRequests.filter((u) => u.searchParams.get("run_id") === "run-auto");

describe("RunDetailPage — auto-judge (UX phase)", () => {
  it("opening an ALREADY-done run with a judge config and no judgments fires exactly once", async () => {
    seedJudgeConfigRun("done");
    renderDetail("run-auto");
    await screen.findByText("Run run-auto");

    await waitFor(() =>
      expect(judgeRequests).toEqual([{ run_id: "run-auto", ...AUTO_JUDGE }]),
    );
    // the predicate is read from the store, scoped to run × rubric
    const probe = priorJudgmentProbes().at(-1)!;
    expect(probe.searchParams.get("rubric_id")).toBe("rub-help");
    // 202 TaskRef → the same judging state the live path shows
    await screen.findByTestId("judging-badge");

    // refetches keep arriving while judging; the latch holds
    await sleep(400);
    expect(judgeRequests).toHaveLength(1);
  });

  it("does NOT fire when judgments for that rubric already exist", async () => {
    seedJudgeConfigRun("done");
    pushLlmJudgment({
      case_id: "case-1", run_id: "run-auto", rubric_id: "rub-help",
      rubric_version: 2, score: 0.87, created_at: "2026-08-04T09:00:00Z",
    });

    renderDetail("run-auto");
    await screen.findByText("Run run-auto");
    await waitFor(() => expect(priorJudgmentProbes()).toHaveLength(1));
    await sleep(100);
    expect(judgeRequests).toHaveLength(0);
    expect(screen.queryByTestId("judging-badge")).not.toBeInTheDocument();
  });

  it("still fires when the only judgments are for a DIFFERENT rubric", async () => {
    seedJudgeConfigRun("done");
    pushLlmJudgment({
      case_id: "case-1", run_id: "run-auto", rubric_id: "rub-acc",
      rubric_version: 1, score: 0.4, created_at: "2026-08-04T09:00:00Z",
    });

    renderDetail("run-auto");
    await screen.findByText("Run run-auto");
    await waitFor(() => expect(judgeRequests).toHaveLength(1));
    expect(judgeRequests[0].rubric_id).toBe("rub-help");
    // settle the judging subscription before teardown, so a stream fetch
    // still in flight can't register itself after the rig is reset
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));
  });

  it("a run that finishes WHILE watched still auto-judges once, and the badge clears", async () => {
    const run = seedJudgeConfigRun("running");
    renderDetail("run-auto");
    await screen.findByText("Run run-auto");
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));
    expect(judgeRequests).toHaveLength(0); // nothing to judge yet

    run.status = "done";
    run.rows[0].cells[1] = { status: "done", content: "Refunds settle in 3 days flat." };
    taskStreamRig.emit("task", {
      id: "task-run-auto", type: "replay", status: "done",
      progress: { done: 1, total: 1 }, created_at: "2026-08-04T10:00:00Z",
    });

    await waitFor(() =>
      expect(judgeRequests).toEqual([{ run_id: "run-auto", ...AUTO_JUDGE }]),
    );
    await screen.findByTestId("judging-badge");

    // judging parent terminal → badge clears (task-judge-1 = MSW's 202 id)
    taskStreamRig.emit("task", {
      id: "task-judge-1", type: "judge", status: "done",
      progress: { done: 1, total: 1 }, created_at: "2026-08-04T10:01:00Z",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("judging-badge")).not.toBeInTheDocument(),
    );
    expect(judgeRequests).toHaveLength(1);
  });

  it("a remount mid-judging adopts the in-flight task instead of judging again", async () => {
    seedJudgeConfigRun("done");
    const first = renderDetail("run-auto");
    await screen.findByText("Run run-auto");
    await waitFor(() => expect(judgeRequests).toHaveLength(1));
    first.unmount();

    // Reload/second tab: no judgment has landed yet, but the judge parent task
    // is queued — the page adopts it rather than appending a duplicate pass.
    renderDetail("run-auto");
    await screen.findByText("Run run-auto");
    await screen.findByTestId("judging-badge");
    await sleep(200);
    expect(judgeRequests).toHaveLength(1);
  });

  it("a remount after judging finished does not re-judge", async () => {
    seedJudgeConfigRun("done");
    const first = renderDetail("run-auto");
    await screen.findByText("Run run-auto");
    await waitFor(() => expect(judgeRequests).toHaveLength(1));
    first.unmount();

    // server-side completion: the judgment is appended, the task goes terminal
    pushLlmJudgment({
      case_id: "case-1", run_id: "run-auto", rubric_id: "rub-help",
      rubric_version: 2, score: 0.87, created_at: "2026-08-04T10:02:00Z",
    });
    mockTasks.find((t) => t.id === "task-judge-1")!.status = "done";

    renderDetail("run-auto");
    await screen.findByText("Run run-auto");
    await waitFor(() => expect(priorJudgmentProbes().length).toBeGreaterThan(1));
    await sleep(100);
    expect(judgeRequests).toHaveLength(1);
    expect(screen.queryByTestId("judging-badge")).not.toBeInTheDocument();
  });

  it("an already-done run with NO judge config never probes or judges", async () => {
    renderDetail("run-old-1"); // done fixture, no judge in any config
    await screen.findByText("Run run-old-1");
    await sleep(100);
    expect(judgeRequests).toHaveLength(0);
    expect(judgmentRequests.filter((u) => u.searchParams.get("run_id"))).toHaveLength(0);
  });

  it.each(["failed", "cancelled"] as const)(
    "a %s run with a judge config never auto-judges",
    async (status) => {
      seedJudgeConfigRun(status);
      renderDetail("run-auto");
      await screen.findByText("Run run-auto");
      await sleep(100);
      expect(judgeRequests).toHaveLength(0);
      expect(priorJudgmentProbes()).toHaveLength(0);
    },
  );
});
