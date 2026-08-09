import { useCallback, useEffect, useMemo, useState } from "react";
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
import { EvalImportModal } from "../components/EvalImportModal";
import { TurnSourceModal } from "../components/TurnSourceModal";
import { product } from "../lib/product";
import type { EvalCase, EvalSet, Judgment, Rubric } from "../api/types";

// P2-T12 Eval workbench (sketch 10) — "Hand-craft expected answers and have
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
//    the judgment trail (GET /eval/judgments?case_id=, append-only,
//    feature-spec.md:59), so that is what the case panel renders.
//    (Contract gap logged as review bucket C5 — not fixed here.)
//
// Eval cases are GLOBAL, not tree-scoped ("Global: tasks, span payloads, eval
// rubrics/judgments, settings", feature-spec.md:115) — this page adds no tree
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
  const [error, setError] = useState<string | null>(null);

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
    const list = await api.evalSets();
    setSets(list);
    return list;
  }, []);

  const handleImported = useCallback(() => {
    loadSets().catch(() => undefined);
  }, [loadSets]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.evalSets(), api.rubrics()])
      .then(([setList, rubricList]) => {
        if (cancelled) return;
        setSets(setList);
        setRubrics(rubricList);
        setRubricId((id) => id ?? rubricList[0]?.id ?? null);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Membership of the chosen bucket → one GET /eval/cases/{id} per member.
  const bucketCaseIds = useMemo(() => {
    if (bucket === SESSION_BUCKET) return sessionCaseIds;
    return sets?.find((s) => s.id === bucket)?.case_ids ?? [];
  }, [bucket, sessionCaseIds, sets]);

  useEffect(() => {
    const missing = bucketCaseIds.filter((id) => !cases[id]);
    if (missing.length === 0) return;
    let cancelled = false;
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
      .judgments({ case_id: c.id })
      .then(setJudgments)
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
        const saved = await api.updateEvalCase(draftId, {
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
      setError((e as Error).message);
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
      setError((e as Error).message);
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
      label: `${s.name} v${s.version} · ${s.case_ids.length}`,
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
      {error && (
        <Alert color="red" title="Something went wrong" withCloseButton onClose={() => setError(null)}>
          {error}
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
                            {j.judge_model ?? "human"} · rubric {j.rubric_id ?? "—"} v
                            {j.rubric_version ?? "—"}
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
            cases={cases}
            knownCaseIds={Array.from(
              new Set([...sessionCaseIds, ...(sets ?? []).flatMap((s) => s.case_ids)]),
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
            onChanged={() => api.rubrics().then(setRubrics)}
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
            setError((e as Error).message);
          }
        }}
      />
    </Stack>
  );
}

// ------------------------------------------------------------------- sets
interface SetsTabProps {
  sets: EvalSet[] | null;
  cases: Record<string, EvalCase>;
  knownCaseIds: string[];
  rubricOptions: { value: string; label: string }[];
  modelOptions: { value: string; label: string }[];
  onChanged: () => Promise<EvalSet[]>;
  onError: (message: string) => void;
}

function SetsTab({
  sets,
  cases,
  knownCaseIds,
  rubricOptions,
  modelOptions,
  onChanged,
  onError,
}: SetsTabProps) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [membership, setMembership] = useState<string[]>([]);
  const [savingMembership, setSavingMembership] = useState(false);
  const [rubricId, setRubricId] = useState<string | null>(null);
  const [judgeModel, setJudgeModel] = useState<string | null>(null);
  const [judgeNotice, setJudgeNotice] = useState<string | null>(null);

  const selected = sets?.find((s) => s.id === selectedId) ?? null;

  // Default to the first rubric once they load, same as the case editor —
  // "Judge set" is one click from a picked set, not three.
  const firstRubricId = rubricOptions[0]?.value;
  useEffect(() => {
    setRubricId((id) => id ?? firstRubricId ?? null);
  }, [firstRubricId]);

  function select(s: EvalSet) {
    setSelectedId(s.id);
    setMembership(s.case_ids);
    setJudgeNotice(null);
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
    setSavingMembership(true);
    try {
      // "The full membership for the NEW version" (openapi.yaml:3431-3437).
      const saved = await api.updateEvalSet(selected.id, { case_ids: membership });
      await onChanged();
      setSelectedId(saved.id);
      setMembership(saved.case_ids);
      setJudgeNotice(`Membership saved as version ${saved.version}.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSavingMembership(false);
    }
  }

  async function judgeSet() {
    if (!selected || !rubricId || !judgeModel) return;
    try {
      // "set_id … judges the set's latest membership version unless
      // set_version pins one" (openapi.yaml:2921-2923) — the workbench pins
      // the version it is showing, so the judgment is attributable to exactly
      // that membership.
      const ref = await api.judge({
        set_id: selected.id,
        set_version: selected.version,
        rubric_id: rubricId,
        judge_model: judgeModel,
      });
      setJudgeNotice(`Judging queued as task ${ref.task_id} — watch the Queue.`);
    } catch (e) {
      onError((e as Error).message);
    }
  }

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
              No eval sets yet. A set is a named, versioned bundle of cases you can judge
              in one go and reuse across models.
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
                    {s.case_ids.length}
                  </Text>
                </Group>
              </UnstyledButton>
            ))}
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
            <Group gap={6}>
              <Text fw={600} size="sm">
                {selected.name}
              </Text>
              <Badge size="xs" variant="light">
                v{selected.version}
              </Badge>
              <Text size="xs" c="dimmed">
                Membership is versioned — saving appends a new version rather than
                editing this one.
              </Text>
            </Group>
            {knownCaseIds.length === 0 && (
              <Text size="xs" c="dimmed">
                No cases are loaded yet — create or import some on the Cases tab first.
              </Text>
            )}
            <ScrollArea.Autosize mah={320}>
              <Stack gap={2}>
                {knownCaseIds.map((id) => {
                  const inSet = membership.includes(id);
                  return (
                    <Group key={id} gap={6} wrap="nowrap">
                      <Button
                        size="compact-xs"
                        variant={inSet ? "light" : "subtle"}
                        color={inSet ? "red" : "blue"}
                        data-testid={`toggle-${id}`}
                        onClick={() =>
                          setMembership((m) =>
                            inSet ? m.filter((x) => x !== id) : [...m, id],
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
            <Group>
              <Button size="xs" onClick={saveMembership} loading={savingMembership}>
                Save membership as new version
              </Button>
            </Group>
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
                disabled={!rubricId || !judgeModel || selected.case_ids.length === 0}
              >
                Judge set
              </Button>
            </Group>
            {judgeNotice && (
              <Text size="xs" c="dimmed" data-testid="set-notice">
                {judgeNotice}
              </Text>
            )}
          </Stack>
        )}
      </Paper>
    </Group>
  );
}

// ---------------------------------------------------------------- rubrics
function RubricsTab({
  rubrics,
  onChanged,
  onError,
}: {
  rubrics: Rubric[] | null;
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
      // "save = new version" (feature-spec.md:132; openapi.yaml:1317-1319).
      const saved = await api.updateRubric(selected.id, { prompt });
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
