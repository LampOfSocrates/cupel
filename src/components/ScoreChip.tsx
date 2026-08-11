import { Badge } from "@mantine/core";

// Color-banded score badge ("scores stream into the grid live …
// color-banded badges", feature-spec.md:64). Style per annotated sketch 04:
// small pill chips on the cell, green for high scores (8.7 on #EAF3DE/#3B6D11)
// and amber for middling ones (6.1 on #FAEEDA/#854F0B) — the contract's judge
// scores the mock emits are 0..1 (mock/engine.py:376), so the bands map to
// ≥0.7 green · ≥0.4 yellow · else red, via Mantine's light Badge palette.
// Clickable when onClick is given ("Tap a badge → judgment drawer",
// feature-spec.md:64).

export function scoreColor(score: number): string {
  if (score >= 0.7) return "green";
  if (score >= 0.4) return "yellow";
  return "red";
}

export function ScoreChip({
  score,
  onClick,
  testId,
}: {
  score: number;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <Badge
      size="sm"
      radius="xl"
      variant="light"
      ff="monospace"
      color={scoreColor(score)}
      component={onClick ? "button" : "span"}
      onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined}
      aria-label={`score ${score.toFixed(2)}`}
      data-testid={testId ?? "score-chip"}
    >
      {score.toFixed(2)}
    </Badge>
  );
}
