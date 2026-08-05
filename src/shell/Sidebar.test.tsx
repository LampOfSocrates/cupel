import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { renderApp } from "../test/render";
import { mockTasks, taskStreamRig } from "../test/msw/handlers";
import { Shell } from "./Shell";

// Contract under test — "Sidebar badge: pending count; subtle spinner while
// anything is running" (feature-spec.md:111). Pending = queued + running
// parents; fed by QueueProvider's single app-wide /tasks/stream + GET /tasks
// (openapi.yaml:747-775 "polling fallback + sidebar badge").

const renderShell = () =>
  renderApp(
    <Routes>
      <Route element={<Shell />}>
        <Route path="*" element={<div>page</div>} />
      </Route>
    </Routes>,
    { route: "/chat", queue: true },
  );

describe("Sidebar queue badge", () => {
  it("counts pending parents and spins while running; clears when tasks finish", async () => {
    renderShell();
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));

    // Seed: one running replay parent → badge "1" + spinner.
    await waitFor(() => expect(screen.getByTestId("queue-badge")).toHaveTextContent("1"));
    expect(screen.getByLabelText("Tasks running")).toBeInTheDocument();

    // The running parent finishes → badge and spinner both clear.
    const seed = mockTasks.find((t) => t.id === "task-seed-replay")!;
    taskStreamRig.emit("task", {
      ...seed,
      children: undefined,
      status: "done",
      progress: { done: 3, total: 3 },
      finished_at: "2026-08-04T10:09:00Z",
    });
    await waitFor(() => expect(screen.queryByTestId("queue-badge")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Tasks running")).not.toBeInTheDocument();

    // A queued (not yet running) parent counts as pending, but no spinner
    // (feature-spec.md:111 separates the two signals).
    taskStreamRig.emit("task", {
      id: "task-queued-only",
      type: "replay",
      status: "queued",
      progress: { done: 0, total: 2 },
      created_at: "2026-08-04T12:00:00Z",
    });
    await waitFor(() => expect(screen.getByTestId("queue-badge")).toHaveTextContent("1"));
    expect(screen.queryByLabelText("Tasks running")).not.toBeInTheDocument();
  });
});
