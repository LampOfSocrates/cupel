import type { EvaluationRow, EvaluationScoreSummary, ScorerScoreSummary } from "../../api/types";

// The numbers behind step 3's stat tiles.
//
// An evaluation exists to report a CHANGE, so every tile here is a variant
// measured against the baseline — column 0 (openapi.yaml Evaluation.columns,
// "Index 0 = baseline"). A level on its own answers nothing.
//
// Two sources, each used for what only it can say:
//   - by_column (v0.7.0) aggregates a scorer per column, which is how "average
//     +0.9" and "1 thumbs-down, was 9" are available in one request.
//   - the grid rows give the PER-ROW pairing by_column cannot: better/worse is
//     a count of rows where the variant beat its own baseline, which no
//     aggregate mean can recover.

/** A tile. `delta` is always legible without colour — see the note on tone. */
export interface StatTile {
  label: string;
  value: string;
  delta: string | null;
  /**
   * Direction, for the delta's colour. NEVER the only carrier of meaning: the
   * delta text always spells the change out ("+0.9", "was 9"), because these
   * are status colours and a status colour alone is not an encoding.
   */
  tone: "up" | "down" | "neutral";
}

const BASELINE = 0;

/** The scorer whose numbers a tile row is about: the LLM judge if one ran. */
export function judgeScorer(
  summary: EvaluationScoreSummary | null,
): ScorerScoreSummary | undefined {
  return summary?.scorers.find((s) => s.scorer.kind === "llm");
}

export function humanScorer(
  summary: EvaluationScoreSummary | null,
): ScorerScoreSummary | undefined {
  return summary?.scorers.find((s) => s.scorer.kind === "human");
}

/**
 * Baseline and variant halves of a scorer's per-column breakdown.
 *
 * "The variant" is every non-baseline column pooled. A run may compare more
 * than one, and a headline number that silently reported only the first would
 * be wrong the moment someone added a second config.
 */
function split(scorer: ScorerScoreSummary | undefined) {
  const cols = scorer?.by_column;
  if (!cols?.length) return null;
  const baseline = cols.find((c) => c.column_index === BASELINE) ?? null;
  const variants = cols.filter((c) => c.column_index !== BASELINE);
  if (!baseline || variants.length === 0) return null;
  const count = variants.reduce((n, c) => n + c.count, 0);
  const mean = count === 0 ? 0 : variants.reduce((t, c) => t + c.mean * c.count, 0) / count;
  const distribution = variants.reduce<number[]>((acc, c) => {
    c.distribution.forEach((n, i) => (acc[i] = (acc[i] ?? 0) + n));
    return acc;
  }, []);
  return { baseline, variant: { mean, count, distribution } };
}

const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;

/**
 * How many rows the variant improved, and how many it hurt.
 *
 * A row counts only when BOTH its baseline cell and at least one variant cell
 * carry a score — a pending or failed cell is not a tie, and counting it as one
 * would report a finished-looking verdict on a run still filling in.
 */
export function betterWorse(rows: readonly EvaluationRow[]): {
  better: number;
  worse: number;
  compared: number;
} {
  let better = 0;
  let worse = 0;
  let compared = 0;
  for (const row of rows) {
    const base = row.cells[BASELINE]?.latest_score;
    if (base == null) continue;
    const scored = row.cells.slice(1).filter((c) => c.latest_score != null);
    if (scored.length === 0) continue;
    compared += 1;
    // Best variant on the row: the question is whether the change helped at
    // all, not whether every column did.
    const best = Math.max(...scored.map((c) => c.latest_score as number));
    if (best > base) better += 1;
    else if (best < base) worse += 1;
  }
  return { better, worse, compared };
}

/** Thumbs-down count = the bottom bucket of a human scorer's distribution. */
const thumbsDown = (distribution: readonly number[]) => distribution[0] ?? 0;

export function resultTiles(
  summary: EvaluationScoreSummary | null,
  rows: readonly EvaluationRow[],
): StatTile[] {
  const tiles: StatTile[] = [];

  const judge = split(judgeScorer(summary));
  if (judge) {
    const delta = judge.variant.mean - judge.baseline.mean;
    tiles.push({
      label: "Average score",
      value: judge.variant.mean.toFixed(1),
      delta: signed(delta),
      tone: delta > 0 ? "up" : delta < 0 ? "down" : "neutral",
    });
  }

  const { better, worse, compared } = betterWorse(rows);
  if (compared > 0) {
    tiles.push({
      label: "Better than the original",
      value: String(better),
      delta: `of ${compared}`,
      tone: better > 0 ? "up" : "neutral",
    });
    tiles.push({
      label: "Worse",
      value: String(worse),
      delta: `of ${compared}`,
      tone: worse > 0 ? "down" : "neutral",
    });
  }

  const human = split(humanScorer(summary));
  if (human) {
    const after = thumbsDown(human.variant.distribution);
    const was = thumbsDown(human.baseline.distribution);
    tiles.push({
      label: "Thumbs down after the change",
      value: String(after),
      delta: `was ${was}`,
      // Fewer thumbs-down is an improvement, so the direction inverts here.
      tone: after < was ? "up" : after > was ? "down" : "neutral",
    });
  }

  return tiles;
}

/**
 * Which column won a row — the side-by-side card's "best:" label.
 *
 * Null when nothing on the row is scored, or when the top score is TIED: a
 * "best" that two columns share is not a winner, and naming one of them would
 * invent a verdict the numbers do not support.
 */
export function bestColumn(
  cells: readonly { latest_score?: number | null }[],
): number | null {
  let best = -Infinity;
  let at: number | null = null;
  let tied = false;
  cells.forEach((cell, index) => {
    const score = cell.latest_score;
    if (score == null) return;
    if (score > best) {
      best = score;
      at = index;
      tied = false;
    } else if (score === best) {
      tied = true;
    }
  });
  return tied ? null : at;
}
