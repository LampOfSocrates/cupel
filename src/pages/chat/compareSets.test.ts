import { describe, expect, it } from "vitest";
import { agenticConfig } from "../../../agentic.config";
import {
  MAX_COMPARE_VARIANTS,
  resolveCompareSet,
  setsForTree,
  validateCompareSets,
} from "./compareSets";
import { mockEndpoints } from "../../test/msw/handlers";

// compareSets presets (docs/plans/plan-ab-compare.md §3 "Configuration"). What the
// validator is FOR: a preset that cannot run exactly as written is refused and
// named, never quietly repaired — no truncation to fit the column cap, no
// running an endpoints-only comparison for a set that asked for more.

const only = (result: ReturnType<typeof validateCompareSets>) => {
  expect(result.issues).toHaveLength(1);
  return result.issues[0];
};

describe("compareSets — what ships in agentic.config.ts", () => {
  it("validates, so the shipped presets are actually offered", () => {
    const { sets, issues } = validateCompareSets(agenticConfig.compareSets);
    expect(issues).toEqual([]);
    expect(sets.map((s) => s.id)).toContain("prod-vs-staging");
  });

  it("resolves endpoint NAMES per tree, so one preset serves every tree", () => {
    const { sets } = validateCompareSets(agenticConfig.compareSets);
    const set = sets.find((s) => s.id === "prod-vs-staging")!;
    expect(resolveCompareSet(set, mockEndpoints.agent1)).toEqual({
      endpointIds: ["ep_agent1_prod", "ep_agent1_staging"],
      unresolved: [],
    });
    // agent2 deploys to prod only — the missing half is reported, not skipped.
    expect(resolveCompareSet(set, mockEndpoints.agent2)).toEqual({
      endpointIds: ["ep_agent2_prod"],
      unresolved: ["staging"],
    });
  });

  it("prefers an explicit endpoint id and refuses an ambiguous name", () => {
    const { sets } = validateCompareSets([
      { id: "byid", label: "By id", variants: ["ep_agent1_staging"] },
      { id: "byname", label: "By name", variants: ["prod"] },
    ]);
    expect(resolveCompareSet(sets[0], mockEndpoints.agent1).endpointIds).toEqual([
      "ep_agent1_staging",
    ]);
    const twoProds = [...mockEndpoints.agent1, { id: "ep_agent1_prod_eu", name: "prod" }];
    expect(resolveCompareSet(sets[1], twoProds)).toEqual({
      endpointIds: [],
      unresolved: ["prod"],
    });
  });

  it("filters by `trees` when a set declares them", () => {
    const { sets } = validateCompareSets([
      { id: "a", label: "A", trees: ["agent2"], variants: ["prod"] },
      { id: "b", label: "B", variants: ["prod"] },
    ]);
    expect(setsForTree(sets, "agent1").map((s) => s.id)).toEqual(["b"]);
    expect(setsForTree(sets, "agent2").map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("compareSets — the column cap is not negotiable", () => {
  it("refuses an over-long set outright instead of trimming it to fit", () => {
    const { sets, issues } = validateCompareSets([
      { id: "too-many", label: "Four ways", variants: ["prod", "staging", "canary"] },
    ]);
    expect(sets).toEqual([]); // NOT offered with the first two variants
    expect(only({ sets, issues }).id).toBe("too-many");
    expect(issues[0].reason).toContain("declares 3 variants");
    expect(issues[0].reason).toContain("Evaluations");
    expect(MAX_COMPARE_VARIANTS).toBe(2);
  });

  it("still takes a set that exactly fills the remaining columns", () => {
    const { sets, issues } = validateCompareSets([
      { id: "pair", label: "Pair", variants: ["prod", "staging"] },
    ]);
    expect(issues).toEqual([]);
    expect(sets[0].endpoints).toEqual(["prod", "staging"]);
  });
});

describe("compareSets — per-column config is declared, not ignored", () => {
  it("refuses a set that asks for a per-column model or version, and says why", () => {
    const { sets, issues } = validateCompareSets([
      {
        id: "v-last-two",
        label: "Current vs previous version",
        variants: ["prod", { endpoint: "staging", config: { instruction_version: 14 } }],
      },
    ]);
    // The dangerous outcome would be running this as prod-vs-staging and
    // presenting it as a version comparison.
    expect(sets).toEqual([]);
    const issue = only({ sets, issues });
    expect(issue.id).toBe("v-last-two");
    expect(issue.reason).toContain("per-column config");
    expect(issue.reason).toContain("one shared config");
  });

  it("takes the same set once the config is removed", () => {
    const { sets, issues } = validateCompareSets([
      { id: "v-last-two", label: "Two", variants: ["prod", { endpoint: "staging" }] },
    ]);
    expect(issues).toEqual([]);
    expect(sets[0].endpoints).toEqual(["prod", "staging"]);
  });
});

describe("compareSets — malformed config fails loudly", () => {
  it.each([
    [{ label: "No id", variants: ["prod"] }, "has no `id`"],
    [{ id: "x", variants: ["prod"] }, "has no `label`"],
    [{ id: "x", label: "X" }, "has no `variants`"],
    [{ id: "x", label: "X", variants: [] }, "has no `variants`"],
    [{ id: "x", label: "X", variants: [""] }, "empty endpoint"],
    [{ id: "x", label: "X", variants: [42] }, "neither an endpoint name nor an object"],
    [{ id: "x", label: "X", variants: [{ name: "prod" }] }, "without an `endpoint`"],
    [
      { id: "x", label: "X", variants: [{ endpoint: "prod", versions: "last-2" }] },
      "unknown variant key(s): versions",
    ],
    [{ id: "x", label: "X", variants: ["prod", "prod"] }, 'names the endpoint "prod" twice'],
    [{ id: "x", label: "X", trees: "agent1", variants: ["prod"] }, "`trees`"],
  ])("rejects %j", (entry, reason) => {
    const result = validateCompareSets([entry]);
    expect(result.sets).toEqual([]);
    expect(only(result).reason).toContain(reason);
  });

  it("names a duplicate id and keeps the first set", () => {
    const { sets, issues } = validateCompareSets([
      { id: "dup", label: "First", variants: ["prod"] },
      { id: "dup", label: "Second", variants: ["staging"] },
    ]);
    expect(sets.map((s) => s.label)).toEqual(["First"]);
    expect(only({ sets, issues }).reason).toContain("repeats an id");
  });

  it("rejects a non-array compareSets whole, and tolerates none at all", () => {
    expect(validateCompareSets({ id: "x" }).issues[0]).toEqual({
      id: "compareSets",
      reason: "is not an array",
    });
    expect(validateCompareSets(undefined)).toEqual({ sets: [], issues: [] });
  });

  it("keeps the good sets when a neighbour is broken", () => {
    const { sets, issues } = validateCompareSets([
      { id: "bad", label: "Bad", variants: ["a", "b", "c"] },
      { id: "good", label: "Good", variants: ["prod"] },
    ]);
    expect(sets.map((s) => s.id)).toEqual(["good"]);
    expect(issues.map((i) => i.id)).toEqual(["bad"]);
  });
});
