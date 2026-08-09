import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useApp } from "../AppContext";
import { relativeTime } from "../lib/relativeTime";
import type {
  Casebook,
  CasebookItem,
  CasebookReplayAccepted,
  Conversation,
  EvalSet,
  Model,
  Turn,
} from "../api/types";

// Casebook view (UNSKETCHED — same dense language as the Inspector:
// Paper blocks, xs controls, a list pane beside a detail pane).
//
// cupel-phases.md:79: "Collect noteworthy turns into Casebooks with one
// keystroke, then turn a casebook into an eval set, a replay regression suite,
// or few-shot examples for an agent — using the ⊞ action and Casebook view".
// feature-spec.md:241: "Casebook view | GET /casebooks/{id},
// POST …/to-eval-set, POST …/replay".
//
// REFERENCE-NOT-COPY, and its cost: "Items are turn REFERENCES — render
// transcripts by following each item's tree/conversation_id/turn_id"
// (openapi.yaml:1689-1691). The contract has no batch turn fetch and no
// GET /turns/{id}, so rendering N items means up to N conversation GETs
// (review bucket C10 — "batch turn fetch", a v0.4.0 item). Two bounds keep
// that honest instead of unbounded:
//   1. requests are DEDUPED by (tree, conversation_id) — several turns from
//      one conversation cost one request;
//   2. at most CONVERSATION_FETCH_LIMIT conversations are fetched per
//      casebook. Items beyond that render as bare references with a visible
//      "not previewed" note. The screen says why rather than hiding it.
//
// Actions route into existing machinery: "Create eval set" lands in the Eval
// workbench's set list, "Replay" enqueues one run per tree under a single
// parent task (openapi.yaml:3320-3327) and links to the queue plus each run.
// Runs are tree-scoped and the app has one active tree, so a run in another
// tree is named but not linked — stated on the screen, never faked.

const CONVERSATION_FETCH_LIMIT = 25;

function refKey(item: { tree: string; conversation_id: string }) {
  return `${item.tree}/${item.conversation_id}`;
}

export function CasebooksPage() {
  const { tree: activeTree, models, ensureModels } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    ensureModels();
  }, [ensureModels]);

  const {
    data: casebooks,
    error: loadError,
    reload,
    setData: setCasebooks,
  } = useAsync(() => api.casebooks(), []);

  // Derived, not stored: a pick survives list changes only while it still
  // exists — deleting the open casebook falls back to the first row.
  const selectedId =
    pickedId && casebooks?.some((c) => c.id === pickedId)
      ? pickedId
      : (casebooks?.[0]?.id ?? null);
  const selected = casebooks?.find((c) => c.id === selectedId) ?? null;

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError(null);
    try {
      const created = await api.createCasebook({ name });
      setCasebooks((list) => [created, ...list]);
      setPickedId(created.id);
      setNewName("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const remove = async (casebook: Casebook) => {
    setError(null);
    try {
      await api.deleteCasebook(casebook.id);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Stack gap="sm" p="md">
      <div>
        <Title order={4}>Casebooks</Title>
        <Text size="xs" c="dimmed">
          Collections of noteworthy turns, held as references. Turn one into an eval set to
          judge it repeatedly, or replay it as a regression suite across configs.
        </Text>
      </div>

      {(error ?? loadError) && (
        <Alert color="red" data-testid="casebooks-error">
          {error ?? loadError?.message}
        </Alert>
      )}

      <Group align="flex-start" gap="sm" wrap="nowrap">
        <Paper withBorder p="xs" style={{ width: 260, flexShrink: 0 }}>
          <Group gap={6} wrap="nowrap" mb="xs">
            <TextInput
              size="xs"
              style={{ flex: 1 }}
              placeholder="New casebook"
              aria-label="New casebook name"
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
            />
            <Button size="compact-xs" loading={creating} disabled={!newName.trim()} onClick={create}>
              Create
            </Button>
          </Group>
          <Divider mb={4} />
          {!casebooks && <Loader size="xs" />}
          {casebooks?.length === 0 && (
            <Text size="xs" c="dimmed" data-testid="casebooks-empty">
              No casebooks yet. Press <strong>a</strong> on a turn in the Inspector — or use ⊞
              anywhere a turn is shown — to start one.
            </Text>
          )}
          <Stack gap={2}>
            {casebooks?.map((cb) => (
              <UnstyledButton
                key={cb.id}
                data-testid="casebook-row"
                data-selected={cb.id === selectedId ? "true" : undefined}
                onClick={() => setPickedId(cb.id)}
                style={{ width: "100%", padding: "4px 6px", borderRadius: 4 }}
                bg={cb.id === selectedId ? "var(--mantine-color-default-hover)" : undefined}
              >
                <Group gap={6} justify="space-between" wrap="nowrap">
                  <Text size="sm" truncate>
                    {cb.name}
                  </Text>
                  <Badge size="xs" variant="light">
                    {cb.items.length}
                  </Badge>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        </Paper>

        <div style={{ flex: 1, minWidth: 0 }}>
          {!selected && casebooks && casebooks.length > 0 && (
            <Text size="xs" c="dimmed">
              Pick a casebook.
            </Text>
          )}
          {selected && (
            <CasebookDetail
              key={selected.id}
              casebook={selected}
              activeTree={activeTree}
              models={models}
              onChanged={reload}
              onDelete={() => remove(selected)}
            />
          )}
        </div>
      </Group>
    </Stack>
  );
}

interface DetailProps {
  casebook: Casebook;
  activeTree: string;
  models: Model[] | null;
  onChanged: () => void;
  onDelete: () => void;
}

function CasebookDetail({ casebook, activeTree, models, onChanged, onDelete }: DetailProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setName, setSetName] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [createdSet, setCreatedSet] = useState<EvalSet | null>(null);
  const [replay, setReplay] = useState<CasebookReplayAccepted | null>(null);

  // Bounded reference following (see the file header). Deduped per
  // conversation, capped at CONVERSATION_FETCH_LIMIT.
  const wanted = useMemo(() => {
    const keys: string[] = [];
    for (const item of casebook.items) {
      const key = refKey(item);
      if (!keys.includes(key)) keys.push(key);
    }
    return keys.slice(0, CONVERSATION_FETCH_LIMIT);
  }, [casebook.items]);

  const [conversations, setConversations] = useState<Record<string, Conversation>>({});
  const [loadingRefs, setLoadingRefs] = useState(false);

  useEffect(() => {
    const missing = wanted.filter((key) => !conversations[key]);
    if (missing.length === 0) return;
    let cancelled = false;
    setLoadingRefs(true);
    Promise.all(
      missing.map((key) => {
        const [tree, id] = key.split("/");
        return api
          .conversation(tree, id)
          .then((conv) => [key, conv] as const)
          .catch(() => null);
      }),
    )
      .then((loaded) => {
        if (cancelled) return;
        setConversations((prev) => {
          const next = { ...prev };
          for (const entry of loaded) if (entry) next[entry[0]] = entry[1];
          return next;
        });
      })
      .finally(() => {
        if (!cancelled) setLoadingRefs(false);
      });
    return () => {
      cancelled = true;
    };
    // conversations intentionally omitted: the missing-set computation already
    // reads it, and including it would re-run the effect on every fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  const turnFor = (item: CasebookItem): Turn | null =>
    conversations[refKey(item)]?.turns?.find((t) => t.id === item.turn_id) ?? null;

  const removeItem = async (item: CasebookItem) => {
    setError(null);
    try {
      await api.removeCasebookItem(casebook.id, item.id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const makeEvalSet = async () => {
    const name = setName.trim() || `${casebook.name} cases`;
    setBusy(true);
    setError(null);
    setCreatedSet(null);
    try {
      setCreatedSet(await api.casebookToEvalSet(casebook.id, { set_name: name }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runReplay = async () => {
    setBusy(true);
    setError(null);
    setReplay(null);
    try {
      setReplay(
        await api.replayCasebook(casebook.id, { configs: [model ? { model } : {}] }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const modelOptions = [
    { value: "", label: "Live instructions (no override)" },
    ...(models ?? []).map((m) => ({ value: m.id, label: m.name })),
  ];

  return (
    <Stack gap="xs">
      <Paper withBorder p="xs">
        <Group justify="space-between" wrap="nowrap">
          <div style={{ minWidth: 0 }}>
            <Text fw={600}>{casebook.name}</Text>
            <Text size="xs" c="dimmed">
              {casebook.description ? `${casebook.description} · ` : ""}
              {casebook.items.length} turn{casebook.items.length === 1 ? "" : "s"} · created{" "}
              {relativeTime(casebook.created_at)} ago
            </Text>
          </div>
          <Button size="compact-xs" variant="subtle" color="red" onClick={onDelete}>
            Delete casebook
          </Button>
        </Group>
      </Paper>

      <Paper withBorder p="xs">
        <Group gap="xs" align="flex-end" wrap="wrap">
          <TextInput
            size="xs"
            label="Eval set name"
            style={{ width: 200 }}
            placeholder={`${casebook.name} cases`}
            value={setName}
            onChange={(e) => setSetName(e.currentTarget.value)}
          />
          <Button
            size="xs"
            loading={busy}
            disabled={casebook.items.length === 0}
            onClick={makeEvalSet}
          >
            Create eval set
          </Button>
          <Divider orientation="vertical" />
          <Select
            size="xs"
            label="Replay config"
            style={{ width: 220 }}
            data={modelOptions}
            value={model ?? ""}
            allowDeselect={false}
            onChange={(value) => setModel(value || null)}
          />
          <Button
            size="xs"
            variant="light"
            loading={busy}
            disabled={casebook.items.length === 0}
            onClick={runReplay}
          >
            Replay
          </Button>
        </Group>
        {casebook.items.length === 0 && (
          <Text size="xs" c="dimmed" mt={6}>
            Add turns first — both actions read this casebook's references.
          </Text>
        )}
        {createdSet && (
          <Alert color="green" mt="xs" data-testid="casebook-set-created">
            Created <strong>{createdSet.name}</strong> v{createdSet.version} with{" "}
            {createdSet.case_ids.length} case
            {createdSet.case_ids.length === 1 ? "" : "s"} —{" "}
            <Link to="/eval">open it in the Eval workbench</Link>.
          </Alert>
        )}
        {replay && (
          <Alert color="blue" mt="xs" data-testid="casebook-replay-accepted">
            <Stack gap={2}>
              <Text size="xs">
                Enqueued {replay.runs.length} run{replay.runs.length === 1 ? "" : "s"} under one
                task — <Link to="/queue">watch the queue</Link>.
              </Text>
              {replay.runs.map((r) => (
                <Text size="xs" key={r.run_id}>
                  {r.tree_id}:{" "}
                  {r.tree_id === activeTree ? (
                    <Link to={`/evaluations/${r.run_id}`}>{r.run_id}</Link>
                  ) : (
                    <>
                      {r.run_id} (opens when {r.tree_id} is the active tree — run pages are
                      tree-scoped)
                    </>
                  )}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
        {error && (
          <Alert color="red" mt="xs" data-testid="casebook-action-error">
            {error}
          </Alert>
        )}
      </Paper>

      <Paper withBorder p="xs">
        <Group justify="space-between" mb={4}>
          <Text size="xs" fw={600} tt="uppercase" c="dimmed">
            Items
          </Text>
          {loadingRefs && <Loader size={12} />}
        </Group>
        {casebook.items.length === 0 && (
          <Text size="xs" c="dimmed" data-testid="casebook-items-empty">
            Nothing collected yet. In the Inspector, select a conversation, focus a turn and
            press <strong>a</strong>.
          </Text>
        )}
        <ScrollArea.Autosize mah={420}>
          <Stack gap={6}>
            {casebook.items.map((item) => {
              const turn = turnFor(item);
              const previewable = wanted.includes(refKey(item));
              return (
                <Group
                  key={item.id}
                  gap={8}
                  wrap="nowrap"
                  align="flex-start"
                  data-testid="casebook-item"
                >
                  <Badge size="xs" variant="light" style={{ flexShrink: 0 }}>
                    {item.tree}
                  </Badge>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text size="sm" lineClamp={2}>
                      {turn?.content ??
                        (previewable
                          ? `${item.conversation_id} · ${item.turn_id}`
                          : `${item.conversation_id} · ${item.turn_id} — not previewed`)}
                    </Text>
                    {item.note && (
                      <Text size="xs" c="dimmed">
                        {item.note}
                      </Text>
                    )}
                  </div>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    onClick={() => removeItem(item)}
                    aria-label={`Remove ${item.turn_id}`}
                  >
                    Remove
                  </Button>
                </Group>
              );
            })}
          </Stack>
        </ScrollArea.Autosize>
        {casebook.items.length > 0 &&
          new Set(casebook.items.map(refKey)).size > CONVERSATION_FETCH_LIMIT && (
            <Text size="xs" c="dimmed" mt={6} data-testid="casebook-preview-cap">
              Previewing the first {CONVERSATION_FETCH_LIMIT} conversations only — items are
              references and this API has no batch turn fetch, so previewing every one would
              mean one request per conversation.
            </Text>
          )}
      </Paper>
    </Stack>
  );
}
