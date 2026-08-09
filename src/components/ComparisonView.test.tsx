import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { marked } from "marked";
import { ComparisonView } from "./ComparisonView";
import type { Run, RunCell } from "../api/types";

// Live fill refetches the whole Run (~300 ms), so cells arrive as fresh
// objects with identical content — see the memoization test at the bottom
// (docs/review-2026-08-05.md A6).
vi.mock("marked", async (importOriginal) => {
  const actual = await importOriginal<typeof import("marked")>();
  return { marked: vi.fn(actual.marked) };
});

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

  // docs/review-2026-08-05.md A6: "Live-filling grid rebuilds every cell every
  // 300 ms". EvaluationPage refetches the whole Run on every stream event, so
  // the identical grid arrives as brand-new objects. Cells whose content did
  // not change must not re-render (the annotation slot is the observable proxy
  // — it is invoked once per done-cell render) and must not re-parse markdown.
  it("a refetch of unchanged cells re-renders and re-parses nothing", () => {
    const annotations = vi.fn(() => <span data-testid="annotation" />);
    const actions = vi.fn(() => <span data-testid="action" />);
    const view = (r: Run) => (
      <MantineProvider env="test">
        <ComparisonView run={r} renderAnnotation={annotations} renderCellAction={actions} />
      </MantineProvider>
    );
    const { rerender } = render(view(run));
    const parsesAfterMount = vi.mocked(marked).mock.calls.length;
    expect(parsesAfterMount).toBeGreaterThan(0);
    expect(annotations).toHaveBeenCalledTimes(1); // one done cell

    // Same grid, fresh objects — exactly what GET /runs/{id} returns again.
    const refetched: Run = structuredClone(run);
    rerender(view(refetched));
    rerender(view(structuredClone(run)));
    expect(vi.mocked(marked).mock.calls.length).toBe(parsesAfterMount);
    expect(annotations).toHaveBeenCalledTimes(1);
    expect(actions).toHaveBeenCalledTimes(1);

    // …but a cell that actually filled still updates.
    const filled: Run = structuredClone(run);
    filled.rows[1].cells[0] = { status: "done", content: "Escalation offered." };
    rerender(view(filled));
    expect(vi.mocked(marked).mock.calls.length).toBe(parsesAfterMount + 1);
    expect(annotations).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("cell-1-0")).toHaveTextContent("Escalation offered.");
  });
});
