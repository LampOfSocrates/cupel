import type { ReactNode } from "react";
import { Badge, Group, Loader, Table, Text } from "@mantine/core";
import { Markdown } from "../lib/markdown";
import type { Run, RunCell, RunRow } from "../api/types";

// Runs step 3 — comparison grid (feature-spec.md:49): "baseline column + one
// column per run config, row per turn". Run.columns index 0 = baseline
// (openapi.yaml:1621); cells "fill incrementally" (openapi.yaml:1642,
// feature-spec.md:112) — this is a PURE render of whatever Run it's given, so
// live fill is just re-rendering with the updated Run (SSE wiring is
// T08/T11's job, not built here).
//
// Annotation slot (feature-spec.md:138 "pluggable annotation: thumbs and/or
// scores"): a render prop invoked for DONE cells only — thumbs (T03-style)
// and score badges (T12b) plug in later; this task builds the slot, not the
// annotations.

export interface CellContext {
  rowIndex: number;
  columnIndex: number;
  source: RunRow["source"];
}

interface Props {
  run: Run;
  renderAnnotation?: (cell: RunCell, ctx: CellContext) => ReactNode;
}

function CellContent({
  cell,
  ctx,
  renderAnnotation,
}: {
  cell: RunCell;
  ctx: CellContext;
  renderAnnotation?: Props["renderAnnotation"];
}) {
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
        </>
      );
  }
}

export function ComparisonView({ run, renderAnnotation }: Props) {
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
