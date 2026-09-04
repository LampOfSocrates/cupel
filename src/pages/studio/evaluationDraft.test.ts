import { describe, expect, it } from "vitest";
import { EMPTY_DRAFT, evaluationDraftReducer, initialEvaluationDraft } from "./evaluationDraft";

// The stepper's buffer, and the two handoffs that can seed it.

describe("arrive", () => {
  it("is a no-op when the nav key has not changed", () => {
    // Re-rendering is not re-arriving: the draft must survive it, or a
    // half-configured evaluation would reset under the person filling it in.
    const first = initialEvaluationDraft(null, "k1");
    const picked = evaluationDraftReducer(first, {
      type: "select",
      items: [{ conversation_id: "c1" }],
    });
    const again = evaluationDraftReducer(picked, { type: "arrive", key: "k1", handoff: null });
    expect(again).toBe(picked);
  });

  it("starts empty with no handoff", () => {
    const draft = initialEvaluationDraft(null, "k1");
    expect(draft.selection).toEqual([]);
    expect(draft.step).toBe(0);
    expect(draft.testFlow).toBeNull();
  });
});

describe("seedSelection — Feedbacks' 're-run similar turns'", () => {
  const seed = [{ conversation_id: "c1", turn_ids: ["t2"] }];

  it("arrives with the complained-about turn already picked", () => {
    const draft = initialEvaluationDraft({ seedSelection: seed }, "k1");
    expect(draft.selection).toEqual(seed);
  });

  it("lands on step 1, not step 2", () => {
    // The point of the action is to WIDEN one complaint into a set worth
    // replaying, so it has to land where you can add to it.
    expect(initialEvaluationDraft({ seedSelection: seed }, "k1").step).toBe(0);
  });

  it("does not start the Test-as-evaluation flow", () => {
    // No last-selection PUT and no snapshot config belong to this route in.
    const draft = initialEvaluationDraft({ seedSelection: seed }, "k1");
    expect(draft.testFlow).toBeNull();
    expect(draft.prefilling).toBe(false);
    expect(draft.configs).toEqual(EMPTY_DRAFT.configs);
  });

  it("an empty seed is no seed at all", () => {
    expect(initialEvaluationDraft({ seedSelection: [] }, "k1").selection).toEqual([]);
  });
});

describe("testInRuns — the editor's Test-as-evaluation handoff", () => {
  const handoff = {
    testInRuns: { agent_id: "ag_refunds", snapshot_id: "snap_1", snapshot_label: "v1-draft" },
  };

  it("prefills the config with the snapshot and waits on the remembered selection", () => {
    const draft = initialEvaluationDraft(handoff, "k1");
    expect(draft.prefilling).toBe(true);
    expect(draft.configs).toEqual([{ agent_id: "ag_refunds", snapshot_id: "snap_1" }]);
  });

  it("a non-empty remembered selection skips ahead to Configure", () => {
    const arrived = initialEvaluationDraft(handoff, "k1");
    const filled = evaluationDraftReducer(arrived, {
      type: "prefilled",
      items: [{ conversation_id: "c1" }],
    });
    expect(filled.step).toBe(1);
    expect(filled.prefilling).toBe(false);
  });

  it('an empty one is "first-time testing" and stays on Select', () => {
    const arrived = initialEvaluationDraft(handoff, "k1");
    expect(evaluationDraftReducer(arrived, { type: "prefilled", items: [] }).step).toBe(0);
  });
});
