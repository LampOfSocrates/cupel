import { describe, expect, it } from "vitest";
import { diffLines } from "./diff";

describe("diffLines", () => {
  it("equal inputs produce only equal lines", () => {
    expect(diffLines("a\nb\nc", "a\nb\nc")).toEqual([
      { type: "equal", line: "a" },
      { type: "equal", line: "b" },
      { type: "equal", line: "c" },
    ]);
  });

  it("pure insert marks only the new lines as add", () => {
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([
      { type: "equal", line: "a" },
      { type: "add", line: "b" },
      { type: "equal", line: "c" },
    ]);
  });

  it("pure delete marks only the removed lines as del", () => {
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([
      { type: "equal", line: "a" },
      { type: "del", line: "b" },
      { type: "equal", line: "c" },
    ]);
  });

  it("mixed change emits del before add within the hunk", () => {
    expect(diffLines("a\nold\nz", "a\nnew 1\nnew 2\nz")).toEqual([
      { type: "equal", line: "a" },
      { type: "del", line: "old" },
      { type: "add", line: "new 1" },
      { type: "add", line: "new 2" },
      { type: "equal", line: "z" },
    ]);
  });

  it("empty vs empty is an empty diff", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("empty vs content is all adds; content vs empty is all dels", () => {
    expect(diffLines("", "a\nb")).toEqual([
      { type: "add", line: "a" },
      { type: "add", line: "b" },
    ]);
    expect(diffLines("a\nb", "")).toEqual([
      { type: "del", line: "a" },
      { type: "del", line: "b" },
    ]);
  });

  it("treats a trailing newline as a terminator, not an extra line", () => {
    expect(diffLines("a\nb\n", "a\nb")).toEqual([
      { type: "equal", line: "a" },
      { type: "equal", line: "b" },
    ]);
  });

  it("handles disjoint content (no common lines)", () => {
    expect(diffLines("x\ny", "p\nq")).toEqual([
      { type: "del", line: "x" },
      { type: "del", line: "y" },
      { type: "add", line: "p" },
      { type: "add", line: "q" },
    ]);
  });
});
