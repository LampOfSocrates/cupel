import { useCallback, useEffect, useMemo, useState } from "react";
import {
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
  Textarea,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { api } from "../../api/client";
import { useApp } from "../../AppContext";
import { EvalImportModal } from "../../components/EvalImportModal";
import { TurnSourceModal } from "../../components/TurnSourceModal";
import { product } from "../../lib/product";
import { useStudio, useStudioState } from "./StudioContext";
import { shorten } from "./shorten";
import type { EvalCase, Judgment } from "../../api/types";

// Eval workbench (sketch 10) — "Hand-craft expected answers and have
// the judge score AI against them — type/paste references, pull them from real
// turns or forks, or bulk-import a spreadsheet of input/expected pairs". The
// case editor half of "case editor (input / output / reference fields;
// 'reference from turn' picker), benchmark manager …, rubric editor"
// (feature-spec.md:63).
//
// Two honesty notes, both forced by the contract as it stands and
// deliberately NOT worked around here:
//
// 1. There is no list-all-cases endpoint — /eval/cases has POST only
//    and cases are read one id at a time. So the case list is
//    BENCHMARK-scoped, exactly as the annotated sketch tags it ("Benchmark:
//    refund-fails v3 / GET /eval/benchmarks"), plus a "just created here"
//    bucket for cases this session made that are not in a benchmark yet. The
//    screen says so rather than pretending to show everything.
// 2. GET /eval/cases/{id} "Returns the LATEST version" (openapi.yaml:1441-1442)
//    and no endpoint returns earlier ones. The editor therefore shows the
//    CURRENT version number and states that prior versions are not retrievable
//    through this API — no fabricated history list. What IS real history is
//    the judgment trail (GET /eval/judgments?subject_kind=case, append-only,
//    feature-spec.md:59), so that is what the case panel renders.
//    (A known contract gap — not fixed here.)

const SESSION_BUCKET = "__session__";

interface CaseDraft {
  prompt: string;
  output: string;
  reference: string;
  agenttree: string;
}

const EMPTY_DRAFT: CaseDraft = { prompt: "", output: "", reference: "", agenttree: "" };

export function CasesTab() {
  const { tree } = useApp();
  const {
    benchmarks,
    cases,
    setCases,
    sessionCaseIds,
    rememberCase,
    rubricOptions,
    modelOptions,
    loadBenchmarks,
    setError,
  } = useStudio();

  // Buffers that outlive a tab click (StudioContext note 2) — a half-written
  // expected answer must survive a trip to Benchmarks and back.
  const [bucket, setBucket] = useStudioState<string>("cases.bucket", SESSION_BUCKET);
  const [selectedCaseId, setSelectedCaseId] = useStudioState<string | null>("cases.selectedId", null);
  const [draftId, setDraftId] = useStudioState<string | null>("cases.draftId", null);
  const [draft, setDraft] = useStudioState<CaseDraft>("cases.draft", EMPTY_DRAFT);
  const [notice, setNotice] = useStudioState<string | null>("cases.notice", null);
  const [judgments, setJudgments] = useStudioState<Judgment[] | null>("cases.judgments", null);
  const [pickedRubricId, setRubricId] = useStudioState<string | null>("cases.rubricId", null);
  const [judgeModel, setJudgeModel] = useStudioState<string | null>("cases.judgeModel", null);

  // In-flight and modal state — nothing a tab click should preserve.
  const [loadingCases, setLoadingCases] = useState(false);
  const [saving, setSaving] = useState(false);
  const [judging, setJudging] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [turnPicker, setTurnPicker] = useState<null | "case" | "reference">(null);

  // Derived, not stored: an unpicked rubric reads as the first option, so the
  // default appears the moment the options do rather than one effect-render
  // later.
  const rubricId = pickedRubricId ?? rubricOptions[0]?.value ?? null;

  // Membership of the chosen bucket → one GET /eval/cases/{id} per member.
  const bucketCaseIds = useMemo(() => {
    if (bucket === SESSION_BUCKET) return sessionCaseIds;
    // A bucket is a benchmark's FROZEN members: a reference item has no case
    // to read yet, so it appears here only once frozen.
    return (benchmarks?.find((b) => b.id === bucket)?.items ?? [])
      .filter((i) => i.kind === "frozen" && i.case_id)
      .map((i) => i.case_id as string);
  }, [bucket, sessionCaseIds, benchmarks]);

  useEffect(() => {
    const missing = bucketCaseIds.filter((id) => !cases[id]);
    if (missing.length === 0) return;
    let cancelled = false;
    // KEPT: an incremental cache FILL, one GET per case id the cache is
    // missing, merged in. A failed case is caught to null and never lands, so
    // "is anything still missing" is not an equivalent derivation of the flag;
    // it would never clear.
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
  }, [bucketCaseIds, cases, setCases]);

  const selectedCase = selectedCaseId ? cases[selectedCaseId] : undefined;

  const openCase = useCallback(
    (c: EvalCase) => {
      setSelectedCaseId(c.id);
      setDraftId(c.id);
      setDraft({
        prompt: c.input.prompt,
        output: c.output,
        reference: c.reference ?? "",
        agenttree: c.agenttree,
      });
      setNotice(null);
      setJudgments(null);
      api
        .judgments({ subject_kind: "case", subject_id: c.id })
        .then((page) => setJudgments(page.items))
        .catch(() => setJudgments([]));
    },
    [setSelectedCaseId, setDraftId, setDraft, setNotice, setJudgments],
  );

  function newCase() {
    setSelectedCaseId(null);
    setDraftId(null);
    // Prefilled with the active tree — free text, so it stays editable for a
    // case meant to evaluate a different tree/endpoint than the one open now.
    setDraft({ ...EMPTY_DRAFT, agenttree: tree });
    setNotice(null);
    setJudgments(null);
  }

  async function saveCase() {
    setSaving(true);
    setError(null);
    try {
      const reference = draft.reference.trim() ? draft.reference : null;
      if (draftId) {
        // "each save appends the next version, never overwrites". agenttree
        // is not sent here — it carries over unchanged, same as source.
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
          agenttree: draft.agenttree.trim(),
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

  const bucketOptions = [
    { value: SESSION_BUCKET, label: `Created here (${sessionCaseIds.length})` },
    ...(benchmarks ?? []).map((b) => ({
      value: b.id,
      label: `${b.name} v${b.version} · ${b.items.length}`,
    })),
  ];

  return (
    <>
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
                  : "This benchmark has no cases yet — add some from the Benchmarks tab."}
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
                  Saving appends a new version. This API returns the latest version only —
                  earlier versions are not retrievable here.
                </Text>
              )}
            </Group>
            <TextInput
              size="xs"
              label="Target tree"
              description={
                draftId
                  ? "Fixed at creation — not part of a version save."
                  : `Which ${product.tree.one}/endpoint this case evaluates. Free text — not validated against known ${product.tree.many}.`
              }
              placeholder="e.g. agent1"
              disabled={draftId != null}
              value={draft.agenttree}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setDraft((d) => ({ ...d, agenttree: value }));
              }}
            />
            <Textarea
              size="xs"
              label="Input (prompt)"
              autosize
              minRows={2}
              value={draft.prompt}
              onChange={(e) => {
                // Capture before the updater runs: React nulls currentTarget
                // once the handler returns.
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
              <Button size="compact-xs" variant="subtle" onClick={() => setTurnPicker("reference")}>
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
                disabled={
                  !draft.prompt.trim() ||
                  !draft.output.trim() ||
                  (!draftId && !draft.agenttree.trim())
                }
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

      <EvalImportModal
        opened={importOpen}
        benchmarks={benchmarks ?? []}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          loadBenchmarks().catch(() => undefined);
        }}
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
            // Sourced creation: the server derives input + output from the
            // turn. agenttree defaults to the same tree the turn was picked
            // from — the active tree, already what source.tree carries.
            const created = await api.createEvalCase({
              agenttree: tree,
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
    </>
  );
}
