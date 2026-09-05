import { describe, expect, it } from "vitest";
import type { EvaluationRow, EvaluationScoreSummary, Result } from "../../api/types";
import { bestColumn, betterWorse, resultTiles } from "./resultsSummary";

const cell = (score: number | null, status: Result["status"] = "done"): Result => ({
  status,
  latest_score: score,
});
const row = (...cells: Result[]): EvaluationRow => ({
  source: { conversation_id: "c1", turn_id: "t1" },
  cells,
});

const summary = (
  scorers: EvaluationScoreSummary["scorers"],
): EvaluationScoreSummary => ({ evaluation_id: "e1", scorers });

const judge = (baseMean: number, varMean: number) => ({
  scorer: { kind: "llm" as const, ref: "rub-1", version: 1, model: null },
  mean: (baseMean + varMean) / 2,
  count: 2,
  distribution: [0, 0, 0, 0, 0],
  by_column: [
    { column_index: 0, mean: baseMean, count: 1, distribution: [0, 0, 0, 0, 0] },
    { column_index: 1, mean: varMean, count: 1, distribution: [0, 0, 0, 0, 0] },
  ],
});

describe("betterWorse — counted per row, against that row's own baseline", () => {
  it("counts a row where the variant beat its baseline", () => {
    expect(betterWorse([row(cell(0.5), cell(0.9))])).toEqual({
      better: 1,
      worse: 0,
      compared: 1,
    });
  });

  it("counts a row where it did worse", () => {
    expect(betterWorse([row(cell(0.9), cell(0.5))])).toEqual({
      better: 0,
      worse: 1,
      compared: 1,
    });
  });

  it("counts an unchanged row as compared, but neither better nor worse", () => {
    expect(betterWorse([row(cell(0.5), cell(0.5))])).toEqual({
      better: 0,
      worse: 0,
      compared: 1,
    });
  });

  it("ignores a row whose variant has not been scored yet", () => {
    // A pending cell is not a tie. Counting it would report a finished-looking
    // verdict on a run still filling in.
    expect(betterWorse([row(cell(0.5), cell(null, "pending"))])).toEqual({
      better: 0,
      worse: 0,
      compared: 0,
    });
  });

  it("ignores a row with no baseline score to compare against", () => {
    expect(betterWorse([row(cell(null), cell(0.9))]).compared).toBe(0);
  });

  it("asks whether the change helped AT ALL — the best variant on the row wins", () => {
    // Two configs, one better and one worse: the row counts as better.
    expect(betterWorse([row(cell(0.5), cell(0.2), cell(0.8))])).toEqual({
      better: 1,
      worse: 0,
      compared: 1,
    });
  });
});

describe("resultTiles", () => {
  it("reports the average as a CHANGE against the baseline column", () => {
    const [tile] = resultTiles(summary([judge(3.5, 4.4)]), []);
    expect(tile).toMatchObject({ label: "Average score", value: "4.4", delta: "+0.9", tone: "up" });
  });

  it("marks a fall as down, and signs it", () => {
    const [tile] = resultTiles(summary([judge(4.4, 3.5)]), []);
    expect(tile).toMatchObject({ delta: "-0.9", tone: "down" });
  });

  it("pools every variant column, so a second config cannot be silently dropped", () => {
    const scorer = judge(2, 4);
    scorer.by_column.push({
      column_index: 2,
      mean: 2,
      count: 1,
      distribution: [0, 0, 0, 0, 0],
    });
    // Variants: 4 and 2 over one judgment each ⇒ 3.0, not "the first one".
    expect(resultTiles(summary([scorer]), [])[0].value).toBe("3.0");
  });

  it("treats fewer thumbs-down as an improvement", () => {
    const human = {
      scorer: { kind: "human" as const, ref: null, version: null, model: null },
      mean: 0.5,
      count: 10,
      distribution: [10, 0, 0, 0, 0],
      by_column: [
        { column_index: 0, mean: 0, count: 9, distribution: [9, 0, 0, 0, 0] },
        { column_index: 1, mean: 0, count: 1, distribution: [1, 0, 0, 0, 0] },
      ],
    };
    const tile = resultTiles(summary([human]), []).at(-1);
    // The one tile whose direction inverts: down is good here.
    expect(tile).toMatchObject({ value: "1", delta: "was 9", tone: "up" });
  });

  it("every delta reads without colour", () => {
    // These are STATUS colours; a status colour alone is not an encoding.
    const tiles = resultTiles(summary([judge(3.5, 4.4)]), [row(cell(0.5), cell(0.9))]);
    for (const tile of tiles) expect(tile.delta).toBeTruthy();
  });

  it("shows no tiles at all rather than levels with invented deltas", () => {
    // A backend that omits by_column, and a grid with nothing scored.
    const bare = summary([
      { scorer: { kind: "llm", ref: "r", version: 1, model: null }, mean: 4, count: 1, distribution: [] },
    ]);
    expect(resultTiles(bare, [])).toEqual([]);
    expect(resultTiles(null, [])).toEqual([]);
  });
});

describe("bestColumn", () => {
  it("names the highest-scoring column", () => {
    expect(bestColumn([cell(0.4), cell(0.9), cell(0.6)])).toBe(1);
  });

  it("names nobody when the top score is tied", () => {
    // A "best" two columns share is not a winner.
    expect(bestColumn([cell(0.9), cell(0.9)])).toBeNull();
  });

  it("names nobody when nothing is scored", () => {
    expect(bestColumn([cell(null), cell(null, "pending")])).toBeNull();
  });

  it("ignores unscored columns rather than treating them as zero", () => {
    expect(bestColumn([cell(null), cell(0.3)])).toBe(1);
  });
});
