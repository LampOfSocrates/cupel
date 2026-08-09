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
import type { EvalCaseSource, EvalSet } from "../api/types";

// ⊞ collect — "Collect noteworthy turns into Casebooks with one
// keystroke" (cupel-phases.md:79). Since Casebook and EvalSet merged, the
// keystroke collects into an EVAL SET: one modal behind every ⊞ entry point
// (feature-spec.md:236 "Inspector | GET /admin/conversations,
// POST /casebooks/{id}/items", now POST /eval/sets/{setId}/items) — pick an
// existing set or type a new name, add an optional note, POST the REFERENCE.
//
// Three contract facts shape the UX:
// - The item is {source: {tree, conversation_id, turn_id}} + note — a
//   REFERENCE, never a copy. Nothing about the turn's text is sent.
// - Membership is VERSIONED, so collecting appends a version rather than
//   mutating the set. The modal says so, because "add" quietly meaning "new
//   version" is exactly the kind of thing a UI should not hide.
// - Adding a turn the set already holds "appends nothing and returns that
//   version unchanged", so the modal never pre-checks membership: an
//   unchanged version number IS the "already there" signal.
//
// Create-new is inline (POST /eval/sets then POST …/items) rather than a
// second screen — the whole point is one keystroke from noticing a turn.

interface Props {
  opened: boolean;
  /** The turn being collected; null while nothing is targeted. */
  target: EvalCaseSource | null;
  onClose: () => void;
  /** Fired after a successful add, so callers can refresh their own view. */
  onCollected?: (set: EvalSet) => void;
}

// Fresh form per open WITHOUT a reset effect: Mantine's Modal does not render
// its children while closed (ModalBaseContent is a Transition mounted on
// `opened`), so the body below mounts on open and its state starts at the
// initialisers every time. The shell stays out here so the close transition
// still has a Modal to run, and so the fetch stops when the modal does.
export function CollectModal({ opened, target, onClose, onCollected }: Props) {
  return (
    <Modal opened={opened} onClose={onClose} title="Collect turn into an eval set" size="md">
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
    data: sets,
    error: loadError,
    setData: setSets,
  } = useAsync(() => api.evalSets(), []);

  const add = async (evalSet: EvalSet) => {
    if (!target) return;
    setBusy(evalSet.id);
    setError(null);
    try {
      const updated = await api.addEvalSetItem(evalSet.id, {
        source: target,
        note: note.trim() || null,
      });
      const already = updated.version === evalSet.version;
      setDone(
        already
          ? `Already in ${evalSet.name} — nothing added.`
          : `Added to ${evalSet.name}, now v${updated.version}.`,
      );
      setSets((list) => list.map((s) => (s.id === updated.id ? updated : s)));
      onCollected?.(updated);
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
      const created = await api.createEvalSet({ name });
      setSets((list) => [created, ...list]);
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
        A set stores a <strong>reference</strong> to this turn — the transcript stays in its
        conversation. Membership is versioned, so collecting appends a new version rather
        than editing the current one.
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
      {!sets && !error && !loadError && <Loader size="sm" />}
      {sets?.length === 0 && (
        <Text size="xs" c="dimmed" data-testid="collect-empty">
          No eval sets yet — name one below and this turn becomes its first entry.
        </Text>
      )}
      <ScrollArea.Autosize mah={220}>
        <Stack gap={4}>
          {sets?.map((s) => (
            <Group key={s.id} gap={6} wrap="nowrap" justify="space-between">
              <Text size="sm" truncate title={s.description ?? undefined}>
                {s.name}{" "}
                <Text span size="xs" c="dimmed">
                  v{s.version} · {s.items.length} item{s.items.length === 1 ? "" : "s"}
                </Text>
              </Text>
              <Button
                size="compact-xs"
                variant="light"
                loading={busy === s.id}
                onClick={() => add(s)}
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
          placeholder="New eval set name"
          aria-label="New eval set name"
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
