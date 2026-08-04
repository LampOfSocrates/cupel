import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { TaskQueue, formatElapsed } from "./TaskQueue";
import type { Task } from "../api/types";

// Contract under test: Task (openapi.yaml:1726-1761) — status enum queued/
// running/done/failed/cancelled, progress {done,total,stage}, children.
// Queue panel behaviour (feature-spec.md:110): "progress bar + stage text +
// elapsed time; expandable to child tasks; cancel … Failed children don't
// kill the batch — shown as partial failure with retry-failed button."

const NOW = Date.parse("2026-08-04T10:02:14Z");

function task(partial: Partial<Task> & Pick<Task, "id" | "status">): Task {
  return {
    type: "replay",
    progress: { done: 0, total: 0 },
    created_at: "2026-08-04T10:00:00Z",
    ...partial,
  };
}

const parent = task({
  id: "task-1",
  status: "running",
  progress: { done: 7, total: 12, stage: "Conversation 8/12 · turn 3/5" },
  started_at: "2026-08-04T10:00:00Z",
  children: [
    task({ id: "task-1a", status: "done", progress: { done: 5, total: 5, stage: "conv #291" } }),
    task({ id: "task-1b", status: "running", progress: { done: 3, total: 5, stage: "conv #292" } }),
    task({ id: "task-1c", status: "failed", progress: { done: 1, total: 5, stage: "conv #293" }, error: "boom" }),
  ],
});

function renderQueue(tasks: Task[], props: Partial<Parameters<typeof TaskQueue>[0]> = {}) {
  return render(
    <MantineProvider env="test">
      <TaskQueue tasks={tasks} now={NOW} {...props} />
    </MantineProvider>,
  );
}

describe("TaskQueue", () => {
  it("shows progress, stage text, and elapsed time per task", () => {
    renderQueue([parent]);
    const row = screen.getByTestId("task-task-1");
    expect(row).toHaveTextContent("Replay");
    expect(row).toHaveTextContent("7/12");
    expect(row).toHaveTextContent("2m14s"); // started 10:00:00, now 10:02:14
    expect(row).toHaveTextContent("Conversation 8/12 · turn 3/5");
    expect(within(row).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      String((7 / 12) * 100),
    );
  });

  it("expands to children, firing onExpand, and shows child statuses", async () => {
    const onExpand = vi.fn();
    const user = userEvent.setup();
    renderQueue([parent], { onExpand });
    expect(screen.queryByTestId("children-task-1")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Toggle children of Replay" }));
    expect(onExpand).toHaveBeenCalledWith("task-1");
    const children = screen.getByTestId("children-task-1");
    expect(within(children).getByText("conv #291")).toBeInTheDocument();
    expect(within(children).getByText("failed")).toBeInTheDocument();
  });

  it("fires cancel and retry-failed callbacks with the task id", async () => {
    const onCancel = vi.fn();
    const onRetryFailed = vi.fn();
    const user = userEvent.setup();
    renderQueue([parent], { onCancel, onRetryFailed });

    await user.click(screen.getByRole("button", { name: "Cancel Replay" }));
    expect(onCancel).toHaveBeenCalledWith("task-1");

    // partial failure: a failed child ⇒ retry-failed offered
    await user.click(screen.getByRole("button", { name: "Retry failed" }));
    expect(onRetryFailed).toHaveBeenCalledWith("task-1");
  });

  it("renders a status badge for each of the five statuses; cancel only while active", () => {
    const onCancel = vi.fn();
    const statuses = ["queued", "running", "done", "failed", "cancelled"] as const;
    renderQueue(
      statuses.map((status, i) => task({ id: `s-${i}`, status })),
      { onCancel },
    );
    for (const [i, status] of statuses.entries()) {
      expect(within(screen.getByTestId(`task-s-${i}`)).getByText(status)).toBeInTheDocument();
    }
    // cancel buttons only on queued + running
    expect(screen.getAllByRole("button", { name: /^Cancel/ })).toHaveLength(2);
  });

  it("uses type labels per sketch 05 and formats elapsed compactly", () => {
    renderQueue([
      task({ id: "j", status: "running", type: "judge", started_at: "2026-08-04T10:02:00Z" }),
      task({ id: "f", status: "done", type: "replay_turn" }),
    ]);
    expect(screen.getByTestId("task-j")).toHaveTextContent("Judging");
    expect(screen.getByTestId("task-f")).toHaveTextContent("Turn fork");
    expect(formatElapsed(134_000)).toBe("2m14s");
    expect(formatElapsed(14_000)).toBe("14s");
    expect(formatElapsed(3_660_000)).toBe("1h01m");
  });
});
