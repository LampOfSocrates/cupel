import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderApp } from "../test/render";
import {
  cancelRequests,
  mockRuns,
  runDetailRequests,
  taskStreamRig,
} from "../test/msw/handlers";
import { RunDetailPage } from "./RunDetailPage";

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

  it("terminal stored runs render without a cancel affordance or subscription", async () => {
    renderDetail("run-old-1"); // seeded done fixture
    await screen.findByText("Run run-old-1");
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await sleep(50);
    expect(taskStreamRig.clients).toBe(0);
  });
});
