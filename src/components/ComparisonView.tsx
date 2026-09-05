import { memo, type ReactNode } from "react";
import { Badge, Box, Group, Loader, Stack, Table, Text } from "@mantine/core";
import { Markdown } from "../lib/markdown";
import type { Evaluation, Result, EvaluationRow } from "../api/types";
import { bestColumn } from "../pages/studio/resultsSummary";

// Evaluations step 3 — comparison grid (feature-spec.md:49): "baseline column + one
// column per run config, row per turn". Evaluation.columns index 0 = baseline
// (openapi.yaml:1621); cells "fill incrementally" (openapi.yaml:1642,
// feature-spec.md:108) — this is a PURE render of whatever Evaluation it's given, so
// live fill is just re-rendering with the updated Evaluation.
//
// Annotation slot (feature-spec.md:134 "pluggable annotation: thumbs and/or
// scores"): a render prop invoked for DONE cells only.

export interface CellContext {
  rowIndex: number;
  columnIndex: number;
  source: EvaluationRow["source"];
}

interface Props {
  evaluation: Evaluation;
  renderAnnotation?: (cell: Result, ctx: CellContext) => ReactNode;
  // Cell-action slot, separate from renderAnnotation on purpose: the
  // annotation slot is for thumbs/score badges, the
  // action slot for per-cell affordances — first user is the ⑂ re-fire on
  // done cells (sketch 04 "+ Re-run this turn with… POST …/replay/turn";
  // feature-spec.md:72 "'re-run this turn with…' on any results cell").
  // Invoked for DONE cells only, like renderAnnotation.
  renderCellAction?: (cell: Result, ctx: CellContext) => ReactNode;
  /**
   * "table" reads across — one row per prompt, one cell per column, best for
   * scanning scores. "sidebyside" reads down — the columns' answers in full,
   * for judging what they actually said. The handoff's toggle.
   */
  layout?: "table" | "sidebyside";
}

interface CellProps {
  cell: Result;
  ctx: CellContext;
  renderAnnotation?: Props["renderAnnotation"];
  renderCellAction?: Props["renderCellAction"];
}

// A live-filling grid refetches the WHOLE Evaluation every ~300 ms
// (EvaluationPage.tsx:239, the documented baseline), so every cell object
// arrives with a fresh identity even when nothing about it changed — a default
// shallow compare would never hit, and 360 unchanged cells would re-parse
// their markdown three times a second (docs/review-2026-08-05.md A6). Compare
// Result by value (openapi.yaml:1644-1664) plus the ctx primitives.
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

/**
 * Per-prompt cards: one row's columns read down the page instead of across it.
 *
 * The table answers "which column scored better"; this answers "what did they
 * actually SAY", which a cell clipped to two lines in a grid cannot. Same data,
 * same slots — only the arrangement differs, so nothing here re-derives a cell.
 */
function SideBySide({ evaluation, renderAnnotation, renderCellAction }: Props) {
  return (
    <Stack gap="sm" data-testid="comparison-sidebyside">
      {evaluation.rows.items.map((row, rowIndex) => {
        const best = bestColumn(row.cells);
        return (
          <Box
            key={row.source.turn_id}
            style={{ border: "1px solid var(--mantine-color-gray-3)", borderRadius: 7 }}
          >
            <Group
              px={12}
              py={6}
              justify="space-between"
              wrap="nowrap"
              bg="gray.0"
              style={{ borderBottom: "1px solid var(--mantine-color-gray-3)" }}
            >
              <Text ff="monospace" fz="xs" c="gray.5" truncate>
                {row.source.turn_id}
              </Text>
              {/* Absent on a tie or an unscored row — see bestColumn. */}
              {best != null && (
                <Text fz="xs" c="gray.6">
                  best: {evaluation.columns[best]?.label ?? `column ${best + 1}`}
                </Text>
              )}
            </Group>
            <Group gap={0} align="stretch" wrap="nowrap">
              {row.cells.map((cell, columnIndex) => (
                <Box
                  key={columnIndex}
                  p={10}
                  data-testid={`sbs-cell-${rowIndex}-${columnIndex}`}
                  data-status={cell.status}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    borderRight:
                      columnIndex < row.cells.length - 1
                        ? "1px solid var(--mantine-color-gray-3)"
                        : undefined,
                    background: columnIndex === 0 ? "var(--mantine-color-gray-0)" : undefined,
                  }}
                >
                  <Text fz="xs" c="gray.6" mb={4} truncate>
                    {evaluation.columns[columnIndex]?.label ?? ""}
                  </Text>
                  <CellContent
                    cell={cell}
                    ctx={{ rowIndex, columnIndex, source: row.source }}
                    renderAnnotation={renderAnnotation}
                    renderCellAction={renderCellAction}
                  />
                </Box>
              ))}
            </Group>
          </Box>
        );
      })}
    </Stack>
  );
}

export function ComparisonView({
  evaluation,
  renderAnnotation,
  renderCellAction,
  layout = "table",
}: Props) {
  if (layout === "sidebyside") {
    return (
      <SideBySide
        evaluation={evaluation}
        renderAnnotation={renderAnnotation}
        renderCellAction={renderCellAction}
      />
    );
  }
  return (
    <Table.ScrollContainer minWidth={400}>
      <Table verticalSpacing="xs" data-testid="comparison-grid">
        <Table.Thead>
          <Table.Tr>
            <Table.Th />
            {evaluation.columns.map((col, i) => (
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
          {/* One PAGE of rows (Evaluation.rows is an EvaluationRowPage). The
              row index is page-local, which is what the cell testids and the
              ctx passed to the render slots have always meant. */}
          {evaluation.rows.items.map((row, rowIndex) => (
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
