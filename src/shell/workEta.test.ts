import { describe, expect, it } from "vitest";
import type { Task } from "../api/types";
import { etaLabel, etaSeconds, formatEta } from "./workEta";

const START = "2026-09-03T10:00:00Z";
const at = (seconds: number) => Date.parse(START) + seconds * 1000;

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    type: "replay",
    status: "running",
    progress: { done: 1, total: 4, stage: "generating…" },
    created_at: START,
    started_at: START,
    ...over,
  };
}

describe("etaSeconds — derived from the task's own rate, never invented", () => {
  it("projects the remaining units at the rate achieved so far", () => {
    // 1 of 4 done in 10s ⇒ 3 remaining ⇒ 30s.
    expect(etaSeconds(task(), at(10))).toBe(30);
  });

  it("has no estimate before the first unit finishes", () => {
    // The rate is undefined at done=0, and a guess here would be the number a
    // user plans around.
    expect(etaSeconds(task({ progress: { done: 0, total: 4 } }), at(10))).toBeNull();
  });

  it("has no estimate without a start time", () => {
    expect(etaSeconds(task({ started_at: null }), at(10))).toBeNull();
  });

  it("has no estimate for a task that is not running", () => {
    for (const status of ["queued", "done", "failed", "cancelled"] as const) {
      expect(etaSeconds(task({ status }), at(10))).toBeNull();
    }
  });

  it("has no estimate once every unit is done", () => {
    expect(etaSeconds(task({ progress: { done: 4, total: 4 } }), at(10))).toBeNull();
  });

  it("suppresses an implausible projection rather than reporting it", () => {
    // A task that ticked once and stalled: elapsed keeps growing against a
    // `done` that does not, so the arithmetic says hundreds of hours. Real
    // arithmetic, useless answer — exactly what a task left running in a
    // stored snapshot looks like.
    expect(etaSeconds(task(), at(60 * 60 * 24))).toBeNull();
  });
});

describe("formatEta", () => {
  it("reads compactly at each scale", () => {
    expect(formatEta(8)).toBe("8s");
    expect(formatEta(160)).toBe("2m 40s");
    expect(formatEta(120)).toBe("2m");
    expect(formatEta(3840)).toBe("1h 04m");
  });
});

describe("etaLabel", () => {
  it("prefers the estimate", () => {
    expect(etaLabel(task(), at(10))).toBe("~30s");
  });

  it("falls back to the server's own stage text when there is no estimate", () => {
    expect(etaLabel(task({ progress: { done: 0, total: 4, stage: "generating…" } }), at(10))).toBe(
      "generating…",
    );
  });

  it("says nothing rather than guessing when there is neither", () => {
    expect(etaLabel(task({ progress: { done: 0, total: 4 } }), at(10))).toBe("");
  });
});
