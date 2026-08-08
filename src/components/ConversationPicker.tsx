import { memo, useCallback, useDeferredValue, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { api } from "../api/client";
import type { Conversation, SelectionItem, Turn } from "../api/types";

// Runs step 1 — "ConversationPicker: search/filter/multi-select conversations,
// expandable to pick individual turns within a conversation (checkbox per
// turn)" (feature-spec.md:44; sketch 02). Emits SelectionItem[] per contract
// (openapi.yaml:1250-1259): "Absent/null = whole conversation; present = just
// these turns".
//
// Data flow: the picker fetches via the existing client (api.conversations)
// rather than taking a list prop, because search must be SERVER-side per the
// contract (?search=, openapi.yaml:352-354; annotated sketch 02 tags the
// search box "GET /agenttrees/agent1/conversations?search=") and both
// consumers (Runs Select step, Test-in-Runs prefilter) want identical
// fetch/search/paging behaviour. Turns ride along on the listing
// (openapi.yaml:1374-1377 "Included in listings").
//
// Selection semantics: only the conversation checkbox produces a
// whole-conversation item (turn_ids absent); individually ticking every turn
// still emits explicit turn_ids — the contract distinguishes the two shapes,
// so the picker never silently promotes one to the other.
//
// Not windowed, for the same reason as the sidebar list: page_size maxes at 100
// (openapi.yaml:681-683), growth is an explicit "Load more", and a row's height
// depends on whether its turns are expanded.

type ConvSelection = "all" | Set<string>;

interface Props {
  tree: string;
  onSelectionChange: (items: SelectionItem[]) => void;
  /**
   * Mount-time seed for the selection (P1-T20b: the per-agent remembered
   * selection, feature-spec.md:87 — and Back-from-Configure restores what was
   * picked). Read once on mount; later prop changes are ignored — the picker
   * owns its selection state after that.
   */
  initialSelection?: SelectionItem[];
}

// Inverse of toItems, for the mount-time seed: "Absent/null = whole
// conversation; present = just these turns" (openapi.yaml:1258).
function fromItems(items: SelectionItem[]): Map<string, ConvSelection> {
  const map = new Map<string, ConvSelection>();
  for (const item of items) {
    map.set(item.conversation_id, item.turn_ids == null ? "all" : new Set(item.turn_ids));
  }
  return map;
}

function toItems(selected: Map<string, ConvSelection>): SelectionItem[] {
  const items: SelectionItem[] = [];
  for (const [conversation_id, sel] of selected) {
    if (sel === "all") items.push({ conversation_id });
    else if (sel.size > 0) items.push({ conversation_id, turn_ids: [...sel] });
  }
  return items;
}

// "assistant turns selectable per the Runs semantics" — the grid re-generates
// assistant outputs ("row per turn" of regenerated output, feature-spec.md:49),
// so only assistant turns carry checkboxes; user turns render as dimmed context.
const assistantTurns = (conv: Conversation): Turn[] =>
  (conv.turns ?? []).filter((t) => t.role === "assistant");

export function ConversationPicker({ tree, onSelectionChange, initialSelection }: Props) {
  const [search, setSearch] = useState("");
  // The input keeps the urgent value; everything downstream of it re-renders at
  // low priority so a keystroke is never blocked by the list.
  const deferredSearch = useDeferredValue(search);
  const [debouncedSearch] = useDebouncedValue(deferredSearch, 250);
  const [items, setItems] = useState<Conversation[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Map<string, ConvSelection>>(() =>
    fromItems(initialSelection ?? []),
  );

  const load = useCallback(
    async (pageNum: number, append: boolean) => {
      setLoading(true);
      try {
        const data = await api.conversations(tree, {
          search: debouncedSearch || undefined,
          page: pageNum,
        });
        setItems((prev) => (append ? [...prev, ...data.items] : data.items));
        setTotal(data.total);
        setPage(data.page);
      } finally {
        setLoading(false);
      }
    },
    [tree, debouncedSearch],
  );

  useEffect(() => {
    void load(1, false);
  }, [load]);

  // Compute from current state, not inside the setSelected updater: calling
  // the parent's onSelectionChange from an updater is setState-during-render
  // (React warning surfaced by the P1-TE2E DoD walk). Checkbox events are
  // discrete, so reading `selected` directly is equivalent.
  // The three handlers below are useCallback'd so memo(PickerRow) holds across
  // the renders that do not touch the selection — typing, paging, expanding.
  const update = useCallback(
    (mutate: (next: Map<string, ConvSelection>) => void) => {
      const next = new Map(selected);
      mutate(next);
      setSelected(next);
      onSelectionChange(toItems(next));
    },
    [selected, onSelectionChange],
  );

  const toggleConversation = useCallback(
    (conv: Conversation, checked: boolean) => {
      update((next) => {
        if (checked) next.set(conv.id, "all");
        else next.delete(conv.id);
      });
    },
    [update],
  );

  const toggleTurn = useCallback(
    (conv: Conversation, turnId: string, checked: boolean) => {
      update((next) => {
        const current = next.get(conv.id);
        // Unticking a turn while the whole conversation is selected narrows to
        // an explicit turn list (all assistant turns minus this one).
        const set =
          current === "all"
            ? new Set(assistantTurns(conv).map((t) => t.id))
            : new Set(current ?? []);
        if (checked) set.add(turnId);
        else set.delete(turnId);
        if (set.size === 0) next.delete(conv.id);
        else next.set(conv.id, set);
      });
    },
    [update],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Footer summary (sketch 02: "2 conversations · 1 turn").
  let wholeCount = 0;
  let turnCount = 0;
  for (const sel of selected.values()) {
    if (sel === "all") wholeCount++;
    else turnCount += sel.size;
  }

  return (
    <Stack gap={4}>
      <TextInput
        size="xs"
        placeholder="Search conversations"
        value={search}
        onChange={(e) => setSearch(e.currentTarget.value)}
      />
      {items.map((conv) => (
        <PickerRow
          key={conv.id}
          conv={conv}
          selection={selected.get(conv.id)}
          expanded={expanded.has(conv.id)}
          onToggleConversation={toggleConversation}
          onToggleTurn={toggleTurn}
          onToggleExpanded={toggleExpanded}
        />
      ))}
      {loading && <Loader size="xs" mx="auto" my={4} />}
      {!loading && items.length === 0 && (
        <Text size="xs" c="dimmed" ta="center" my="sm">
          {debouncedSearch ? "No matches" : "No conversations"}
        </Text>
      )}
      {!loading && items.length < total && (
        <Button variant="subtle" size="compact-xs" onClick={() => void load(page + 1, true)}>
          Load more
        </Button>
      )}
      <Text size="xs" c="dimmed" data-testid="picker-summary">
        {wholeCount} conversation{wholeCount === 1 ? "" : "s"} · {turnCount} turn
        {turnCount === 1 ? "" : "s"}
      </Text>
    </Stack>
  );
}

const PickerRow = memo(function PickerRow({
  conv,
  selection,
  expanded,
  onToggleConversation,
  onToggleTurn,
  onToggleExpanded,
}: {
  conv: Conversation;
  selection: ConvSelection | undefined;
  expanded: boolean;
  onToggleConversation: (conv: Conversation, checked: boolean) => void;
  onToggleTurn: (conv: Conversation, turnId: string, checked: boolean) => void;
  onToggleExpanded: (id: string) => void;
}) {
  const partial = selection instanceof Set && selection.size > 0;
  const turns = conv.turns ?? [];

  return (
    <div data-testid={`picker-conv-${conv.id}`}>
      <Group gap={6} wrap="nowrap">
        <Checkbox
          size="xs"
          aria-label={`Select ${conv.title}`}
          checked={selection === "all"}
          indeterminate={partial}
          onChange={(e) => onToggleConversation(conv, e.currentTarget.checked)}
        />
        <UnstyledButton
          onClick={() => turns.length > 0 && onToggleExpanded(conv.id)}
          style={{ flex: 1, minWidth: 0 }}
          aria-label={`Toggle turns of ${conv.title}`}
        >
          <Group justify="space-between" wrap="nowrap" gap={4}>
            <Text size="xs" truncate>
              {conv.title}
            </Text>
            <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {turns.length > 0 ? `${turns.length}t ${expanded ? "▴" : "▸"}` : ""}
            </Text>
          </Group>
        </UnstyledButton>
      </Group>
      {expanded && (
        <Stack gap={2} ml="lg" my={2}>
          {turns.map((turn) =>
            turn.role === "assistant" ? (
              <Checkbox
                key={turn.id}
                size="xs"
                aria-label={`Select turn ${turn.id}`}
                label={
                  <Text size="xs" truncate>
                    {turn.content.slice(0, 60)}
                  </Text>
                }
                checked={selection === "all" || (selection instanceof Set && selection.has(turn.id))}
                onChange={(e) => onToggleTurn(conv, turn.id, e.currentTarget.checked)}
              />
            ) : (
              <Text key={turn.id} size="xs" c="dimmed" truncate pl={26}>
                {turn.content.slice(0, 60)}
              </Text>
            ),
          )}
        </Stack>
      )}
    </div>
  );
});
