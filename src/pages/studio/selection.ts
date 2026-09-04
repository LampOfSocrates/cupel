import type { SelectionItem } from "../../api/types";

// The evaluation selection model, as one set of rules.
//
// It lives apart from any component because TWO surfaces mutate the same
// selection — the browse grid's checkboxes (src/components/ConversationPicker)
// and the Selected panel's ✕ buttons — and the interesting rule is one they
// must not implement differently:
//
//   Removing ONE turn from a whole-conversation selection expands that
//   selection into its individual turns MINUS that one. It does not drop the
//   conversation.
//
// The handoff says it twice, once per surface, which is a good sign it is the
// rule people get wrong. Here it is written once.
//
// SHAPE. The contract's SelectionItem is `{conversation_id, turn_ids?}` where
// "Absent/null = whole conversation; present = just these turns"
// (openapi.yaml SelectionItem). That distinction is load-bearing and is
// preserved end to end: ticking every turn individually still emits explicit
// turn_ids, and is NOT silently promoted to a whole-conversation item. The two
// mean different things to a server — "this conversation, whatever it holds
// when it runs" versus "these exact turns".

/** One conversation's selection: every turn, or these turn ids. */
export type ConvSelection = "all" | ReadonlySet<string>;

/** Selection as the UI holds it — conversation id → what is picked of it. */
export type Selection = ReadonlyMap<string, ConvSelection>;

export function fromItems(items: readonly SelectionItem[]): Selection {
  const map = new Map<string, ConvSelection>();
  for (const item of items) {
    map.set(item.conversation_id, item.turn_ids == null ? "all" : new Set(item.turn_ids));
  }
  return map;
}

export function toItems(selection: Selection): SelectionItem[] {
  const items: SelectionItem[] = [];
  for (const [conversation_id, sel] of selection) {
    if (sel === "all") items.push({ conversation_id });
    // An empty set is not a selection — it is the absence of one, and emitting
    // `turn_ids: []` would ask a server to replay nothing.
    else if (sel.size > 0) items.push({ conversation_id, turn_ids: [...sel] });
  }
  return items;
}

/** Tick or untick a whole conversation. */
export function setConversation(
  selection: Selection,
  conversationId: string,
  picked: boolean,
): Selection {
  const next = new Map(selection);
  if (picked) next.set(conversationId, "all");
  else next.delete(conversationId);
  return next;
}

/**
 * Tick or untick ONE turn.
 *
 * `allTurnIds` is every selectable turn of that conversation, and it is
 * required rather than optional: unticking a turn while the whole conversation
 * is picked has to name the turns that REMAIN, and they cannot be derived from
 * the selection — "all" does not enumerate. A caller that has not loaded the
 * transcript yet cannot narrow a whole selection, which is why the grid
 * fetches turns on expand before it offers the checkboxes.
 */
export function setTurn(
  selection: Selection,
  conversationId: string,
  turnId: string,
  picked: boolean,
  allTurnIds: readonly string[],
): Selection {
  const next = new Map(selection);
  const current = next.get(conversationId);
  // THE rule: "all" minus one turn is every other turn, spelled out.
  const set = current === "all" ? new Set(allTurnIds) : new Set(current ?? []);
  if (picked) set.add(turnId);
  else set.delete(turnId);
  if (set.size === 0) next.delete(conversationId);
  else next.set(conversationId, set);
  return next;
}

/** Drop a conversation and everything picked inside it — the group ✕. */
export function removeConversation(selection: Selection, conversationId: string): Selection {
  const next = new Map(selection);
  next.delete(conversationId);
  return next;
}

/** The row ✕ in the Selected panel. Same rule as unticking the turn. */
export function removeTurn(
  selection: Selection,
  conversationId: string,
  turnId: string,
  allTurnIds: readonly string[],
): Selection {
  return setTurn(selection, conversationId, turnId, false, allTurnIds);
}

export function isPicked(selection: Selection, conversationId: string, turnId: string): boolean {
  const sel = selection.get(conversationId);
  return sel === "all" || (sel instanceof Set && sel.has(turnId));
}

/**
 * The Selected panel's live count: "3 conversations · 7 turns".
 *
 * A whole-conversation pick contributes its `turn_count`, which the listing
 * already carries — so the count is right before any transcript is fetched.
 * A conversation whose count is unknown contributes its conversations tally
 * and no turns, rather than a guess.
 */
export function countSelection(
  selection: Selection,
  turnCountOf: (conversationId: string) => number | undefined,
): { conversations: number; turns: number } {
  let conversations = 0;
  let turns = 0;
  for (const [conversationId, sel] of selection) {
    conversations += 1;
    turns += sel === "all" ? (turnCountOf(conversationId) ?? 0) : sel.size;
  }
  return { conversations, turns };
}

/** "3 conversations · 7 turns", with singulars. Empty selection = "". */
export function selectionLabel(counts: { conversations: number; turns: number }): string {
  if (counts.conversations === 0) return "";
  const convs = `${counts.conversations} conversation${counts.conversations === 1 ? "" : "s"}`;
  const turns = `${counts.turns} turn${counts.turns === 1 ? "" : "s"}`;
  return `${convs} · ${turns}`;
}
