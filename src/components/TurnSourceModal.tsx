import { useState } from "react";
import {
  Badge,
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { Turn } from "../api/types";

// P2-T12 — "pull them from real turns or forks" (cupel-phases.md:80). Two jobs
// in one picker, chosen by `mode`:
//
// - mode "case": the whole turn becomes a case. The caller POSTs
//   /eval/cases {source:{tree, conversation_id, turn_id}} and "the server
//   derives input (the turn's prompt + envelope) and output (its response)"
//   (openapi.yaml:3322-3326) — so this modal returns the SOURCE, never a
//   client-side reconstruction of it.
// - mode "reference": "pick a turn → its response becomes the reference"
//   (feature-spec.md:57) — that is explicitly a client-side field fill
//   (openapi.yaml:3326-3327: "the reference-from-turn picker filling the field
//   client-side"), so here the modal returns the assistant TEXT.
//
// Turns ride along on GET /agenttrees/{tree}/conversations (openapi.yaml:1374
// "Included in listings"), so expanding a conversation costs no extra call —
// the same reasoning as ConversationPicker, which this deliberately does not
// reuse: that component emits multi-select SelectionItem[] for replay, while
// this one picks exactly one turn.

interface Props {
  opened: boolean;
  tree: string;
  mode: "case" | "reference";
  onClose: () => void;
  onPick: (picked: { conversationId: string; turn: Turn; text: string }) => void;
}

export function TurnSourceModal({ opened, tree, mode, onClose, onPick }: Props) {
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 250);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: conversations, error } = useAsync(
    opened
      ? () =>
          api
            .conversations(tree, { search: debounced || undefined, page_size: 20 })
            .then((page) => page.items)
      : null,
    [opened, tree, debounced],
  );

  const title = mode === "case" ? "Add a turn as an eval case" : "Reference from a turn";

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="lg">
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          {mode === "case"
            ? "The turn's prompt and frozen context become the case input; its response becomes the candidate output."
            : "The assistant response you pick is copied into the reference field — edit it afterwards if the expected answer differs."}
        </Text>
        <TextInput
          size="xs"
          placeholder="Search conversations"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          aria-label="Search conversations"
        />
        {error && (
          <Text size="xs" c="red">
            {error.message}
          </Text>
        )}
        {!conversations && !error && <Loader size="sm" />}
        {conversations?.length === 0 && (
          <Text size="xs" c="dimmed">
            No conversations in {tree} yet — chat first, then pull a turn from it.
          </Text>
        )}
        <ScrollArea.Autosize mah={360}>
          <Stack gap={2}>
            {conversations?.map((conv) => (
              <div key={conv.id}>
                <UnstyledButton
                  onClick={() => setExpanded((id) => (id === conv.id ? null : conv.id))}
                  style={{ width: "100%" }}
                >
                  <Group gap={6} wrap="nowrap" px={4} py={4}>
                    <Text size="xs" c="dimmed">
                      {expanded === conv.id ? "▾" : "▸"}
                    </Text>
                    <Text size="sm" truncate>
                      {conv.title}
                    </Text>
                    {conv.lineage && (
                      <Badge size="xs" variant="light">
                        fork
                      </Badge>
                    )}
                  </Group>
                </UnstyledButton>
                {expanded === conv.id && (
                  <Stack gap={2} pl="md">
                    {(conv.turns ?? []).filter((t) => t.role === "assistant").length === 0 && (
                      <Text size="xs" c="dimmed">
                        No answered turns in this conversation.
                      </Text>
                    )}
                    {(conv.turns ?? [])
                      .filter((turn) => turn.role === "assistant")
                      .map((turn) => (
                        <Group key={turn.id} gap={6} wrap="nowrap">
                          <Button
                            size="compact-xs"
                            variant="light"
                            onClick={() =>
                              onPick({
                                conversationId: conv.id,
                                turn,
                                text: turn.content,
                              })
                            }
                          >
                            Use
                          </Button>
                          <Text size="xs" truncate style={{ flex: 1 }} title={turn.content}>
                            {turn.content}
                          </Text>
                        </Group>
                      ))}
                  </Stack>
                )}
              </div>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      </Stack>
    </Modal>
  );
}
