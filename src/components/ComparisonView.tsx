import { memo, type ReactNode } from "react";
import { Badge, Group, Loader, Table, Text } from "@mantine/core";
import { Markdown } from "../lib/markdown";
import type { Run, RunCell, RunRow } from "../api/types";

// Runs step 3 — comparison grid (feature-spec.md:49): "baseline column + one
// column per run config, row per turn". Run.columns index 0 = baseline
// (openapi.yaml:1621); cells "fill incrementally" (openapi.yaml:1642,
// feature-spec.md:112) — this is a PURE render of whatever Run it's given, so
// live fill is just re-rendering with the updated Run.
//
// Annotation slot (feature-spec.md:138 "pluggable annotation: thumbs and/or
// scores"): a render prop invoked for DONE cells only.

export interface CellContext {
  rowIndex: number;
  columnIndex: number;
  source: RunRow["source"];
}

interface Props {
  run: Run;
  renderAnnotation?: (cell: RunCell, ctx: CellContext) => ReactNode;
  // Cell-action slot, separate from renderAnnotation on purpose: the
  // annotation slot is for thumbs/score badges, the
  // action slot for per-cell affordances — first user is the ⑂ re-fire on
  // done cells (sketch 04 "+ Re-run this turn with… POST …/replay/turn";
  // feature-spec.md:72 "'re-run this turn with…' on any results cell").
  // Invoked for DONE cells only, like renderAnnotation.
  renderCellAction?: (cell: RunCell, ctx: CellContext) => ReactNode;
}

interface CellProps {
  cell: RunCell;
  ctx: CellContext;
  renderAnnotation?: Props["renderAnnotation"];
  renderCellAction?: Props["renderCellAction"];
}

// A live-filling grid refetches the WHOLE Run every ~300 ms
// (RunDetailPage.tsx:239, the documented baseline), so every cell object
// arrives with a fresh identity even when nothing about it changed — a default
// shallow compare would never hit, and 360 unchanged cells would re-parse
// their markdown three times a second (docs/review-2026-08-05.md A6). Compare
// RunCell by value (openapi.yaml:1644-1664) plus the ctx primitives.
// The render props must be referentially stable (useCallback at the call site)
// for this to bite.
function sameCell(a: CellProps, b: CellProps): boolean {
  return (
    a.cell.status === b.cell.status &&
    a.cell.content === b.cell.content &&
    a.cell.conversation_id === b.cell.conversation_id &&
    a.cell.turn_id === b.cell.turn_id &&
    a.cell.task_id === b.cell.task_id &&
    a.cell.case_id === b.cell.case_id &&
    a.cell.latest_score === b.cell.latest_score &&
    a.cell.error === b.cell.error &&
    a.ctx.rowIndex === b.ctx.rowIndex &&
    a.ctx.columnIndex === b.ctx.columnIndex &&
    a.ctx.source.conversation_id === b.ctx.source.conversation_id &&
    a.ctx.source.turn_id === b.ctx.source.turn_id &&
    a.renderAnnotation === b.renderAnnotation &&
    a.renderCellAction === b.renderCellAction
  );
}

const CellContent = memo(function CellContent({
  cell,
  ctx,
  renderAnnotation,
  renderCellAction,
}: CellProps) {
  switch (cell.status) {
    case "pending":
      // pending spinner (task scope; sketch 04 shows spinners pre-fill)
      return <Loader size="xs" data-testid="cell-spinner" />;
    case "running":
      return (
        <Group gap={6} wrap="nowrap">
          <Loader size="xs" data-testid="cell-spinner" />
          <Text size="xs" c="dimmed">
            generating…
          </Text>
        </Group>
      );
    case "failed":
      return (
        <Text size="xs" c="red">
          {cell.error ?? "failed"}
        </Text>
      );
    case "done":
      return (
        <>
          <Markdown content={cell.content ?? ""} />
          {renderAnnotation?.(cell, ctx)}
          {renderCellAction?.(cell, ctx)}
        </>
      );
  }
}, sameCell);

export function ComparisonView({ run, renderAnnotation, renderCellAction }: Props) {
  return (
    <Table.ScrollContainer minWidth={400}>
      <Table verticalSpacing="xs" data-testid="comparison-grid">
        <Table.Thead>
          <Table.Tr>
            <Table.Th />
            {run.columns.map((col, i) => (
              <Table.Th key={i}>
                <Group gap={6} wrap="nowrap">
                  <Text size="xs" fw={600}>
                    {col.label}
                  </Text>
                  {i === 0 && (
                    <Badge size="xs" variant="light" color="gray">
                      baseline
                    </Badge>
                  )}
                </Group>
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {run.rows.map((row, rowIndex) => (
            <Table.Tr key={row.source.turn_id}>
              <Table.Td>
                <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  {row.source.turn_id}
                </Text>
              </Table.Td>
              {row.cells.map((cell, columnIndex) => (
                <Table.Td
                  key={columnIndex}
                  data-testid={`cell-${rowIndex}-${columnIndex}`}
                  data-status={cell.status}
                  style={{ verticalAlign: "top" }}
                >
                  <CellContent
                    cell={cell}
                    ctx={{ rowIndex, columnIndex, source: row.source }}
                    renderAnnotation={renderAnnotation}
                    renderCellAction={renderCellAction}
                  />
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
