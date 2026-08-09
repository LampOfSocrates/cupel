import { describe, it, expect } from "vitest";
import { agenticConfig } from "../../agentic.config";
import { DEFAULT_TREE_TERMS, product, resolveProductLabels } from "./product";
import { serializeHistoryMarkdown } from "./exportInstructions";
import type { InstructionHistory } from "../api/types";

// PW-1 whitelabel-lite — agentic.config.ts `product` is the one place the app
// is named. These cover the shipped defaults (so an untouched checkout still
// says "Cupel" / "agent tree"), the grammar forms an adopter's term has to
// survive, and that the strings really are threaded rather than duplicated.

describe("shipped defaults", () => {
  it("agentic.config.ts names the product Cupel and its trees agent trees", () => {
    expect(agenticConfig.product.label).toBe("Cupel");
    expect(agenticConfig.product.name).toBe("cupel");
    expect(agenticConfig.product.trees).toEqual(DEFAULT_TREE_TERMS);
  });

  it("resolves to the same labels the app renders today", () => {
    expect(product).toEqual({
      label: "Cupel",
      tree: { one: "agent tree", many: "agent trees", One: "Agent tree", Many: "Agent trees" },
    });
  });

  it("a config with no product.trees block falls back to the default wording", () => {
    const resolved = resolveProductLabels({ product: { name: "acme", label: "Acme" } });
    expect(resolved.label).toBe("Acme");
    expect(resolved.tree).toEqual({
      one: "agent tree",
      many: "agent trees",
      One: "Agent tree",
      Many: "Agent trees",
    });
  });

  it("an empty label or term falls back rather than rendering blank chrome", () => {
    const resolved = resolveProductLabels({ product: { name: "", label: "", trees: { one: "", many: "" } } });
    expect(resolved.label).toBe("Cupel");
    expect(resolved.tree.one).toBe("agent tree");
  });
});

describe("grammar of an adopter's term", () => {
  it("keeps singular and plural apart and capitalises only sentence-initially", () => {
    const { tree } = resolveProductLabels({
      product: { name: "nabu", label: "Nabu", trees: { one: "workspace", many: "workspaces" } },
    });
    expect(tree).toEqual({
      one: "workspace",
      many: "workspaces",
      One: "Workspace",
      Many: "Workspaces",
    });
  });

  it("never down-cases — a term that is a proper noun survives mid-sentence", () => {
    const { tree } = resolveProductLabels({
      product: { name: "nabu", label: "Nabu", trees: { one: "Nabu graph", many: "Nabu graphs" } },
    });
    expect(tree.one).toBe("Nabu graph");
    expect(tree.One).toBe("Nabu graph");
  });

  it("handles an irregular plural, which is why both forms are configured", () => {
    const { tree } = resolveProductLabels({
      product: { name: "x", label: "X", trees: { one: "agent mesh", many: "agent meshes" } },
    });
    expect(tree.many).toBe("agent meshes");
  });
});

describe("threading", () => {
  const history: InstructionHistory = {
    agent_id: "a1",
    format: "yaml",
    live_version: 2,
    versions: [],
  };

  it("the instruction export header carries the configured product label", () => {
    expect(serializeHistoryMarkdown(history, "Router", new Date("2026-08-09T00:00:00Z"))).toContain(
      `${product.label} export — 2026-08-09`,
    );
  });
});
