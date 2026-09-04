import { describe, expect, it } from "vitest";
import {
  countSelection,
  fromItems,
  isPicked,
  removeConversation,
  removeTurn,
  selectionLabel,
  setConversation,
  setTurn,
  toItems,
  type Selection,
} from "./selection";

const TURNS = ["t1", "t2", "t3"];
const sel = (items: Parameters<typeof fromItems>[0]): Selection => fromItems(items);

describe("wire shape — whole conversation vs named turns", () => {
  it("round-trips a whole-conversation item as turn_ids absent", () => {
    expect(toItems(sel([{ conversation_id: "c1" }]))).toEqual([{ conversation_id: "c1" }]);
  });

  it("round-trips named turns", () => {
    expect(toItems(sel([{ conversation_id: "c1", turn_ids: ["t1", "t3"] }]))).toEqual([
      { conversation_id: "c1", turn_ids: ["t1", "t3"] },
    ]);
  });

  it("treats null turn_ids as the whole conversation (openapi.yaml SelectionItem)", () => {
    expect(sel([{ conversation_id: "c1", turn_ids: null }]).get("c1")).toBe("all");
  });

  it("does NOT promote every-turn-ticked to a whole-conversation item", () => {
    // The two shapes mean different things to a server: "this conversation,
    // whatever it holds when it runs" vs "these exact turns". Collapsing one
    // into the other would silently change what gets replayed.
    let s: Selection = new Map();
    for (const id of TURNS) s = setTurn(s, "c1", id, true, TURNS);
    expect(toItems(s)).toEqual([{ conversation_id: "c1", turn_ids: TURNS }]);
  });

  it("emits nothing for a conversation with no turns picked", () => {
    // `turn_ids: []` would ask the server to replay nothing.
    const s = setTurn(sel([{ conversation_id: "c1", turn_ids: ["t1"] }]), "c1", "t1", false, TURNS);
    expect(toItems(s)).toEqual([]);
  });
});

describe("narrowing — the rule both surfaces have to share", () => {
  it("unticking one turn of a whole conversation keeps every other turn", () => {
    const s = setTurn(sel([{ conversation_id: "c1" }]), "c1", "t2", false, TURNS);
    expect(toItems(s)).toEqual([{ conversation_id: "c1", turn_ids: ["t1", "t3"] }]);
  });

  it("removing one turn from the Selected panel narrows identically", () => {
    // Same rule, other surface — the reason it lives here and not in a component.
    const viaGrid = setTurn(sel([{ conversation_id: "c1" }]), "c1", "t2", false, TURNS);
    const viaPanel = removeTurn(sel([{ conversation_id: "c1" }]), "c1", "t2", TURNS);
    expect(toItems(viaPanel)).toEqual(toItems(viaGrid));
  });

  it("removing the last remaining turn drops the conversation entirely", () => {
    let s = sel([{ conversation_id: "c1" }]);
    for (const id of TURNS) s = removeTurn(s, "c1", id, TURNS);
    expect(toItems(s)).toEqual([]);
  });

  it("the group ✕ drops the conversation whole, not one turn at a time", () => {
    const s = removeConversation(sel([{ conversation_id: "c1" }, { conversation_id: "c2" }]), "c1");
    expect(toItems(s)).toEqual([{ conversation_id: "c2" }]);
  });

  it("leaves other conversations untouched", () => {
    const s = setTurn(
      sel([{ conversation_id: "c1" }, { conversation_id: "c2" }]),
      "c1",
      "t2",
      false,
      TURNS,
    );
    expect(s.get("c2")).toBe("all");
  });
});

describe("setConversation", () => {
  it("ticking replaces any narrowed selection with the whole conversation", () => {
    const s = setConversation(sel([{ conversation_id: "c1", turn_ids: ["t1"] }]), "c1", true);
    expect(s.get("c1")).toBe("all");
  });

  it("unticking removes it", () => {
    expect(toItems(setConversation(sel([{ conversation_id: "c1" }]), "c1", false))).toEqual([]);
  });
});

describe("isPicked", () => {
  it("reports every turn of a whole conversation as picked", () => {
    expect(isPicked(sel([{ conversation_id: "c1" }]), "c1", "t2")).toBe(true);
  });

  it("reports only the named turns otherwise", () => {
    const s = sel([{ conversation_id: "c1", turn_ids: ["t1"] }]);
    expect(isPicked(s, "c1", "t1")).toBe(true);
    expect(isPicked(s, "c1", "t2")).toBe(false);
  });

  it("reports nothing picked in an unselected conversation", () => {
    expect(isPicked(new Map(), "c1", "t1")).toBe(false);
  });
});

describe("counting", () => {
  const counts = (s: Selection) => countSelection(s, (id) => ({ c1: 4, c2: 2 })[id]);

  it("counts a whole conversation by its turn_count, with no transcript loaded", () => {
    expect(counts(sel([{ conversation_id: "c1" }]))).toEqual({ conversations: 1, turns: 4 });
  });

  it("counts named turns by how many are named", () => {
    expect(counts(sel([{ conversation_id: "c1", turn_ids: ["t1", "t2"] }]))).toEqual({
      conversations: 1,
      turns: 2,
    });
  });

  it("mixes both", () => {
    expect(counts(sel([{ conversation_id: "c1", turn_ids: ["t1"] }, { conversation_id: "c2" }])))
      .toEqual({ conversations: 2, turns: 3 });
  });

  it("counts a conversation of unknown length without guessing its turns", () => {
    expect(counts(sel([{ conversation_id: "c9" }]))).toEqual({ conversations: 1, turns: 0 });
  });
});

describe("selectionLabel", () => {
  it("says nothing when nothing is picked", () => {
    expect(selectionLabel({ conversations: 0, turns: 0 })).toBe("");
  });

  it("uses singulars", () => {
    expect(selectionLabel({ conversations: 1, turns: 1 })).toBe("1 conversation · 1 turn");
  });

  it("uses plurals", () => {
    expect(selectionLabel({ conversations: 3, turns: 7 })).toBe("3 conversations · 7 turns");
  });
});
