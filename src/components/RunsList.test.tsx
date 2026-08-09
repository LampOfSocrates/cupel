import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { RunsList } from "./RunsList";
import type { EvaluationSummaryItem } from "../api/types";

// Contract under test: EvaluationSummaryItem (openapi.yaml:1596-1605) — status chip,
// created_at, nullable label, task_id link.

const evaluations: EvaluationSummaryItem[] = [
  {
    id: "812",
    tree_id: "agent1",
    status: "running",
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    task_id: "task-812",
    label: "v14 vs v15",
  },
  {
    id: "811",
    tree_id: "agent1",
    status: "failed",
    created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    task_id: "task-811",
    label: null,
  },
];

function renderList(props: Partial<Parameters<typeof RunsList>[0]> = {}) {
  return render(
    <MantineProvider env="test">
      <RunsList evaluations={evaluations} {...props} />
    </MantineProvider>,
  );
}

describe("RunsList", () => {
  it("renders status chip, label (with id fallback), and relative time", () => {
    renderList();
    const first = screen.getByTestId("evaluation-812");
    expect(within(first).getByText("running")).toBeInTheDocument();
    expect(within(first).getByText("v14 vs v15")).toBeInTheDocument();
    expect(within(first).getByText("5m")).toBeInTheDocument();

    const second = screen.getByTestId("evaluation-811");
    expect(within(second).getByText("failed")).toBeInTheDocument();
    expect(within(second).getByText("Evaluation 811")).toBeInTheDocument(); // null label fallback
    expect(within(second).getByText("3h")).toBeInTheDocument();
  });

  it("row click fires onOpen with the evaluation; task link fires onTaskClick only", async () => {
    const onOpen = vi.fn();
    const onTaskClick = vi.fn();
    const user = userEvent.setup();
    renderList({ onOpen, onTaskClick });

    await user.click(screen.getByRole("button", { name: "Open v14 vs v15" }));
    expect(onOpen).toHaveBeenCalledWith(evaluations[0]);

    await user.click(screen.getByRole("button", { name: "Task for Evaluation 811" }));
    expect(onTaskClick).toHaveBeenCalledWith("task-811");
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders an empty state", () => {
    render(
      <MantineProvider env="test">
        <RunsList evaluations={[]} />
      </MantineProvider>,
    );
    expect(screen.getByText("No evaluations yet")).toBeInTheDocument();
  });
});
