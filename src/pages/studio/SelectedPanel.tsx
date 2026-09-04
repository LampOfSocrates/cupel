import { useState } from "react";
import { ActionIcon, Anchor, Box, Group, ScrollArea, Text } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { api } from "../../api/client";
import type { Conversation, SelectionItem, Turn } from "../../api/types";
import { useAsync } from "../../hooks/useAsync";
import {
  countSelection,
  fromItems,
  removeConversation,
  removeTurn,
  selectionLabel,
  toItems,
} from "./selection";

// The Selected panel — what you have picked, as a list you can take things
// out of.
//
// It is the second half of the handoff's step 1: the browse grid puts things
// in, this takes them out, and both go through src/pages/studio/selection.ts
// so the narrowing rule cannot differ between them. The grid collapses to a
// ribbon once anything is picked (the caller owns that), which is why this
// panel has to stand on its own — for most of step 1 it is the only view of
// the selection there is.
//
// A turn row opens the In/Out pane docked at the bottom: the prompt that went
// in and the answer that came out, which is how you tell whether a turn is
// worth replaying without leaving for the conversation.

interface Props {
  tree: string;
  selection: SelectionItem[];
  onSelectionChange: (items: SelectionItem[]) => void;
  /** Reopen the browse grid — offered only while it is collapsed. */
  onKeepPicking?: () => void;
  /** Conversations already listed, so a group header can name itself. */
  known: readonly Conversation[];
}

/** In / OUT for one turn, fetched when the row is opened and not before. */
function InOutPane({
  tree,
  conversationId,
  turnId,
  title,
  meta,
  onClose,
}: {
  tree: string;
  conversationId: string;
  turnId: string;
  title: string;
  meta: string;
  onClose: () => void;
}) {
  // The IN is the user turn immediately before the OUT — a transcript is a
  // sequence, so the pair is read off the page rather than requested as one.
  const turns = useAsync<Turn[]>(
    () => api.turns(tree, conversationId, { page_size: 200 }).then((p) => p.items),
    [tree, conversationId],
  );
  const items = turns.data ?? [];
  const index = items.findIndex((t) => t.id === turnId);
  const out = index >= 0 ? items[index] : null;
  const inTurn = index > 0 ? items[index - 1] : null;

  return (
    <Box
      style={{
        flex: "0 1 auto",
        maxHeight: "46%",
        minHeight: 140,
        display: "flex",
        flexDirection: "column",
        borderTop: "1px solid var(--mantine-color-gray-4)",
        background: "var(--mantine-color-gray-0)",
      }}
      data-testid="in-out-pane"
    >
      <Group px={12} py={6} justify="space-between" wrap="nowrap">
        <Box style={{ minWidth: 0 }}>
          <Text fz="sm" fw={600} truncate>
            {title}
          </Text>
          <Text fz="xs" c="gray.6" truncate>
            {meta}
          </Text>
        </Box>
        <ActionIcon size="xs" variant="subtle" c="gray.5" aria-label="Close turn detail" onClick={onClose}>
          <IconX size={12} />
        </ActionIcon>
      </Group>

      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box px={12} pb={10}>
          <Text fz="xs" c="gray.6" mb={4} style={{ letterSpacing: "0.05em" }}>
            IN
          </Text>
          <Box
            p={10}
            bg="white"
            style={{ border: "1px solid var(--mantine-color-gray-3)", borderRadius: 6 }}
          >
            <Text fz="sm" style={{ lineHeight: 1.55 }}>
              {turns.loading ? "Loading…" : (inTurn?.content ?? "No prompt before this turn.")}
            </Text>
          </Box>

          <Text fz="xs" c="gray.6" mt={10} mb={4} style={{ letterSpacing: "0.05em" }}>
            OUT
          </Text>
          <Box
            p={10}
            bg="white"
            style={{
              border: "1px solid var(--mantine-color-gray-3)",
              // The one asymmetry in the pair, and it is deliberate: OUT is
              // what a replay changes, so it carries the accent edge.
              borderLeft: "2px solid var(--mantine-color-accent-6)",
              borderRadius: 6,
            }}
          >
            <Text fz="sm" style={{ lineHeight: 1.55 }}>
              {turns.loading ? "Loading…" : (out?.content ?? "This turn is no longer in the transcript.")}
            </Text>
          </Box>
        </Box>
      </ScrollArea>
    </Box>
  );
}

export function SelectedPanel({
  tree,
  selection,
  onSelectionChange,
  onKeepPicking,
  known,
}: Props) {
  const [open, setOpen] = useState<{ conversationId: string; turnId: string } | null>(null);

  const model = fromItems(selection);
  const byId = new Map(known.map((c) => [c.id, c]));
  const counts = countSelection(model, (id) => byId.get(id)?.turn_count);

  const change = (next: ReturnType<typeof fromItems>) => onSelectionChange(toItems(next));

  return (
    <Box
      style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}
      data-testid="selected-panel"
    >
      <Group
        px={14}
        py={8}
        gap={8}
        justify="space-between"
        wrap="nowrap"
        bg="gray.2"
        style={{ borderBottom: "1px solid var(--mantine-color-gray-4)" }}
      >
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text fz="xs" fw={600} c="gray.6" style={{ letterSpacing: "0.05em" }}>
            SELECTED
          </Text>
          <Text fz="xs" c="gray.6" truncate>
            {selectionLabel(counts)}
          </Text>
        </Group>
        <Group gap={12} wrap="nowrap">
          {/* Offered only while the grid is collapsed — otherwise it is a
              link to what is already on screen. */}
          {onKeepPicking && (
            <Anchor component="button" type="button" fz="xs" onClick={onKeepPicking}>
              Keep picking
            </Anchor>
          )}
          {selection.length > 0 && (
            <Anchor
              component="button"
              type="button"
              fz="xs"
              c="gray.6"
              td="underline"
              onClick={() => {
                setOpen(null);
                onSelectionChange([]);
              }}
            >
              Clear all
            </Anchor>
          )}
        </Group>
      </Group>

      <ScrollArea style={{ flex: "1 1 auto", minHeight: 104 }}>
        {selection.length === 0 ? (
          <Text fz="sm" c="gray.6" p={14}>
            Tick a conversation to include all of its turns, or expand it and tick individual
            turns. Everything you pick shows up here.
          </Text>
        ) : (
          selection.map((item) => {
            const conv = byId.get(item.conversation_id);
            const whole = item.turn_ids == null;
            const turnIds = item.turn_ids ?? [];
            const turnCount = whole ? (conv?.turn_count ?? 0) : turnIds.length;
            return (
              <Box key={item.conversation_id}>
                <Box
                  px={12}
                  py={6}
                  bg="gray.0"
                  style={{ position: "sticky", top: 0, zIndex: 1 }}
                >
                  <Group gap={8} wrap="nowrap" justify="space-between">
                    <Box style={{ minWidth: 0 }}>
                      <Text fz="md" fw={500} truncate>
                        {conv?.title ?? item.conversation_id}
                      </Text>
                      <Text fz="xs" c="gray.6" truncate>
                        {[conv?.tree_id ?? tree, whole ? "whole conversation" : null,
                          `${turnCount} turn${turnCount === 1 ? "" : "s"}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    </Box>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      c="gray.5"
                      aria-label={`Remove ${conv?.title ?? item.conversation_id}`}
                      onClick={() => {
                        if (open?.conversationId === item.conversation_id) setOpen(null);
                        change(removeConversation(model, item.conversation_id));
                      }}
                    >
                      <IconX size={12} />
                    </ActionIcon>
                  </Group>
                </Box>

                {/* A whole-conversation pick lists no rows: its turns are
                    "whatever it holds when it runs", and enumerating them here
                    would show a transcript this panel has not fetched and a
                    server has not committed to. */}
                {turnIds.map((turnId) => {
                  const isOpen =
                    open?.conversationId === item.conversation_id && open.turnId === turnId;
                  return (
                    <Group
                      key={turnId}
                      px={12}
                      py={5}
                      pl={20}
                      gap={8}
                      wrap="nowrap"
                      style={{
                        borderBottom: "1px solid var(--mantine-color-gray-2)",
                        cursor: "pointer",
                        background: isOpen ? "var(--mantine-color-accent-0)" : undefined,
                      }}
                      onClick={() =>
                        setOpen(isOpen ? null : { conversationId: item.conversation_id, turnId })
                      }
                    >
                      <Text ff="monospace" fz="xs" c="gray.5" style={{ flex: "0 0 44px" }}>
                        {turnId.slice(-6)}
                      </Text>
                      <Text fz="sm" c="gray.7" truncate style={{ flex: 1, minWidth: 0 }}>
                        {conv?.title ?? ""}
                      </Text>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        c="gray.5"
                        aria-label={`Remove turn ${turnId}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (isOpen) setOpen(null);
                          change(removeTurn(model, item.conversation_id, turnId, turnIds));
                        }}
                      >
                        <IconX size={12} />
                      </ActionIcon>
                    </Group>
                  );
                })}
              </Box>
            );
          })
        )}
      </ScrollArea>

      {open && (
        <InOutPane
          tree={tree}
          conversationId={open.conversationId}
          turnId={open.turnId}
          title={byId.get(open.conversationId)?.title ?? open.conversationId}
          meta={`${byId.get(open.conversationId)?.tree_id ?? tree} · turn ${open.turnId}`}
          onClose={() => setOpen(null)}
        />
      )}
    </Box>
  );
}
