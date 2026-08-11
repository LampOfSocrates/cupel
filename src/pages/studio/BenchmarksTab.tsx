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
  UnstyledButton,
} from "@mantine/core";
import { api } from "../../api/client";
import { useApp } from "../../AppContext";
import { useStudio, useStudioState } from "./StudioContext";
import { shorten } from "./shorten";
import type {
  EvalBenchmark,
  EvalBenchmarkItem,
  EvalBenchmarkItemCreate,
  EvalBenchmarkReplayAccepted,
  EvalCaseSource,
  Turn,
} from "../../api/types";

// THE MERGED SURFACE. Casebook and EvalBenchmark are one noun, so the
// Casebooks page is gone and its work happens here: a benchmark holds turn
// REFERENCES (⊞ collect) and FROZEN cases side by side, freezing replaces
// "turn this casebook into an eval benchmark", and replay/judge hang off the
// same selection. No new screen was invented for the merge — the two panes
// are the benchmark manager (feature-spec.md:63) with the casebook's actions
// folded in.
//
// VERSIONED MEMBERSHIP IS THE BEHAVIOUR CHANGE. Casebook editing used to
// mutate freely; every membership change now appends a version. It is surfaced
// three ways rather than hidden: the version badge next to the benchmark
// name, the line under it saying so, and the notice each mutation writes
// ("Membership saved as version N"). Add/remove are STAGED into one Save so a
// session of edits is one version rather than one per click; freeze and ⊞
// collect apply immediately, because each is a single deliberate act. The
// staged edits live in the Studio frame (useStudioState), so a trip to Cases
// to write the case you are about to add does not discard them.
//
// REFERENCE-NOT-COPY, and its cost (carried over from the deleted Casebooks
// page): rendering a reference means following its source. Requests are DEDUPED
// by (tree, conversation_id) and capped at CONVERSATION_FETCH_LIMIT
// conversations per benchmark — beyond that an item renders as a bare
// reference with a visible "not previewed" note. Each request now asks
// listTurns for exactly the referenced turn ids (?turn_ids=) instead of
// pulling whole conversations to read one turn out of each: the referenced
// turn may be anywhere in a transcript, so paging alone would have made this
// preview a lie. Cross-conversation batching is still absent from the
// contract.
const CONVERSATION_FETCH_LIMIT = 25;

function refKey(source: EvalCaseSource) {
  return `${source.tree}/${source.conversation_id}`;
}

export function BenchmarksTab() {
  const { tree: activeTree } = useApp();
  const {
    benchmarks,
    benchmarksTotal: total,
    loadBenchmarks,
    loadMoreBenchmarks,
    cases,
    knownCaseIds,
    rubricOptions,
    modelOptions,
    setError,
  } = useStudio();

  // Buffers that outlive a tab click — a staged membership edit above all,
  // since staging it into ONE version is the whole point of the Save button.
  const [name, setName] = useStudioState("benchmarks.name", "");
  const [selectedId, setSelectedId] = useStudioState<string | null>("benchmarks.selectedId", null);
  const [membership, setMembership] = useStudioState<EvalBenchmarkItemCreate[]>(
    "benchmarks.membership",
    [],
  );
  const [pickedRubricId, setRubricId] = useStudioState<string | null>("benchmarks.rubricId", null);
  const [judgeModel, setJudgeModel] = useStudioState<string | null>("benchmarks.judgeModel", null);
  const [replayModel, setReplayModel] = useStudioState<string | null>("benchmarks.replayModel", null);
  const [notice, setNotice] = useStudioState<string | null>("benchmarks.notice", null);
  const [replay, setReplay] = useStudioState<EvalBenchmarkReplayAccepted | null>(
    "benchmarks.replay",
    null,
  );

  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);

  const selected = benchmarks?.find((b) => b.id === selectedId) ?? null;

  // Default to the first rubric once they load, same as the case editor —
  // "Judge benchmark" is one click from a picked benchmark, not three.
  // Derived, not stored: an unpicked rubric simply reads as the first
  // option, so the default appears the moment the options do rather than one
  // effect-render later.
  const rubricId = pickedRubricId ?? rubricOptions[0]?.value ?? null;

  // Bounded reference following (see the header). Deduped per conversation,
  // capped at CONVERSATION_FETCH_LIMIT.
  const wanted = useMemo(() => {
    const byConversation = new Map<string, string[]>();
    for (const item of selected?.items ?? []) {
      if (item.kind !== "reference" || !item.source) continue;
      const key = refKey(item.source);
      const ids = byConversation.get(key);
      if (ids) ids.push(item.source.turn_id);
      else if (byConversation.size < CONVERSATION_FETCH_LIMIT) {
        byConversation.set(key, [item.source.turn_id]);
      }
    }
    return [...byConversation];
  }, [selected]);

  // key = refKey(source) → the referenced turns of that conversation, by id.
  // A per-mount cache, not a buffer: it is refetched from the ids on screen, so
  // it costs a request to rebuild and nothing to lose.
  const [referencedTurns, setReferencedTurns] = useState<Record<string, Record<string, Turn>>>({});
  const [loadingRefs, setLoadingRefs] = useState(false);

  useEffect(() => {
    const missing = wanted.filter(([key]) => !referencedTurns[key]);
    if (missing.length === 0) return;
    let cancelled = false;
    // KEPT: an incremental cache FILL, not a data/loading/error read — the
    // effect fetches only the ids the cache is missing and merges them in. The
    // flag cannot be derived as "something is still missing" either: a
    // conversation whose GET fails is caught to null and never lands, so a
    // derived flag would stay true forever.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingRefs(true);
    Promise.all(
      missing.map(([key, turnIds]) => {
        const [tree, id] = key.split("/");
        return api
          .turns(tree, id, { turn_ids: turnIds, page_size: 200 })
          .then((page) => [key, Object.fromEntries(page.items.map((t) => [t.id, t]))] as const)
          .catch(() => null);
      }),
    )
      .then((loaded) => {
        if (cancelled) return;
        setReferencedTurns((prev) => {
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
    // referencedTurns intentionally omitted: the missing-set computation
    // already reads it, and including it would re-run the effect on every fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);

  function itemLabel(item: EvalBenchmarkItem): string {
    if (item.kind === "frozen") {
      const c = item.case_id ? cases[item.case_id] : undefined;
      return c ? shorten(c.input.prompt) : (item.case_id ?? "case");
    }
    const source = item.source!;
    const turn = referencedTurns[refKey(source)]?.[source.turn_id];
    if (turn) return shorten(turn.content);
    const previewable = wanted.some(([key]) => key === refKey(source));
    return `${source.conversation_id} · ${source.turn_id}${previewable ? "" : " — not previewed"}`;
  }

  function select(b: EvalBenchmark) {
    setSelectedId(b.id);
    setMembership(b.items.map(toInput));
    setNotice(null);
    setReplay(null);
  }

  function applied(saved: EvalBenchmark, message: string) {
    setSelectedId(saved.id);
    setMembership(saved.items.map(toInput));
    setNotice(message);
  }

  async function create() {
    setCreating(true);
    try {
      await api.createEvalBenchmark({ name });
      setName("");
      await loadBenchmarks();
    } catch (e) {
      setError(e);
    } finally {
      setCreating(false);
    }
  }

  async function saveMembership() {
    if (!selected) return;
    setBusy(true);
    try {
      // "The full membership for the NEW version" — items absent from this
      // list leave the benchmark.
      const saved = await api.createEvalBenchmarkVersion(selected.id, { items: membership });
      await loadBenchmarks();
      applied(saved, `Membership saved as version ${saved.version}.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function freeze() {
    if (!selected) return;
    setBusy(true);
    try {
      // What "turn a casebook into an eval benchmark" became: the references
      // become cases in place, keeping their id and their provenance.
      const saved = await api.freezeEvalBenchmarkItems(selected.id);
      await loadBenchmarks();
      applied(saved, `Froze the live references into cases — now version ${saved.version}.`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.deleteEvalBenchmark(selected.id);
      setSelectedId(null);
      setMembership([]);
      await loadBenchmarks();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function runReplay() {
    if (!selected) return;
    setBusy(true);
    setReplay(null);
    try {
      setReplay(
        await api.replayEvalBenchmark(selected.id, {
          configs: [replayModel ? { model: replayModel } : {}],
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function judgeBenchmark() {
    if (!selected || !rubricId || !judgeModel) return;
    try {
      // "benchmark_id … judges the benchmark's latest membership version
      // unless benchmark_version pins one" — the workbench pins the version
      // it is showing, so the judgment is attributable to exactly that
      // membership.
      const ref = await api.judge({
        benchmark_id: selected.id,
        benchmark_version: selected.version,
        rubric_id: rubricId,
        judge_model: judgeModel,
      });
      setNotice(`Judging queued as task ${ref.task_id} — watch the Queue.`);
    } catch (e) {
      setError(e);
    }
  }

  const memberKeys = membership.map(inputKey);
  const dirty =
    selected !== null &&
    JSON.stringify(memberKeys) !== JSON.stringify(selected.items.map(toInput).map(inputKey));
  const references = selected?.items.filter((i) => i.kind === "reference") ?? [];
  const replayOptions = [{ value: "", label: "Live instructions (no override)" }, ...modelOptions];

  return (
    <Group align="flex-start" gap="sm" wrap="nowrap">
      <Paper withBorder p="xs" w={300} style={{ flexShrink: 0 }}>
        <Stack gap={6}>
          <TextInput
            size="xs"
            label="New benchmark"
            placeholder="refund-fails"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Button size="compact-xs" onClick={create} loading={creating} disabled={!name.trim()}>
            Create benchmark
          </Button>
          <Divider my={2} />
          {benchmarks === null && <Loader size="xs" />}
          {benchmarks?.length === 0 && (
            <Text size="xs" c="dimmed" data-testid="benchmarks-empty">
              No eval benchmarks yet. A benchmark is a named, versioned collection of noteworthy
              turns and frozen cases — judge it, replay it, reuse it across models.
            </Text>
          )}
          <Stack gap={2}>
            {(benchmarks ?? []).map((b) => (
              <UnstyledButton
                key={b.id}
                onClick={() => select(b)}
                data-testid={`benchmark-row-${b.id}`}
                style={{ width: "100%" }}
              >
                <Group gap={6} px={4} py={3} wrap="nowrap">
                  <Text size="xs" truncate style={{ flex: 1 }}>
                    {b.name}
                  </Text>
                  <Badge size="xs" variant="light">
                    v{b.version}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {b.items.length}
                  </Text>
                </Group>
              </UnstyledButton>
            ))}
            {benchmarks != null && total > benchmarks.length && (
              <Button
                variant="subtle"
                size="compact-xs"
                data-testid="benchmarks-load-more"
                onClick={() => void loadMoreBenchmarks()}
              >
                Load more ({benchmarks.length} of {total})
              </Button>
            )}
          </Stack>
        </Stack>
      </Paper>

      <Paper withBorder p="xs" style={{ flex: 1 }}>
        {!selected ? (
          <Text size="xs" c="dimmed">
            Pick a benchmark to manage its membership, or create one on the left.
          </Text>
        ) : (
          <Stack gap={6}>
            <Group justify="space-between" wrap="nowrap">
              <Group gap={6}>
                <Text fw={600} size="sm">
                  {selected.name}
                </Text>
                <Badge size="xs" variant="light">
                  v{selected.version}
                </Badge>
                {loadingRefs && <Loader size={12} />}
              </Group>
              <Button size="compact-xs" variant="subtle" color="red" onClick={remove}>
                Delete benchmark
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              {selected.description ? `${selected.description} · ` : ""}
              Membership is versioned — every add, removal or freeze appends a new version rather
              than editing this one, so judgments stay attributable to the membership they ran
              against.
            </Text>

            {/* Members: turn references and frozen cases in one list. */}
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              Members
            </Text>
            {selected.items.length === 0 && (
              <Text size="xs" c="dimmed" data-testid="benchmark-items-empty">
                Nothing collected yet. Press <strong>a</strong> on a turn in the Inspector — or use
                ⊞ anywhere a turn is shown — to reference one here, or add a case below.
              </Text>
            )}
            <ScrollArea.Autosize mah={260}>
              <Stack gap={4}>
                {selected.items.map((item) => {
                  const key = itemKey(item);
                  const inSet = memberKeys.includes(key);
                  return (
                    <Group key={item.id} gap={6} wrap="nowrap" data-testid="benchmark-item">
                      <Button
                        size="compact-xs"
                        variant={inSet ? "light" : "subtle"}
                        color={inSet ? "red" : "blue"}
                        data-testid={`toggle-${item.id}`}
                        onClick={() =>
                          setMembership((m) =>
                            inSet ? m.filter((x) => inputKey(x) !== key) : [...m, toInput(item)],
                          )
                        }
                      >
                        {inSet ? "Remove" : "Add back"}
                      </Button>
                      <Badge
                        size="xs"
                        variant="light"
                        color={item.kind === "frozen" ? "grape" : "blue"}
                        style={{ flexShrink: 0 }}
                      >
                        {item.kind === "frozen" ? "frozen case" : (item.source?.tree ?? "reference")}
                      </Badge>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text size="xs" truncate>
                          {itemLabel(item)}
                        </Text>
                        {item.note && (
                          <Text size="xs" c="dimmed" truncate>
                            {item.note}
                          </Text>
                        )}
                      </div>
                    </Group>
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>
            {references.length > 0 &&
              new Set(references.map((i) => refKey(i.source!))).size > CONVERSATION_FETCH_LIMIT && (
                <Text size="xs" c="dimmed" data-testid="benchmark-preview-cap">
                  Previewing the first {CONVERSATION_FETCH_LIMIT} conversations only — items are
                  references and this API has no batch turn fetch, so previewing every one would
                  mean one request per conversation.
                </Text>
              )}

            {/* Cases this session knows about, addable to the staged membership. */}
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              Add a case
            </Text>
            {knownCaseIds.length === 0 && (
              <Text size="xs" c="dimmed">
                No cases are loaded yet — create or import some on the Cases tab first.
              </Text>
            )}
            <ScrollArea.Autosize mah={160}>
              <Stack gap={2}>
                {knownCaseIds.map((id) => {
                  const inSet = memberKeys.includes(`case:${id}`);
                  return (
                    <Group key={id} gap={6} wrap="nowrap">
                      <Button
                        size="compact-xs"
                        variant={inSet ? "light" : "subtle"}
                        color={inSet ? "red" : "blue"}
                        data-testid={`toggle-${id}`}
                        onClick={() =>
                          setMembership((m) =>
                            inSet
                              ? m.filter((x) => inputKey(x) !== `case:${id}`)
                              : [...m, { case_id: id }],
                          )
                        }
                      >
                        {inSet ? "Remove" : "Add"}
                      </Button>
                      <Text size="xs" truncate style={{ flex: 1 }}>
                        {cases[id] ? shorten(cases[id].input.prompt) : id}
                      </Text>
                    </Group>
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>

            <Group gap={6}>
              <Button size="xs" onClick={saveMembership} loading={busy} disabled={!dirty}>
                Save membership as new version
              </Button>
              <Button
                size="xs"
                variant="light"
                onClick={freeze}
                loading={busy}
                disabled={references.length === 0}
              >
                Freeze {references.length} reference{references.length === 1 ? "" : "s"}
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              Freezing copies each referenced turn into an eval case so the benchmark can be judged
              and re-judged against fixed content; the item keeps its place and its provenance.
            </Text>

            <Divider my={4} />
            <Group gap={6} align="flex-end">
              <Select
                size="xs"
                label="Rubric"
                data={rubricOptions}
                value={rubricId}
                onChange={setRubricId}
                w={200}
              />
              <Select
                size="xs"
                label="Judge model"
                data={modelOptions}
                value={judgeModel}
                onChange={setJudgeModel}
                w={200}
              />
              <Button
                size="xs"
                onClick={judgeBenchmark}
                disabled={!rubricId || !judgeModel || selected.items.length === 0}
              >
                Judge benchmark
              </Button>
            </Group>

            <Group gap={6} align="flex-end">
              <Select
                size="xs"
                label="Replay config"
                data={replayOptions}
                value={replayModel ?? ""}
                allowDeselect={false}
                onChange={(value) => setReplayModel(value || null)}
                w={220}
              />
              <Button
                size="xs"
                variant="light"
                loading={busy}
                disabled={references.length === 0}
                onClick={runReplay}
              >
                Replay
              </Button>
              <Text size="xs" c="dimmed">
                Replay re-fires the referenced turns; frozen cases have no turn to re-fire.
              </Text>
            </Group>
            {replay && (
              <Alert color="blue" data-testid="benchmark-replay-accepted">
                <Stack gap={2}>
                  <Text size="xs">
                    Enqueued {replay.evaluations.length} evaluation
                    {replay.evaluations.length === 1 ? "" : "s"} under one task —{" "}
                    <Link to="/queue">watch the queue</Link>.
                  </Text>
                  {replay.evaluations.map((r) => (
                    <Text size="xs" key={r.evaluation_id}>
                      {r.tree_id}:{" "}
                      {r.tree_id === activeTree ? (
                        <Link to={`/studio/evaluations/${r.evaluation_id}`}>{r.evaluation_id}</Link>
                      ) : (
                        <>
                          {r.evaluation_id} (opens when {r.tree_id} is the active tree — evaluation
                          pages are tree-scoped)
                        </>
                      )}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}
            {notice && (
              <Text size="xs" c="dimmed" data-testid="benchmark-notice">
                {notice}
              </Text>
            )}
          </Stack>
        )}
      </Paper>
    </Group>
  );
}

// An item and a membership input are the same thing seen from two sides; both
// reduce to the REFERENT the server keys item identity on.
function toInput(item: EvalBenchmarkItem): EvalBenchmarkItemCreate {
  return item.kind === "frozen"
    ? { case_id: item.case_id!, note: item.note }
    : { source: item.source!, note: item.note };
}

function itemKey(item: EvalBenchmarkItem): string {
  return item.kind === "frozen"
    ? `case:${item.case_id}`
    : `turn:${item.source!.tree}/${item.source!.conversation_id}/${item.source!.turn_id}`;
}

function inputKey(input: EvalBenchmarkItemCreate): string {
  return "case_id" in input
    ? `case:${input.case_id}`
    : `turn:${input.source.tree}/${input.source.conversation_id}/${input.source.turn_id}`;
}
