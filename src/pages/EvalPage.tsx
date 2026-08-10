import { useCallback, useEffect, useMemo, useState } from "react";
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
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { api } from "../api/client";
import { useApp } from "../AppContext";
import { ApiErrorNote, errorMessage } from "../components/ApiErrorNote";
import { EvalImportModal } from "../components/EvalImportModal";
import { TurnSourceModal } from "../components/TurnSourceModal";
import { product } from "../lib/product";
import type {
  EvalCase,
  EvalCaseSource,
  EvalSet,
  EvalSetItem,
  EvalSetItemCreate,
  EvalSetReplayAccepted,
  Judgment,
  Rubric,
  Turn,
} from "../api/types";

// Eval workbench (sketch 10) — "Hand-craft expected answers and have
// the judge score AI against them — type/paste references, pull them from real
// turns or forks, or bulk-import a spreadsheet of input/expected pairs"
// (cupel-phases.md:80). The workbench "manage[s] the eval domain directly:
// case editor (input / output / reference fields; 'reference from turn'
// picker), set manager (create/name/version sets, drag cases in), rubric
// editor (prompt text, save = new version…)" (feature-spec.md:63).
//
// Two honesty notes, both forced by the contract as it stands (v0.3.0) and
// deliberately NOT worked around here:
//
// 1. There is no list-all-cases endpoint — /eval/cases has POST only
//    (openapi.yaml:1340-1369) and cases are read one id at a time
//    (:1431-1454). So the case list is SET-scoped, exactly as the annotated
//    sketch tags it ("Set: refund-fails v3 / GET /eval/sets"), plus a
//    "just created here" bucket for cases this session made that are not in a
//    set yet. The screen says so rather than pretending to show everything.
// 2. GET /eval/cases/{id} "Returns the LATEST version" (openapi.yaml:1441-1442)
//    and no endpoint returns earlier ones. The editor therefore shows the
//    CURRENT version number and states that prior versions are not retrievable
//    through this API — no fabricated history list. What IS real history is
//    the judgment trail (GET /eval/judgments?subject_kind=case, append-only,
//    feature-spec.md:59), so that is what the case panel renders.
//    (Contract gap logged as review bucket C5 — not fixed here.)
//
// Eval cases are GLOBAL, not tree-scoped ("Global: tasks, span payloads, eval
// rubrics/judgments, settings", feature-spec.md:111) — this page adds no tree
// gating. The one tree-scoped thing it touches is the turn picker, which reads
// conversations from the active tree.

const SESSION_BUCKET = "__session__";

function shorten(text: string, max = 64) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function EvalPage() {
  const { tree, models, ensureModels } = useApp();
  const [tab, setTab] = useState<string | null>("cases");
  const [sets, setSets] = useState<EvalSet[] | null>(null);
  const [rubrics, setRubrics] = useState<Rubric[] | null>(null);
  // GET /eval/sets and GET /eval/rubrics are paged, so both lists here are
  // prefixes. Holding the server's total is what lets each tab offer the rest
  // instead of ending silently at the page boundary; both are 0 until the
  // first fetch lands.
  const [setsPage, setSetsPage] = useState({ page: 1, total: 0 });
  const [rubricsPage, setRubricsPage] = useState({ page: 1, total: 0 });
  // The thrown VALUE, not its message: an ApiError carries the rejected
  // fields and the correlation id, and flattening it to a string here threw
  // both away before the Alert could show them.
  const [error, setError] = useState<unknown>(null);

  // Cases known to this screen, keyed by id (loaded per set, plus whatever was
  // created/imported here — see honesty note 1).
  const [cases, setCases] = useState<Record<string, EvalCase>>({});
  const [sessionCaseIds, setSessionCaseIds] = useState<string[]>([]);
  const [bucket, setBucket] = useState<string>(SESSION_BUCKET);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [loadingCases, setLoadingCases] = useState(false);

  // Case editor buffer — also the "new case" form when draftId is null.
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ prompt: "", output: "", reference: "" });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [judgments, setJudgments] = useState<Judgment[] | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [turnPicker, setTurnPicker] = useState<null | "case" | "reference">(null);

  const [judgeModel, setJudgeModel] = useState<string | null>(null);
  const [rubricId, setRubricId] = useState<string | null>(null);
  const [judging, setJudging] = useState(false);

  useEffect(() => {
    ensureModels();
  }, [ensureModels]);

  const loadSets = useCallback(async () => {
    const page = await api.evalSets();
    setSets(page.items);
    setSetsPage({ page: page.page, total: page.total });
    return page.items;
  }, []);

  const loadMoreSets = useCallback(async () => {
    const page = await api.evalSets({ page: setsPage.page + 1 });
    setSets((prev) => [...(prev ?? []), ...page.items]);
    setSetsPage({ page: page.page, total: page.total });
  }, [setsPage.page]);

  const loadMoreRubrics = useCallback(async () => {
    const page = await api.rubrics({ page: rubricsPage.page + 1 });
    setRubrics((prev) => [...(prev ?? []), ...page.items]);
    setRubricsPage({ page: page.page, total: page.total });
  }, [rubricsPage.page]);

  const handleImported = useCallback(() => {
    loadSets().catch(() => undefined);
  }, [loadSets]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.evalSets(), api.rubrics()])
      .then(([setPage, rubricPage]) => {
        if (cancelled) return;
        setSets(setPage.items);
        setSetsPage({ page: setPage.page, total: setPage.total });
        setRubrics(rubricPage.items);
        setRubricsPage({ page: rubricPage.page, total: rubricPage.total });
        setRubricId((id) => id ?? rubricPage.items[0]?.id ?? null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Membership of the chosen bucket → one GET /eval/cases/{id} per member.
  const bucketCaseIds = useMemo(() => {
    if (bucket === SESSION_BUCKET) return sessionCaseIds;
    // A bucket is a set's FROZEN members: a reference item has no case to
    // read yet, so it appears here only once frozen.
    return (sets?.find((s) => s.id === bucket)?.items ?? [])
      .filter((i) => i.kind === "frozen" && i.case_id)
      .map((i) => i.case_id as string);
  }, [bucket, sessionCaseIds, sets]);

  useEffect(() => {
    const missing = bucketCaseIds.filter((id) => !cases[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    // KEPT: an incremental cache FILL, same shape as the Sets tab's — one GET
    // per case id the cache is missing, merged in. A failed case is caught to
    // null and never lands, so "is anything still missing" is not an equivalent
    // derivation of the flag; it would never clear.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingCases(true);
    Promise.all(missing.map((id) => api.evalCase(id).catch(() => null)))
      .then((loaded) => {
        if (cancelled) return;
        setCases((prev) => {
          const next = { ...prev };
          for (const c of loaded) if (c) next[c.id] = c;
          return next;
        });
      })
      .finally(() => {
        if (!cancelled) setLoadingCases(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bucketCaseIds, cases]);

  const selectedCase = selectedCaseId ? cases[selectedCaseId] : undefined;

  const openCase = useCallback((c: EvalCase) => {
    setSelectedCaseId(c.id);
    setDraftId(c.id);
    setDraft({
      prompt: c.input.prompt,
      output: c.output,
      reference: c.reference ?? "",
    });
    setNotice(null);
    setJudgments(null);
    api
      .judgments({ subject_kind: "case", subject_id: c.id })
      .then((page) => setJudgments(page.items))
      .catch(() => setJudgments([]));
  }, []);

  function newCase() {
    setSelectedCaseId(null);
    setDraftId(null);
    setDraft({ prompt: "", output: "", reference: "" });
    setNotice(null);
    setJudgments(null);
  }

  function rememberCase(c: EvalCase) {
    setCases((prev) => ({ ...prev, [c.id]: c }));
    setSessionCaseIds((prev) => (prev.includes(c.id) ? prev : [...prev, c.id]));
  }

  async function saveCase() {
    setSaving(true);
    setError(null);
    try {
      const reference = draft.reference.trim() ? draft.reference : null;
      if (draftId) {
        // "each save appends the next version, never overwrites"
        // (openapi.yaml:1459-1462).
        const saved = await api.createEvalCaseVersion(draftId, {
          input: { prompt: draft.prompt },
          output: draft.output,
          reference,
        });
        rememberCase(saved);
        setSelectedCaseId(saved.id);
        setNotice(`Saved as version ${saved.version ?? 1}.`);
      } else {
        const created = await api.createEvalCase({
          input: { prompt: draft.prompt },
          output: draft.output,
          reference,
        });
        rememberCase(created);
        setSelectedCaseId(created.id);
        setDraftId(created.id);
        setNotice("Case created (version 1).");
      }
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }

  async function judgeCase() {
    if (!draftId || !rubricId || !judgeModel) return;
    setJudging(true);
    setError(null);
    try {
      await api.judge({ case_ids: [draftId], rubric_id: rubricId, judge_model: judgeModel });
      setNotice("Judging queued — the score lands in the judgment history.");
    } catch (e) {
      setError(e);
    } finally {
      setJudging(false);
    }
  }

  const modelOptions = (models ?? []).map((m) => ({ value: m.id, label: m.name }));
  const rubricOptions = (rubrics ?? []).map((r) => ({
    value: r.id,
    label: `${r.name} v${r.version}`,
  }));
  const bucketOptions = [
    { value: SESSION_BUCKET, label: `Created here (${sessionCaseIds.length})` },
    ...(sets ?? []).map((s) => ({
      value: s.id,
      label: `${s.name} v${s.version} · ${s.items.length}`,
    })),
  ];

  return (
    <Stack gap="sm" p="md">
      <Group justify="space-between">
        <Title order={4}>Eval workbench</Title>
        <Text size="xs" c="dimmed">
          Cases, sets and rubrics are global — they are not scoped to a single {product.tree.one}.
        </Text>
      </Group>
      {error != null && (
        <Alert color="red" title="Something went wrong" withCloseButton onClose={() => setError(null)}>
          {errorMessage(error)}
          <ApiErrorNote error={error} />
        </Alert>
      )}

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="cases">Cases</Tabs.Tab>
          <Tabs.Tab value="sets">Sets</Tabs.Tab>
          <Tabs.Tab value="rubrics">Rubrics</Tabs.Tab>
        </Tabs.List>

        {/* ------------------------------------------------------- cases */}
        <Tabs.Panel value="cases" pt="sm">
          <Group align="flex-start" gap="sm" wrap="nowrap">
            <Paper withBorder p="xs" w={300} style={{ flexShrink: 0 }}>
              <Stack gap={6}>
                <Select
                  size="xs"
                  label="Show cases from"
                  data={bucketOptions}
                  value={bucket}
                  onChange={(v) => setBucket(v ?? SESSION_BUCKET)}
                />
                <Group gap={4}>
                  <Button size="compact-xs" onClick={newCase}>
                    + New case
                  </Button>
                  <Button size="compact-xs" variant="light" onClick={() => setTurnPicker("case")}>
                    From turn
                  </Button>
                  <Button size="compact-xs" variant="light" onClick={() => setImportOpen(true)}>
                    ⇪ Import
                  </Button>
                </Group>
                <Divider my={2} />
                {loadingCases && <Loader size="xs" />}
                {bucketCaseIds.length === 0 && !loadingCases && (
                  <Text size="xs" c="dimmed" data-testid="cases-empty">
                    {bucket === SESSION_BUCKET
                      ? "Nothing created here yet. Write a case by hand, pull one from a real conversation turn, or import a spreadsheet of input/expected pairs."
                      : "This set has no cases yet — add some from the Sets tab."}
                  </Text>
                )}
                <ScrollArea.Autosize mah={420}>
                  <Stack gap={2}>
                    {bucketCaseIds.map((id) => {
                      const c = cases[id];
                      return (
                        <UnstyledButton
                          key={id}
                          onClick={() => c && openCase(c)}
                          data-testid={`case-row-${id}`}
                          style={{ width: "100%" }}
                        >
                          <Group
                            gap={6}
                            wrap="nowrap"
                            px={4}
                            py={3}
                            bg={selectedCaseId === id ? "var(--mantine-color-default-hover)" : undefined}
                          >
                            <Text size="xs" c={c?.reference ? "teal" : "dimmed"}>
                              {c?.reference ? "✓" : "—"}
                            </Text>
                            <Text size="xs" truncate style={{ flex: 1 }}>
                              {c ? shorten(c.input.prompt) : id}
                            </Text>
                            {c?.version != null && (
                              <Badge size="xs" variant="light">
                                v{c.version}
                              </Badge>
                            )}
                          </Group>
                        </UnstyledButton>
                      );
                    })}
                  </Stack>
                </ScrollArea.Autosize>
              </Stack>
            </Paper>

            <Paper withBorder p="xs" style={{ flex: 1 }}>
              <Stack gap={6}>
                <Group justify="space-between">
                  <Group gap={6}>
                    <Text fw={600} size="sm">
                      {draftId ? "Edit case" : "New case"}
                    </Text>
                    {selectedCase?.version != null && (
                      <Badge size="xs" variant="light">
                        v{selectedCase.version}
                      </Badge>
                    )}
                    {selectedCase?.source?.turn_id && (
                      <Badge size="xs" variant="light" color="grape">
                        from turn
                      </Badge>
                    )}
                  </Group>
                  {draftId && (
                    <Text size="xs" c="dimmed" data-testid="version-note">
                      Saving appends a new version. This API returns the latest version
                      only — earlier versions are not retrievable here.
                    </Text>
                  )}
                </Group>
                <Textarea
                  size="xs"
                  label="Input (prompt)"
                  autosize
                  minRows={2}
                  value={draft.prompt}
                  onChange={(e) => {
                    // Capture before the updater runs: React nulls
                    // currentTarget once the handler returns.
                    const value = e.currentTarget.value;
                    setDraft((d) => ({ ...d, prompt: value }));
                  }}
                />
                <Textarea
                  size="xs"
                  label="Output (candidate response)"
                  autosize
                  minRows={3}
                  value={draft.output}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setDraft((d) => ({ ...d, output: value }));
                  }}
                />
                <Group justify="space-between" align="flex-end">
                  <Text size="xs" c="dimmed">
                    Reference (expected answer) — optional; reference-free rubrics are allowed.
                  </Text>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => setTurnPicker("reference")}
                  >
                    Reference from turn
                  </Button>
                </Group>
                <Textarea
                  size="xs"
                  aria-label="Reference (expected answer)"
                  autosize
                  minRows={2}
                  value={draft.reference}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setDraft((d) => ({ ...d, reference: value }));
                  }}
                />
                <Group>
                  <Button
                    size="xs"
                    onClick={saveCase}
                    loading={saving}
                    disabled={!draft.prompt.trim() || !draft.output.trim()}
                  >
                    {draftId ? "Save as new version" : "Create case"}
                  </Button>
                  {notice && (
                    <Text size="xs" c="dimmed" data-testid="case-notice">
                      {notice}
                    </Text>
                  )}
                </Group>

                {draftId && (
                  <>
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
                        variant="light"
                        loading={judging}
                        disabled={!rubricId || !judgeModel}
                        onClick={judgeCase}
                      >
                        Judge case
                      </Button>
                    </Group>
                    <Text size="xs" fw={600} mt={4}>
                      Judgment history (append-only)
                    </Text>
                    {judgments === null && <Loader size="xs" />}
                    {judgments?.length === 0 && (
                      <Text size="xs" c="dimmed">
                        No judgments yet for this case.
                      </Text>
                    )}
                    <Stack gap={2}>
                      {(judgments ?? []).map((j) => (
                        <Group key={j.id} gap={6}>
                          <Badge size="xs" variant="light">
                            {j.score}
                          </Badge>
                          <Text size="xs" c="dimmed">
                            {j.scorer.model ?? j.scorer.kind} · rubric {j.scorer.ref ?? "—"} v
                            {j.scorer.version ?? "—"}
                          </Text>
                        </Group>
                      ))}
                    </Stack>
                  </>
                )}
              </Stack>
            </Paper>
          </Group>
        </Tabs.Panel>

        {/* -------------------------------------------------------- sets */}
        <Tabs.Panel value="sets" pt="sm">
          <SetsTab
            sets={sets}
            total={setsPage.total}
            onLoadMore={loadMoreSets}
            cases={cases}
            activeTree={tree}
            knownCaseIds={Array.from(
              new Set([
                ...sessionCaseIds,
                ...(sets ?? []).flatMap((s) =>
                  s.items.filter((i) => i.case_id).map((i) => i.case_id as string),
                ),
              ]),
            )}
            rubricOptions={rubricOptions}
            modelOptions={modelOptions}
            onChanged={loadSets}
            onError={setError}
          />
        </Tabs.Panel>

        {/* ----------------------------------------------------- rubrics */}
        <Tabs.Panel value="rubrics" pt="sm">
          <RubricsTab
            rubrics={rubrics}
            onChanged={() =>
              api.rubrics().then((page) => {
                setRubrics(page.items);
                setRubricsPage({ page: page.page, total: page.total });
              })
            }
            total={rubricsPage.total}
            onLoadMore={loadMoreRubrics}
            onError={setError}
          />
        </Tabs.Panel>
      </Tabs>

      <EvalImportModal
        opened={importOpen}
        sets={sets ?? []}
        onClose={() => setImportOpen(false)}
        onImported={handleImported}
      />
      <TurnSourceModal
        opened={turnPicker !== null}
        tree={tree}
        mode={turnPicker ?? "reference"}
        onClose={() => setTurnPicker(null)}
        onPick={async ({ conversationId, turn, text }) => {
          if (turnPicker === "reference") {
            setDraft((d) => ({ ...d, reference: text }));
            setTurnPicker(null);
            return;
          }
          setTurnPicker(null);
          try {
            // Sourced creation: the server derives input + output from the turn
            // (openapi.yaml:3322-3326).
            const created = await api.createEvalCase({
              source: { tree, conversation_id: conversationId, turn_id: turn.id },
            });
            rememberCase(created);
            setBucket(SESSION_BUCKET);
            openCase(created);
            setNotice("Case created from a conversation turn (version 1).");
          } catch (e) {
            setError(e);
          }
        }}
      />
    </Stack>
  );
}

// ------------------------------------------------------------------- sets
// THE MERGED SURFACE. Casebook and EvalSet are one noun, so the Casebooks page
// is gone and its work happens here: a set holds turn REFERENCES (⊞ collect)
// and FROZEN cases side by side, freezing replaces "turn this casebook into an
// eval set", and replay/judge hang off the same selection. No new screen was
// invented for the merge — the two panes are the set manager
// (feature-spec.md:63) with the casebook's actions folded in.
//
// VERSIONED MEMBERSHIP IS THE BEHAVIOUR CHANGE. Casebook editing used to
// mutate freely; every membership change now appends a version. It is surfaced
// three ways rather than hidden: the version badge next to the set name, the
// line under it saying so, and the notice each mutation writes ("Membership
// saved as version N"). Add/remove are STAGED into one Save so a session of
// edits is one version rather than one per click; freeze and ⊞ collect apply
// immediately, because each is a single deliberate act.
//
// REFERENCE-NOT-COPY, and its cost (carried over from the deleted Casebooks
// page): rendering a reference means following its source. Requests are DEDUPED
// by (tree, conversation_id) and capped at CONVERSATION_FETCH_LIMIT
// conversations per set — beyond that an item renders as a bare reference with
// a visible "not previewed" note. Each request now asks listTurns for exactly
// the referenced turn ids (?turn_ids=) instead of pulling whole conversations
// to read one turn out of each: the referenced turn may be anywhere in a
// transcript, so paging alone would have made this preview a lie. Cross-
// conversation batching is still absent (review bucket C10).
const CONVERSATION_FETCH_LIMIT = 25;

function refKey(source: EvalCaseSource) {
  return `${source.tree}/${source.conversation_id}`;
}

interface SetsTabProps {
  sets: EvalSet[] | null;
  /** Sets matching across all pages (EvalSetPage.total) — the list is a prefix. */
  total: number;
  onLoadMore: () => Promise<void>;
  cases: Record<string, EvalCase>;
  knownCaseIds: string[];
  activeTree: string;
  rubricOptions: { value: string; label: string }[];
  modelOptions: { value: string; label: string }[];
  onChanged: () => Promise<EvalSet[]>;
  onError: (message: string) => void;
}

function SetsTab({
  sets,
  total,
  onLoadMore,
  cases,
  knownCaseIds,
  activeTree,
  rubricOptions,
  modelOptions,
  onChanged,
  onError,
}: SetsTabProps) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [membership, setMembership] = useState<EvalSetItemCreate[]>([]);
  const [busy, setBusy] = useState(false);
  const [pickedRubricId, setRubricId] = useState<string | null>(null);
  const [judgeModel, setJudgeModel] = useState<string | null>(null);
  const [replayModel, setReplayModel] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replay, setReplay] = useState<EvalSetReplayAccepted | null>(null);

  const selected = sets?.find((s) => s.id === selectedId) ?? null;

  // Default to the first rubric once they load, same as the case editor —
  // "Judge set" is one click from a picked set, not three. Derived, not stored:
  // an unpicked rubric simply reads as the first option, so the default appears
  // the moment the options do rather than one effect-render later.
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

  function itemLabel(item: EvalSetItem): string {
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

  function select(s: EvalSet) {
    setSelectedId(s.id);
    setMembership(s.items.map(toInput));
    setNotice(null);
    setReplay(null);
  }

  function applied(saved: EvalSet, message: string) {
    setSelectedId(saved.id);
    setMembership(saved.items.map(toInput));
    setNotice(message);
  }

  async function create() {
    setCreating(true);
    try {
      await api.createEvalSet({ name });
      setName("");
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function saveMembership() {
    if (!selected) return;
    setBusy(true);
    try {
      // "The full membership for the NEW version" — items absent from this
      // list leave the set.
      const saved = await api.createEvalSetVersion(selected.id, { items: membership });
      await onChanged();
      applied(saved, `Membership saved as version ${saved.version}.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function freeze() {
    if (!selected) return;
    setBusy(true);
    try {
      // What "turn a casebook into an eval set" became: the references become
      // cases in place, keeping their id and their provenance.
      const saved = await api.freezeEvalSetItems(selected.id);
      await onChanged();
      applied(saved, `Froze the live references into cases — now version ${saved.version}.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected) return;
    setBusy(true);
    try {
      await api.deleteEvalSet(selected.id);
      setSelectedId(null);
      setMembership([]);
      await onChanged();
    } catch (e) {
      onError((e as Error).message);
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
        await api.replayEvalSet(selected.id, {
          configs: [replayModel ? { model: replayModel } : {}],
        }),
      );
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function judgeSet() {
    if (!selected || !rubricId || !judgeModel) return;
    try {
      // "set_id … judges the set's latest membership version unless
      // set_version pins one" — the workbench pins the version it is showing,
      // so the judgment is attributable to exactly that membership.
      const ref = await api.judge({
        set_id: selected.id,
        set_version: selected.version,
        rubric_id: rubricId,
        judge_model: judgeModel,
      });
      setNotice(`Judging queued as task ${ref.task_id} — watch the Queue.`);
    } catch (e) {
      onError((e as Error).message);
    }
  }

  const memberKeys = membership.map(inputKey);
  const dirty =
    selected !== null &&
    JSON.stringify(memberKeys) !== JSON.stringify(selected.items.map(toInput).map(inputKey));
  const references = selected?.items.filter((i) => i.kind === "reference") ?? [];
  const replayOptions = [
    { value: "", label: "Live instructions (no override)" },
    ...modelOptions,
  ];

  return (
    <Group align="flex-start" gap="sm" wrap="nowrap">
      <Paper withBorder p="xs" w={300} style={{ flexShrink: 0 }}>
        <Stack gap={6}>
          <TextInput
            size="xs"
            label="New set"
            placeholder="refund-fails"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
          <Button size="compact-xs" onClick={create} loading={creating} disabled={!name.trim()}>
            Create set
          </Button>
          <Divider my={2} />
          {sets === null && <Loader size="xs" />}
          {sets?.length === 0 && (
            <Text size="xs" c="dimmed" data-testid="sets-empty">
              No eval sets yet. A set is a named, versioned collection of noteworthy turns
              and frozen cases — judge it, replay it, reuse it across models.
            </Text>
          )}
          <Stack gap={2}>
            {(sets ?? []).map((s) => (
              <UnstyledButton
                key={s.id}
                onClick={() => select(s)}
                data-testid={`set-row-${s.id}`}
                style={{ width: "100%" }}
              >
                <Group gap={6} px={4} py={3} wrap="nowrap">
                  <Text size="xs" truncate style={{ flex: 1 }}>
                    {s.name}
                  </Text>
                  <Badge size="xs" variant="light">
                    v{s.version}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {s.items.length}
                  </Text>
                </Group>
              </UnstyledButton>
            ))}
            {sets != null && total > sets.length && (
              <Button
                variant="subtle"
                size="compact-xs"
                data-testid="sets-load-more"
                onClick={() => void onLoadMore()}
              >
                Load more ({sets.length} of {total})
              </Button>
            )}
          </Stack>
        </Stack>
      </Paper>

      <Paper withBorder p="xs" style={{ flex: 1 }}>
        {!selected ? (
          <Text size="xs" c="dimmed">
            Pick a set to manage its membership, or create one on the left.
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
                Delete set
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              {selected.description ? `${selected.description} · ` : ""}
              Membership is versioned — every add, removal or freeze appends a new version
              rather than editing this one, so judgments stay attributable to the membership
              they ran against.
            </Text>

            {/* Members: turn references and frozen cases in one list. */}
            <Text size="xs" fw={600} tt="uppercase" c="dimmed">
              Members
            </Text>
            {selected.items.length === 0 && (
              <Text size="xs" c="dimmed" data-testid="set-items-empty">
                Nothing collected yet. Press <strong>a</strong> on a turn in the Inspector —
                or use ⊞ anywhere a turn is shown — to reference one here, or add a case
                below.
              </Text>
            )}
            <ScrollArea.Autosize mah={260}>
              <Stack gap={4}>
                {selected.items.map((item) => {
                  const key = itemKey(item);
                  const inSet = memberKeys.includes(key);
                  return (
                    <Group key={item.id} gap={6} wrap="nowrap" data-testid="set-item">
                      <Button
                        size="compact-xs"
                        variant={inSet ? "light" : "subtle"}
                        color={inSet ? "red" : "blue"}
                        data-testid={`toggle-${item.id}`}
                        onClick={() =>
                          setMembership((m) =>
                            inSet
                              ? m.filter((x) => inputKey(x) !== key)
                              : [...m, toInput(item)],
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
                <Text size="xs" c="dimmed" data-testid="set-preview-cap">
                  Previewing the first {CONVERSATION_FETCH_LIMIT} conversations only — items
                  are references and this API has no batch turn fetch, so previewing every
                  one would mean one request per conversation.
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
              Freezing copies each referenced turn into an eval case so the set can be judged
              and re-judged against fixed content; the item keeps its place and its
              provenance.
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
                onClick={judgeSet}
                disabled={!rubricId || !judgeModel || selected.items.length === 0}
              >
                Judge set
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
              <Alert color="blue" data-testid="set-replay-accepted">
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
                        <Link to={`/evaluations/${r.evaluation_id}`}>{r.evaluation_id}</Link>
                      ) : (
                        <>
                          {r.evaluation_id} (opens when {r.tree_id} is the active tree —
                          evaluation pages are tree-scoped)
                        </>
                      )}
                    </Text>
                  ))}
                </Stack>
              </Alert>
            )}
            {notice && (
              <Text size="xs" c="dimmed" data-testid="set-notice">
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
function toInput(item: EvalSetItem): EvalSetItemCreate {
  return item.kind === "frozen"
    ? { case_id: item.case_id!, note: item.note }
    : { source: item.source!, note: item.note };
}

function itemKey(item: EvalSetItem): string {
  return item.kind === "frozen"
    ? `case:${item.case_id}`
    : `turn:${item.source!.tree}/${item.source!.conversation_id}/${item.source!.turn_id}`;
}

function inputKey(input: EvalSetItemCreate): string {
  return "case_id" in input
    ? `case:${input.case_id}`
    : `turn:${input.source.tree}/${input.source.conversation_id}/${input.source.turn_id}`;
}

// ---------------------------------------------------------------- rubrics
function RubricsTab({
  rubrics,
  total,
  onLoadMore,
  onChanged,
  onError,
}: {
  rubrics: Rubric[] | null;
  /** Rubrics matching across all pages (RubricPage.total) — the list is a prefix. */
  total: number;
  onLoadMore: () => Promise<void>;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = rubrics?.find((r) => r.id === selectedId) ?? null;

  async function saveVersion() {
    if (!selected) return;
    setBusy(true);
    try {
      // "save = new version" (feature-spec.md:128; openapi.yaml:1317-1319).
      const saved = await api.createRubricVersion(selected.id, { prompt });
      setNotice(`Saved as version ${saved.version}.`);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createRubric() {
    setBusy(true);
    try {
      const created = await api.createRubric({ name: newName, prompt });
      setNewName("");
      setSelectedId(created.id);
      setNotice(`Created ${created.name} v${created.version}.`);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Group align="flex-start" gap="sm" wrap="nowrap">
      <Paper withBorder p="xs" w={300} style={{ flexShrink: 0 }}>
        <Stack gap={6}>
          {rubrics === null && <Loader size="xs" />}
          {rubrics?.length === 0 && (
            <Text size="xs" c="dimmed" data-testid="rubrics-empty">
              No rubrics yet. A rubric is the scoring prompt the judge runs; saving one
              always creates a new version so old scores stay comparable.
            </Text>
          )}
          <Stack gap={2}>
            {(rubrics ?? []).map((r) => (
              <UnstyledButton
                key={r.id}
                data-testid={`rubric-row-${r.id}`}
                onClick={() => {
                  setSelectedId(r.id);
                  setPrompt(r.prompt);
                  setNotice(null);
                }}
                style={{ width: "100%" }}
              >
                <Group gap={6} px={4} py={3}>
                  <Text size="xs" truncate style={{ flex: 1 }}>
                    {r.name}
                  </Text>
                  <Badge size="xs" variant="light">
                    v{r.version}
                  </Badge>
                </Group>
              </UnstyledButton>
            ))}
            {rubrics != null && total > rubrics.length && (
              <Button
                variant="subtle"
                size="compact-xs"
                data-testid="rubrics-load-more"
                onClick={() => void onLoadMore()}
              >
                Load more ({rubrics.length} of {total})
              </Button>
            )}
          </Stack>
          <Divider my={2} />
          <TextInput
            size="xs"
            label="New rubric name"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
          />
          <Button
            size="compact-xs"
            variant="light"
            onClick={createRubric}
            loading={busy}
            disabled={!newName.trim() || !prompt.trim()}
          >
            Create rubric
          </Button>
        </Stack>
      </Paper>
      <Paper withBorder p="xs" style={{ flex: 1 }}>
        <Stack gap={6}>
          <Group gap={6}>
            <Text fw={600} size="sm">
              {selected ? selected.name : "Rubric prompt"}
            </Text>
            {selected && (
              <Badge size="xs" variant="light">
                v{selected.version}
              </Badge>
            )}
          </Group>
          <Textarea
            size="xs"
            aria-label="Rubric prompt"
            autosize
            minRows={6}
            value={prompt}
            onChange={(e) => setPrompt(e.currentTarget.value)}
          />
          <Group>
            <Button
              size="xs"
              onClick={saveVersion}
              loading={busy}
              disabled={!selected || !prompt.trim()}
            >
              Save as new version
            </Button>
            {notice && (
              <Text size="xs" c="dimmed" data-testid="rubric-notice">
                {notice}
              </Text>
            )}
          </Group>
        </Stack>
      </Paper>
    </Group>
  );
}
