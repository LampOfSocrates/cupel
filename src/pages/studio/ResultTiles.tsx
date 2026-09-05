import { Box, Group, Text } from "@mantine/core";
import type { EvaluationRow, EvaluationScoreSummary } from "../../api/types";
import { resultTiles } from "./resultsSummary";

// Step 3's summary row: label, a mono value, and a delta.
//
// Not a chart, deliberately — the job is a handful of headline numbers, which
// is the one form that is better as text than as a plot, and the only one that
// needs no hover layer.
//
// The delta colours are STATUS colours (good / serious), so they never carry
// the meaning alone: every delta spells the change out in words or a sign
// ("+0.9", "was 9"), and the tile reads the same to someone who cannot tell the
// two hues apart or is printing it.

const TONE_COLOR = {
  up: "var(--mantine-color-positive-7)",
  down: "var(--mantine-color-danger-7)",
  neutral: "var(--mantine-color-gray-6)",
} as const;

export function ResultTiles({
  summary,
  rows,
}: {
  summary: EvaluationScoreSummary | null;
  rows: readonly EvaluationRow[];
}) {
  const tiles = resultTiles(summary, rows);
  // Nothing worth stating yet — no judge has scored and no row has both halves.
  // An empty bar of dashes would look like a broken header.
  if (tiles.length === 0) return null;

  return (
    <Group
      gap={26}
      px={16}
      py={9}
      wrap="wrap"
      bg="white"
      style={{ borderBottom: "1px solid var(--mantine-color-gray-3)" }}
      data-testid="result-tiles"
    >
      {tiles.map((tile) => (
        <Box key={tile.label}>
          <Text fz="xs" c="gray.6">
            {tile.label}
          </Text>
          <Group gap={6} align="baseline" wrap="nowrap">
            <Text ff="monospace" fz="xl" fw={600}>
              {tile.value}
            </Text>
            {tile.delta && (
              <Text fz="xs" style={{ color: TONE_COLOR[tile.tone] }}>
                {tile.delta}
              </Text>
            )}
          </Group>
        </Box>
      ))}
    </Group>
  );
}
