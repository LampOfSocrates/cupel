import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "./test/msw/server";
import { BASE, taskListRequests, taskStreamRig } from "./test/msw/handlers";
import { QueueProvider, useQueue } from "./QueueContext";
import type { Task } from "./api/types";

// Contract under test — GET /tasks/stream (openapi.yaml:777-813): "task —
// data: Task (status change; includes progress)", "progress — data:
// TaskProgressEvent (per-unit ticks, e.g. 'Conversation 3/10 · turn 2/6')".
// GET /tasks (:747-775) is "polling fallback + sidebar badge": "Live updates
// via SSE … Fallback: polling GET /tasks" (feature-spec.md:108); "Sidebar
// badge: pending count; subtle spinner while anything is running"
// (feature-spec.md:111).
//
// Timing: instead of vi.useFakeTimers (which fights MSW's real async I/O),
// the provider's reconnect/poll intervals are injectable — tests run them at
// millisecond scale and assert with waitFor.

function Probe() {
  const { tasks, pendingCount, running } = useQueue();
  return (
    <div>
      <div data-testid="pending">{pendingCount}</div>
      <div data-testid="running">{String(running)}</div>
      {tasks.map((t) => (
        <div key={t.id} data-testid={`row-${t.id}`}>
          {t.status}:{t.progress.done}/{t.progress.total}:{t.progress.stage ?? "-"}
        </div>
      ))}
    </div>
  );
}

const mountProvider = (timing: { reconnectBaseMs?: number; pollMs?: number } = {}) =>
  render(
    <QueueProvider reconnectBaseMs={timing.reconnectBaseMs ?? 15} pollMs={timing.pollMs ?? 40}>
      <Probe />
    </QueueProvider>,
  );

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("QueueProvider", () => {
  it("loads GET /tasks on connect and applies task frames from the stream", async () => {
    mountProvider();
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));

    // Initial reconcile: seeded parents, newest first, parents only.
    await waitFor(() =>
      expect(screen.getByTestId("row-task-seed-replay")).toHaveTextContent(
        "running:1/3:Conversation 2/3 · turn 1/2",
      ),
    );
    expect(screen.getByTestId("row-task-seed-fork")).toHaveTextContent("done:1/1");
    expect(screen.getByTestId("pending")).toHaveTextContent("1");
    expect(screen.getByTestId("running")).toHaveTextContent("true");

    // `task` frame — new parent appears; counts as pending while queued.
    const fresh: Task = {
      id: "task-new",
      type: "judge",
      status: "queued",
      progress: { done: 0, total: 4 },
      created_at: "2026-08-04T11:00:00Z",
    };
    taskStreamRig.emit("task", fresh);
    await waitFor(() => expect(screen.getByTestId("row-task-new")).toHaveTextContent("queued:0/4"));
    expect(screen.getByTestId("pending")).toHaveTextContent("2");

    // `task` frame — status change updates in place and drops it from pending.
    taskStreamRig.emit("task", { ...fresh, status: "done", progress: { done: 4, total: 4 } });
    await waitFor(() => expect(screen.getByTestId("row-task-new")).toHaveTextContent("done:4/4"));
    expect(screen.getByTestId("pending")).toHaveTextContent("1");
  });

  it("applies progress frames (progress + stage label, feature-spec.md:109)", async () => {
    mountProvider();
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));
    await screen.findByTestId("row-task-seed-replay");

    taskStreamRig.emit("progress", {
      task_id: "task-seed-replay",
      progress: { done: 2, total: 3, stage: "Conversation 3/3 · turn 1/2" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("row-task-seed-replay")).toHaveTextContent(
        "running:2/3:Conversation 3/3 · turn 1/2",
      ),
    );
  });

  it("falls back to polling GET /tasks while the stream is down, and stops on recovery", async () => {
    // Stream down: every connect attempt 500s.
    server.use(
      http.get(`${BASE}/tasks/stream`, () =>
        HttpResponse.json({ code: "down", message: "stream down" }, { status: 500 }),
      ),
    );
    mountProvider({ reconnectBaseMs: 10, pollMs: 25 });

    // Fallback engages after repeated failures and keeps polling.
    await waitFor(() => expect(taskListRequests.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
    // …and the polled data still populates the panel (feature-spec.md:108).
    await screen.findByTestId("row-task-seed-replay");

    // Recovery: restore the real stream handler → reconnect succeeds.
    server.resetHandlers();
    await waitFor(() => expect(taskStreamRig.clients).toBe(1), { timeout: 3000 });

    // Polling stops: allow the on-open reconcile to land, then the request
    // count must hold still across several would-be poll intervals.
    await sleep(50);
    const settled = taskListRequests.length;
    await sleep(150);
    expect(taskListRequests.length).toBe(settled);
  });
});
