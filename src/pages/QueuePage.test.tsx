import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useParams } from "react-router";
import { renderApp } from "../test/render";
import {
  cancelRequests,
  mockTasks,
  retryFailedRequests,
  taskDetailRequests,
  taskStreamRig,
} from "../test/msw/handlers";
import { QueuePage } from "./QueuePage";

// Contract under test — queue panel (feature-spec.md:106): "each task shows
// live progress bar + stage text + elapsed time; expandable to child tasks;
// cancel (parent cancels children). Failed children don't kill the batch —
// shown as partial failure with retry-failed button." Expand = GET
// /tasks/{id} "Task with children populated" (openapi.yaml:826); cancel =
// DELETE /tasks/{id} "cascades to children" (:836); retry = POST
// /tasks/{id}/retry-failed 202 (:849-865). Result deep links per Task.result
// (:1744-1752): run_id → "View results", conversation_id → "Open in Chat".

function RunProbe() {
  const { runId } = useParams();
  return <div>run-probe {runId}</div>;
}
function ChatProbe() {
  const { conversationId } = useParams();
  return <div>chat-probe {conversationId}</div>;
}

const renderQueue = () =>
  renderApp(
    <Routes>
      <Route path="/queue" element={<QueuePage />} />
      <Route path="/evaluations/:runId" element={<RunProbe />} />
      <Route path="/chat/:conversationId" element={<ChatProbe />} />
    </Routes>,
    { route: "/queue", queue: true },
  );

describe("QueuePage", () => {
  it("renders parents newest-first with stage text and the running header", async () => {
    renderQueue();
    // Seeded: replay (10:05, running) before fork (09:00, done) — "Tasks,
    // newest first" (openapi.yaml:769).
    await screen.findByTestId("task-task-seed-replay");
    const rows = screen.getAllByTestId(/^task-task-seed/);
    expect(rows[0]).toHaveAttribute("data-testid", "task-task-seed-replay");
    expect(rows[1]).toHaveAttribute("data-testid", "task-task-seed-fork");
    expect(screen.getByText("Conversation 2/3 · turn 1/2")).toBeInTheDocument();
    expect(screen.getByText("1 running · SSE live")).toBeInTheDocument();
  });

  it("expand lazy-fetches children via GET /tasks/{id} and shows per-child status", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByTestId("task-task-seed-replay");
    expect(screen.queryByTestId("children-task-seed-replay")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Toggle children of Replay" }));
    const children = await screen.findByTestId("children-task-seed-replay");
    expect(taskDetailRequests).toContain("task-seed-replay");
    expect(within(children).getByText("done")).toBeInTheDocument();
    expect(within(children).getByText("running")).toBeInTheDocument();
    expect(within(children).getByText("failed")).toBeInTheDocument();
  });

  it("cancel DELETEs the parent and the row reflects cancelled", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByTestId("task-task-seed-replay");

    await user.click(screen.getByRole("button", { name: "Cancel Replay" }));
    await waitFor(() => expect(cancelRequests).toContain("task-seed-replay"));
    // Optimistic flip + server reconcile both land on "cancelled".
    await waitFor(() =>
      expect(
        within(screen.getByTestId("task-task-seed-replay")).getByText("cancelled"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("0 running · SSE live")).toBeInTheDocument();
  });

  it("partial failure offers Retry failed; clicking POSTs and requeues the child", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByTestId("task-task-seed-replay");

    // The retry button appears once the failed child is visible (children
    // loaded on expand — feature-spec.md:106 partial failure).
    await user.click(screen.getByRole("button", { name: "Toggle children of Replay" }));
    await screen.findByTestId("children-task-seed-replay");
    await user.click(screen.getByRole("button", { name: "Retry failed" }));

    await waitFor(() => expect(retryFailedRequests).toContain("task-seed-replay"));
    // Children refetched after the 202: failed child is queued again.
    const children = await screen.findByTestId("children-task-seed-replay");
    await waitFor(() => expect(within(children).getByText("queued")).toBeInTheDocument());
    expect(within(children).queryByText("failed")).not.toBeInTheDocument();
  });

  it("deep links: result.run_id → View results → /evaluations/{id}", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByTestId("task-task-seed-replay");
    await user.click(screen.getByRole("link", { name: "View results ↗" }));
    expect(await screen.findByText("run-probe run-old-1")).toBeInTheDocument();
  });

  it("deep links: result.conversation_id → Open in Chat → conversation route", async () => {
    const user = userEvent.setup();
    renderQueue();
    await screen.findByTestId("task-task-seed-fork");
    await user.click(screen.getByRole("link", { name: "Open in Chat ↗" }));
    expect(await screen.findByText("chat-probe fork-c1-1")).toBeInTheDocument();
  });

  it("live: a task frame for a brand-new parent appears without refresh", async () => {
    renderQueue();
    await screen.findByTestId("task-task-seed-replay");
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));

    taskStreamRig.emit("task", {
      id: "task-live-judge",
      type: "judge",
      status: "running",
      progress: { done: 3, total: 40, stage: "case 3/40 · opus" },
      created_at: "2026-08-04T12:00:00Z",
      started_at: "2026-08-04T12:00:01Z",
    });
    await screen.findByTestId("task-task-live-judge");
    expect(screen.getByText("case 3/40 · opus")).toBeInTheDocument();
    expect(screen.getByText("2 running · SSE live")).toBeInTheDocument();
  });
});

// Guard: mutating fixtures above must not leak (resetHandlerState reseeds).
describe("fixture hygiene", () => {
  it("reseeds mockTasks between tests", () => {
    const replay = mockTasks.find((t) => t.id === "task-seed-replay");
    expect(replay?.status).toBe("running");
    expect(replay?.children?.some((c) => c.status === "failed")).toBe(true);
  });
});
