import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { ComparisonView } from "./ComparisonView";
import type { Run, RunCell } from "../api/types";

// Contract under test: Run (openapi.yaml:1607-1643) — "columns: Index 0 =
// baseline"; "cells: One per column, same order; fills incrementally"; RunCell
// status enum pending/running/done/failed (:1649). Annotation slot per
// feature-spec.md:138 "pluggable annotation: thumbs and/or scores".

const run: Run = {
  id: "812",
  tree_id: "agent1",
  status: "running",
  created_at: "2026-08-04T10:00:00Z",
  task_id: "task-812",
  columns: [
    { label: "Baseline", config: {} },
    { label: "prod · v15", config: { instruction_version: 15, endpoint_ids: ["prod"] } },
  ],
  rows: [
    {
      source: { conversation_id: "c1", turn_id: "t2" },
      cells: [
        { status: "done", content: "Refunds land in **3-5 days**.", latest_score: 6.1 },
        { status: "running" },
      ],
    },
    {
      source: { conversation_id: "c2", turn_id: "t9" },
      cells: [
        { status: "pending" },
        { status: "failed", error: "endpoint timeout" },
      ],
    },
  ],
};

function renderView(renderAnnotation?: (cell: RunCell) => React.ReactNode) {
  return render(
    <MantineProvider env="test">
      <ComparisonView run={run} renderAnnotation={renderAnnotation} />
    </MantineProvider>,
  );
}

describe("ComparisonView", () => {
  it("renders columns in order with the baseline badge on index 0", () => {
    renderView();
    const headers = screen.getAllByRole("columnheader");
    // leading source column + one per Run column
    expect(headers[1]).toHaveTextContent("Baseline");
    expect(headers[1]).toHaveTextContent("baseline");
    expect(headers[2]).toHaveTextContent("prod · v15");
    expect(headers[2]).not.toHaveTextContent("baseline");
  });

  it("renders every cell state: done markdown, running, pending spinner, failed error", () => {
    renderView();
    const done = screen.getByTestId("cell-0-0");
    expect(done).toHaveAttribute("data-status", "done");
    // markdown via src/lib/markdown.tsx: **3-5 days** → <strong>
    expect(done.querySelector("strong")?.textContent).toBe("3-5 days");

    const running = screen.getByTestId("cell-0-1");
    expect(running).toHaveAttribute("data-status", "running");
    expect(within(running).getByText("generating…")).toBeInTheDocument();
    expect(within(running).getByTestId("cell-spinner")).toBeInTheDocument();

    const pending = screen.getByTestId("cell-1-0");
    expect(pending).toHaveAttribute("data-status", "pending");
    expect(within(pending).getByTestId("cell-spinner")).toBeInTheDocument();

    const failed = screen.getByTestId("cell-1-1");
    expect(failed).toHaveAttribute("data-status", "failed");
    expect(within(failed).getByText("endpoint timeout")).toBeInTheDocument();
  });

  it("invokes the annotation slot for done cells only, passing the cell", () => {
    const seen: RunCell[] = [];
    renderView((cell) => {
      seen.push(cell);
      return <span data-testid="annotation">score {cell.latest_score}</span>;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].latest_score).toBe(6.1);
    const done = screen.getByTestId("cell-0-0");
    expect(within(done).getByTestId("annotation")).toHaveTextContent("score 6.1");
  });

  it("re-renders incrementally when the same run arrives with a filled cell", () => {
    const { rerender } = renderView();
    const filled: Run = {
      ...run,
      rows: [
        run.rows[0],
        {
          ...run.rows[1],
          cells: [{ status: "done", content: "Escalation offered." }, run.rows[1].cells[1]],
        },
      ],
    };
    rerender(
      <MantineProvider env="test">
        <ComparisonView run={filled} />
      </MantineProvider>,
    );
    const cell = screen.getByTestId("cell-1-0");
    expect(cell).toHaveAttribute("data-status", "done");
    expect(cell).toHaveTextContent("Escalation offered.");
  });
});
