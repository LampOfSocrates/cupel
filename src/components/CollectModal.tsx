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
import type { EvalCaseSource, EvalBenchmark } from "../api/types";

// ⊞ collect — collects noteworthy turns into Casebooks with one
// keystroke. Since Casebook and EvalBenchmark merged,
// the keystroke collects into an EVAL BENCHMARK: one modal behind every ⊞
// entry point (feature-spec.md:236 "Inspector | GET /admin/conversations,
// POST /casebooks/{id}/items", now POST /eval/benchmarks/{benchmarkId}/items)
// — pick an existing benchmark or type a new name, add an optional note,
// POST the REFERENCE.
//
// Three contract facts shape the UX:
// - The item is {source: {tree, conversation_id, turn_id}} + note — a
//   REFERENCE, never a copy. Nothing about the turn's text is sent.
// - Membership is VERSIONED, so collecting appends a version rather than
//   mutating the benchmark. The modal says so, because "add" quietly meaning
//   "new version" is exactly the kind of thing a UI should not hide.
// - Adding a turn the benchmark already holds "appends nothing and returns
//   that version unchanged", so the modal never pre-checks membership: an
//   unchanged version number IS the "already there" signal.
//
// Create-new is inline (POST /eval/benchmarks then POST …/items) rather than
// a second screen — the whole point is one keystroke from noticing a turn.

interface Props {
  opened: boolean;
  /** The turn being collected; null while nothing is targeted. */
  target: EvalCaseSource | null;
  onClose: () => void;
  /** Fired after a successful add, so callers can refresh their own view. */
  onCollected?: (benchmark: EvalBenchmark) => void;
}

// Fresh form per open WITHOUT a reset effect: Mantine's Modal does not render
// its children while closed (ModalBaseContent is a Transition mounted on
// `opened`), so the body below mounts on open and its state starts at the
// initialisers every time. The shell stays out here so the close transition
// still has a Modal to run, and so the fetch stops when the modal does.
export function CollectModal({ opened, target, onClose, onCollected }: Props) {
  return (
    <Modal opened={opened} onClose={onClose} title="Collect turn into an eval benchmark" size="md">
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

  // GET /eval/benchmarks is paged, so this picker holds a PAGE, not "the
  // benchmarks". Everything below reads page.items and the footer states the
  // rest — a picker that silently omits a benchmark is how a turn ends up
  // collected twice.
  const {
    data: page,
    error: loadError,
    setData: setPage,
  } = useAsync(() => api.evalBenchmarks(), []);
  const benchmarks = page?.items ?? null;

  const loadMore = async () => {
    if (!page) return;
    const next = await api.evalBenchmarks({ page: page.page + 1 });
    setPage((prev) => ({ ...next, items: [...prev.items, ...next.items] }));
  };

  const add = async (evalBenchmark: EvalBenchmark) => {
    if (!target) return;
    setBusy(evalBenchmark.id);
    setError(null);
    try {
      const updated = await api.addEvalBenchmarkItem(evalBenchmark.id, {
        source: target,
        note: note.trim() || null,
      });
      const already = updated.version === evalBenchmark.version;
      setDone(
        already
          ? `Already in ${evalBenchmark.name} — nothing added.`
          : `Added to ${evalBenchmark.name}, now v${updated.version}.`,
      );
      setPage((prev) => ({
        ...prev,
        items: prev.items.map((b) => (b.id === updated.id ? updated : b)),
      }));
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
      const created = await api.createEvalBenchmark({ name });
      setPage((prev) => ({ ...prev, items: [created, ...prev.items], total: prev.total + 1 }));
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
        A benchmark stores a <strong>reference</strong> to this turn — the transcript stays in
        its conversation. Membership is versioned, so collecting appends a new version rather
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
      {!benchmarks && !error && !loadError && <Loader size="sm" />}
      {benchmarks?.length === 0 && (
        <Text size="xs" c="dimmed" data-testid="collect-empty">
          No eval benchmarks yet — name one below and this turn becomes its first entry.
        </Text>
      )}
      <ScrollArea.Autosize mah={220}>
        <Stack gap={4}>
          {benchmarks?.map((b) => (
            <Group key={b.id} gap={6} wrap="nowrap" justify="space-between">
              <Text size="sm" truncate title={b.description ?? undefined}>
                {b.name}{" "}
                <Text span size="xs" c="dimmed">
                  v{b.version} · {b.items.length} item{b.items.length === 1 ? "" : "s"}
                </Text>
              </Text>
              <Button
                size="compact-xs"
                variant="light"
                loading={busy === b.id}
                onClick={() => add(b)}
              >
                ⊞ Add
              </Button>
            </Group>
          ))}
          {page != null && page.total > page.items.length && (
            <Button
              variant="subtle"
              size="compact-xs"
              data-testid="collect-load-more"
              onClick={() => void loadMore()}
            >
              Load more ({page.items.length} of {page.total})
            </Button>
          )}
        </Stack>
      </ScrollArea.Autosize>
      <Divider label="Or create one" labelPosition="left" />
      <Group gap={6} wrap="nowrap">
        <TextInput
          size="xs"
          style={{ flex: 1 }}
          placeholder="New eval benchmark name"
          aria-label="New eval benchmark name"
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
