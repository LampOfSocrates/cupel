import { useState } from "react";
import {
  Alert,
  Button,
  Divider,
  Group,
  Loader,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import type { Casebook, CasebookItemCreate } from "../api/types";

// ⊞ collect — "Collect noteworthy turns into Casebooks with one
// keystroke" (cupel-phases.md:79). One modal behind every ⊞ entry point
// (feature-spec.md:240 "Inspector | GET /admin/conversations,
// POST /casebooks/{id}/items"): pick an existing casebook or type a new name,
// add an optional note, POST the REFERENCE.
//
// Two contract facts shape the UX:
// - An item is {tree, conversation_id, turn_id} + note — a REFERENCE, never a
//   copy (openapi.yaml:1739-1741). Nothing about the turn's text is sent.
// - "Re-adding the same turn is idempotent (returns the existing item)"
//   (openapi.yaml:1744), so collecting twice is safe and the modal never has
//   to pre-check membership. It reports "already in this casebook" by
//   comparing the returned item's id against what the casebook already held.
//
// Create-new is inline (POST /casebooks then POST …/items) rather than a
// second screen — the whole point is one keystroke from noticing a turn.

interface Props {
  opened: boolean;
  /** The turn being collected; null while nothing is targeted. */
  target: CasebookItemCreate | null;
  onClose: () => void;
  /** Fired after a successful add, so callers can refresh their own view. */
  onCollected?: (casebook: Casebook) => void;
}

// Fresh form per open WITHOUT a reset effect: Mantine's Modal does not render
// its children while closed (ModalBaseContent is a Transition mounted on
// `opened`), so the body below mounts on open and its state starts at the
// initialisers every time. The shell stays out here so the close transition
// still has a Modal to run, and so the fetch stops when the modal does.
export function CollectModal({ opened, target, onClose, onCollected }: Props) {
  return (
    <Modal opened={opened} onClose={onClose} title="Collect turn into a casebook" size="md">
      <CollectBody target={target} onCollected={onCollected} />
    </Modal>
  );
}

function CollectBody({ target, onCollected }: Pick<Props, "target" | "onCollected">) {
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const {
    data: casebooks,
    error: loadError,
    setData: setCasebooks,
  } = useAsync(() => api.casebooks(), []);

  const add = async (casebook: Casebook) => {
    if (!target) return;
    setBusy(casebook.id);
    setError(null);
    try {
      const item = await api.addCasebookItem(casebook.id, {
        ...target,
        note: note.trim() || null,
      });
      const already = casebook.items.some((i) => i.id === item.id);
      setDone(
        already
          ? `Already in ${casebook.name} — nothing added.`
          : `Added to ${casebook.name}.`,
      );
      const refreshed = await api.casebook(casebook.id).catch(() => casebook);
      setCasebooks((list) => list.map((c) => (c.id === refreshed.id ? refreshed : c)));
      onCollected?.(refreshed);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const createAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy("__new__");
    setError(null);
    try {
      const created = await api.createCasebook({ name });
      setCasebooks((list) => [created, ...list]);
      setNewName("");
      await add(created);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">
        Casebooks store a <strong>reference</strong> to this turn — the transcript stays in
        its conversation, and removing the item later changes nothing else.
      </Text>
      {target && (
        <Text size="xs" c="dimmed" data-testid="collect-target">
          {target.tree} · {target.conversation_id} · {target.turn_id}
        </Text>
      )}
      <Textarea
        size="xs"
        autosize
        minRows={1}
        label="Note (optional)"
        placeholder="Why is this turn noteworthy?"
        value={note}
        onChange={(e) => setNote(e.currentTarget.value)}
      />
      {(error ?? loadError) && (
        <Alert color="red" data-testid="collect-error">
          {error ?? loadError?.message}
        </Alert>
      )}
      {done && (
        <Alert color="green" data-testid="collect-done">
          {done}
        </Alert>
      )}
      <Divider label="Add to" labelPosition="left" />
      {!casebooks && !error && !loadError && <Loader size="sm" />}
      {casebooks?.length === 0 && (
        <Text size="xs" c="dimmed" data-testid="collect-empty">
          No casebooks yet — name one below and this turn becomes its first entry.
        </Text>
      )}
      <ScrollArea.Autosize mah={220}>
        <Stack gap={4}>
          {casebooks?.map((cb) => (
            <Group key={cb.id} gap={6} wrap="nowrap" justify="space-between">
              <Text size="sm" truncate title={cb.description ?? undefined}>
                {cb.name}{" "}
                <Text span size="xs" c="dimmed">
                  {cb.items.length} item{cb.items.length === 1 ? "" : "s"}
                </Text>
              </Text>
              <Button
                size="compact-xs"
                variant="light"
                loading={busy === cb.id}
                onClick={() => add(cb)}
              >
                ⊞ Add
              </Button>
            </Group>
          ))}
        </Stack>
      </ScrollArea.Autosize>
      <Divider label="Or create one" labelPosition="left" />
      <Group gap={6} wrap="nowrap">
        <TextInput
          size="xs"
          style={{ flex: 1 }}
          placeholder="New casebook name"
          aria-label="New casebook name"
          value={newName}
          onChange={(e) => setNewName(e.currentTarget.value)}
        />
        <Button
          size="compact-xs"
          loading={busy === "__new__"}
          disabled={!newName.trim()}
          onClick={createAndAdd}
        >
          Create + add
        </Button>
      </Group>
    </Stack>
  );
}
