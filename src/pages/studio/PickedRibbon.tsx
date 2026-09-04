import { useState } from "react";
import { Anchor, Box, Group, ScrollArea, Text, UnstyledButton } from "@mantine/core";
import { api } from "../../api/client";
import type { Conversation, SelectionItem, Turn } from "../../api/types";
import { useAsync } from "../../hooks/useAsync";
import { countSelection, fromItems, selectionLabel } from "./selection";

// "What you picked", on step 2 — the same progressive collapse the browse grid
// gets on step 1: "the stage you finished shrinks to a ribbon you can always
// reopen".
//
// Collapsed it is one line: the count, and a way back. Expanded it is a
// horizontally scrolling strip of the actual turns, because the question step
// 2 raises — is this instruction change the right one for THESE turns — is one
// you cannot answer against a number.
//
// The strip scrolls on ITS OWN row, never on an ancestor: the handoff's
// overflow discipline ("horizontal scroll belongs on the row that actually
// overflows"), and the reason the run setup pane beside it stays put while you
// read across the cards.

const CARD_WIDTH = 236;

function TurnCard({ turnNo, title, text }: { turnNo: string; title: string; text: string }) {
  return (
    <Box
      py={7}
      px={9}
      style={{
        flex: `0 0 ${CARD_WIDTH}px`,
        border: "1px solid var(--mantine-color-gray-3)",
        borderRadius: 7,
        background: "var(--mantine-color-gray-0)",
      }}
    >
      <Text ff="monospace" fz="xs" c="gray.5">
        {turnNo}
      </Text>
      <Text fz="xs" fw={500} truncate>
        {title}
      </Text>
      <Text fz="xs" c="gray.7" lineClamp={2} mt={2}>
        {text}
      </Text>
    </Box>
  );
}

export function PickedRibbon({
  tree,
  selection,
  onChange,
}: {
  tree: string;
  selection: SelectionItem[];
  /** Back to step 1 — the "change" link. */
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);

  const listing = useAsync<Conversation[]>(
    () => api.conversations(tree, { page_size: 100 }).then((p) => p.items),
    [tree],
  );
  const byId = new Map((listing.data ?? []).map((c) => [c.id, c]));
  const counts = countSelection(fromItems(selection), (id) => byId.get(id)?.turn_count);

  // Transcripts only once the strip is actually open — a collapsed ribbon is a
  // count, and fetching every picked conversation to render a line of text
  // nobody asked for is the cost this collapse exists to avoid.
  const transcripts = useAsync<Record<string, Turn[]>>(
    open
      ? async () => {
          const named = selection.filter((s) => s.turn_ids?.length);
          const pages = await Promise.all(
            named.map((s) =>
              api
                .turns(tree, s.conversation_id, { turn_ids: s.turn_ids ?? undefined })
                .then((p) => [s.conversation_id, p.items] as const),
            ),
          );
          return Object.fromEntries(pages);
        }
      : null,
    [open, tree, selection],
  );

  return (
    <Box
      bg="white"
      style={{ borderBottom: "1px solid var(--mantine-color-gray-3)" }}
      data-testid="picked-ribbon"
    >
      <Group px={12} py={6} gap={8} wrap="nowrap" justify="space-between">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <UnstyledButton
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label="Toggle picked turns"
          >
            <Group gap={8} wrap="nowrap">
              <Text fz="xs" c="gray.6" w={10}>
                {open ? "▼" : "▶"}
              </Text>
              <Text fz="sm" c="gray.7">
                What you picked — <b>{selectionLabel(counts)}</b>
              </Text>
            </Group>
          </UnstyledButton>
          <Anchor component="button" type="button" fz="xs" onClick={onChange}>
            change
          </Anchor>
        </Group>
        <Text fz="xs" c="gray.6" truncate>
          Each turn is replayed once per endpoint and saved as its own conversation.
        </Text>
      </Group>

      {open && (
        <ScrollArea type="auto" offsetScrollbars>
          <Group gap={8} px={12} pb={8} wrap="nowrap" align="stretch">
            {selection.flatMap((item) => {
              const conv = byId.get(item.conversation_id);
              const title = conv?.title ?? item.conversation_id;
              // A whole-conversation pick has no turn list to show — its turns
              // are "whatever it holds when it runs" — so it is ONE card
              // saying that, rather than a transcript this has not fetched.
              if (item.turn_ids == null) {
                return [
                  <TurnCard
                    key={item.conversation_id}
                    turnNo="whole"
                    title={title}
                    text={`All ${conv?.turn_count ?? 0} turns, as they stand when the run starts.`}
                  />,
                ];
              }
              const turns = transcripts.data?.[item.conversation_id] ?? [];
              return item.turn_ids.map((turnId) => (
                <TurnCard
                  key={`${item.conversation_id}:${turnId}`}
                  turnNo={turnId.slice(-6)}
                  title={title}
                  text={
                    turns.find((t) => t.id === turnId)?.content ??
                    (transcripts.loading ? "Loading…" : "")
                  }
                />
              ));
            })}
          </Group>
        </ScrollArea>
      )}
    </Box>
  );
}
