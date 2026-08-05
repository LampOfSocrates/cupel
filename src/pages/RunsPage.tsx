import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  Alert,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Stepper,
  Text,
  Title,
} from "@mantine/core";
import { api } from "../api/client";
import type { Agent, Rubric, RunConfig, RunSummaryItem, SelectionItem } from "../api/types";
import { ConversationPicker, RunConfigPanel, RunsList } from "../components";
import { ReadOnlyTreeBanner } from "../shell/ReadOnlyTreeBanner";
import { useApp } from "../AppContext";

// P1-T11 — Runs 3-step flow (skein-phases.md:19): "Replay stored conversations
// — or a single turn — under a different instruction version, model, or
// endpoint — using the Runs stepper: pick (sketch 02), configure (sketch 03),
// compare (sketch 04)". Engine (feature-spec.md:41): "take stored
// conversations or individual turns, re-execute them under a changed config…
// queue the work, compare outputs."
//
// Landing = RunsList of GET /agenttrees/{tree}/runs ("Runs, newest first",
// openapi.yaml:663) + "New run" opening the stepper; row click → the run
// detail route (RunDetailPage — step 3 doubles as the results view for old
// runs).
//
// Step 2 supports MULTIPLE configs because the grid is "baseline column + one
// column per run config" (feature-spec.md:49; ReplayRequest.configs[] "One
// grid column per config", openapi.yaml:1527-1533). Sketch 03 shows a single
// config drawer, so the UI is one panel per config + an "Add config"
// affordance that duplicates the previous config (documented deviation:
// minimum 1 config, matching the sketch's single-drawer density).
//
// P1-T12b: judge section live (feature-spec.md:48 "Judge (optional, collapsed
// by default): toggle on → judge model + rubric fields appear") — rubric
// dropdown fed by GET /eval/rubrics (feature-spec.md:230 "Runs · 2 Configure |
// … GET /eval/rubrics"), judge model from the session models cache. The judge
// FIRES from RunDetailPage when the run reaches done (see its judge-trigger
// note) — queueing here only records the intent in the config.
//
// Scope guards (never build ahead, skein-phases.md:158):
// - endpoints hidden (showEndpoints defaults false) — turn re-fire is P1-T13.
// - baseline_run_id UI skipped: the clean sketch 03 shows only a "baseline:
//   … · prefilled" caption, no picker — baseline = the stored originals.
// - no queue UI here — the queue PANEL is P1-T08.
//
// P1-T20b — Test-in-Runs arrival (skein-phases.md:18 "editor → Runs flow
// (sketches 06 → 03)"): the editor navigates here with router state
// {testInRuns: {agent_id, snapshot_id, snapshot_label}} (see EditorPage's
// handoff note). Prefill (feature-spec.md:87 "the previous conversation set
// is remembered per agent (GET/PUT /agents/{id}/last-selection). Repeat
// testing = Test in Runs → Queue, two taps."):
// - GET last-selection; non-empty items → seed the selection and land on
//   Configure directly (the two taps: Test in Runs → Queue); "empty items =
//   first-time testing" (openapi.yaml:311) → land on Pick.
// - the single config is prefilled {agent_id, snapshot_id}; the panel shows
//   the snapshot's label ("v3-draft (a3f1)", feature-spec.md:86).
// - Queue PUTs last-selection with the selection ACTUALLY queued (preloaded
//   or user-changed) before POSTing the replay, so the next test remembers it.
// A fresh "New run" clears the flow — the PUT belongs to Test-in-Runs only.

// P1-T15 — sidebar presets (feature-spec.md:102-103): "Sidebar Tune → opens
// Runs with instruction-version field focused, judge off. Sidebar Evaluate →
// opens Runs with model field + judge section expanded." The preset travels
// as router state {preset} (same mechanism as the T20b handoff above) but is
// applied in an effect keyed on the location, because the sidebar links can
// fire while this page is already mounted. A preset only shapes the Configure
// step's INITIAL panel UI (focus + judge open/closed) — the flow is
// unchanged: the user still picks conversations first unless a selection is
// already in progress mid-stepper.

interface TestInRunsState {
  agent_id: string;
  snapshot_id: string;
  snapshot_label: string;
}

type Preset = "tune" | "evaluate";

const emptyConfig = (): RunConfig => ({});

export function RunsPage() {
  const { tree, models, ensureModels } = useApp();
  const navigate = useNavigate();
  const location = useLocation();

  // Test-in-Runs handoff, read once from router state (cleared by "New run").
  const [testFlow, setTestFlow] = useState<TestInRunsState | null>(
    () => (location.state as { testInRuns?: TestInRunsState } | null)?.testInRuns ?? null,
  );

  // Preset handoff (P1-T15) — initial value seeds mode so a preset arrival
  // opens the stepper without a list-mode flash; re-arrivals land in the
  // location-keyed effect below.
  const [preset, setPreset] = useState<Preset | null>(
    () => (location.state as { preset?: Preset } | null)?.preset ?? null,
  );

  const [runs, setRuns] = useState<RunSummaryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"list" | "stepper">(testFlow || preset ? "stepper" : "list");
  // Waiting on GET last-selection before the stepper knows its landing step.
  const [prefilling, setPrefilling] = useState(testFlow != null);

  // Stepper state — step 0 = Select, 1 = Configure; step 2 (Results) lives on
  // the run-detail route, entered by Queue's navigate.
  const [step, setStep] = useState(0);
  const [selection, setSelection] = useState<SelectionItem[]>([]);
  const [configs, setConfigs] = useState<RunConfig[]>(
    testFlow
      ? [{ agent_id: testFlow.agent_id, snapshot_id: testFlow.snapshot_id }]
      : [emptyConfig()],
  );
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [rubrics, setRubrics] = useState<Rubric[] | null>(null);
  const [versionsByAgent, setVersionsByAgent] = useState<Record<string, number[]>>({});
  const versionsRequested = useRef(new Set<string>());
  const [queueing, setQueueing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .runs(tree)
      .then((data) => {
        if (!cancelled) setRuns(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [tree]);

  // Configure-step dropdown data (feature-spec.md:230 "Runs · 2 Configure |
  // GET …/agents/{id}/instructions, GET /models, GET /eval/rubrics"): agents +
  // rubrics + models fetched on entering the step; models come from the
  // session cache (AppContext).
  useEffect(() => {
    if (mode !== "stepper" || step !== 1) return;
    ensureModels();
    if (agents == null) {
      api.agents(tree).then(setAgents).catch((e: Error) => setError(e.message));
    }
    if (rubrics == null) {
      api.rubrics().then(setRubrics).catch((e: Error) => setError(e.message));
    }
  }, [mode, step, agents, rubrics, tree, ensureModels]);

  // Instruction versions per selected agent, fetched lazily on first pick
  // (GET …/instructions, openapi.yaml:221-239 — versions ascending).
  const ensureVersions = useCallback(
    (agentId: string) => {
      if (versionsRequested.current.has(agentId)) return;
      versionsRequested.current.add(agentId);
      api
        .instructions(tree, agentId)
        .then((h) =>
          setVersionsByAgent((prev) => ({
            ...prev,
            [agentId]: h.versions.map((v) => v.version),
          })),
        )
        .catch(() => {
          versionsRequested.current.delete(agentId);
        });
    },
    [tree],
  );

  // Test-in-Runs prefill: fetch the per-agent remembered selection once on
  // arrival (GET .../last-selection, openapi.yaml:295-313). Non-empty →
  // preload + jump to Configure; "empty items = first-time testing" (:311)
  // → start at Pick. Runs once for the mount's handoff, hence no deps.
  useEffect(() => {
    if (!testFlow) return;
    let cancelled = false;
    ensureVersions(testFlow.agent_id); // version dropdown data for the prefilled agent
    api
      .lastSelection(tree, testFlow.agent_id)
      .then((sel) => {
        if (cancelled) return;
        setSelection(sel.items);
        setStep(sel.items.length > 0 ? 1 : 0);
        setPrefilling(false);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setPrefilling(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Preset arrival — runs for every location change so clicking Tune/Evaluate
  // while already on /runs still applies. From the list a preset is a fresh
  // stepper entry (same reset as "New run"); mid-stepper it keeps the flow and
  // jumps to Configure only when a selection is already in progress. Reads
  // mode/selection without depending on them: this reacts to NAVIGATION only.
  useEffect(() => {
    const p = (location.state as { preset?: Preset } | null)?.preset;
    if (!p) return;
    setPreset(p);
    if (mode === "list") {
      setTestFlow(null);
      setSelection([]);
      setConfigs([emptyConfig()]);
      setStep(0);
      setMode("stepper");
    } else {
      setStep(selection.length > 0 ? 1 : 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const startStepper = () => {
    // Fresh manual run — drop any Test-in-Runs handoff (its config prefill
    // and Queue-time last-selection PUT belong to that flow only) and any
    // preset shaping (a plain "New run" carries no preset UI).
    setTestFlow(null);
    setPreset(null);
    setMode("stepper");
    setStep(0);
    setSelection([]);
    setConfigs([emptyConfig()]);
  };

  const queueRun = async () => {
    setQueueing(true);
    try {
      // Test-in-Runs: remember the selection ACTUALLY queued for this agent
      // before enqueueing (PUT .../last-selection, openapi.yaml:315-332;
      // feature-spec.md:87 "Repeat testing = Test in Runs → Queue, two taps").
      if (testFlow) {
        await api.putLastSelection(tree, testFlow.agent_id, { items: selection });
      }
      // POST /agenttrees/{tree}/replay → "202: Work enqueued; run row appears
      // immediately and fills incrementally" (openapi.yaml:616-617) — navigate
      // straight to the detail route, which owns the live fill.
      const accepted = await api.replay(tree, { selection, configs });
      navigate(`/runs/${accepted.run_id}`);
    } catch (e) {
      setError((e as Error).message);
      setQueueing(false);
    }
  };

  if (mode === "list") {
    return (
      <Stack gap="sm" p="md" maw={640}>
        <Group justify="space-between">
          <Title order={3}>Runs</Title>
          <Button size="xs" onClick={startStepper}>
            New run
          </Button>
        </Group>
        {/* P2-T07c: a disabled tree keeps its runs readable while queueing new
            work 409s (feature-spec.md:20 "read-only banner"). */}
        <ReadOnlyTreeBanner />
        {error && (
          <Alert color="red" title="Error">
            {error}
          </Alert>
        )}
        {runs == null ? (
          <Loader size="sm" mx="auto" my="md" />
        ) : (
          <RunsList runs={runs} onOpen={(run) => navigate(`/runs/${run.id}`)} />
        )}
      </Stack>
    );
  }

  return (
    <Stack gap="sm" p="md" maw={640}>
      <Stepper active={step} size="xs">
        <Stepper.Step label="Select" />
        <Stepper.Step label="Configure" />
        <Stepper.Step label="Results" />
      </Stepper>
      <ReadOnlyTreeBanner />
      {error && (
        <Alert color="red" title="Error" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {prefilling && <Loader size="sm" mx="auto" my="md" data-testid="prefill-loader" />}

      {!prefilling && step === 0 && (
        <>
          {/* Step 1 Select (feature-spec.md:44): "ConversationPicker:
              search/filter/multi-select conversations, expandable to pick
              individual turns" — server-side search inside the picker.
              initialSelection restores the current picks (remembered
              last-selection on Test-in-Runs arrival, or Back from Configure). */}
          <ConversationPicker
            tree={tree}
            onSelectionChange={setSelection}
            initialSelection={selection}
          />
          <Group justify="space-between">
            <Button variant="default" size="xs" onClick={() => setMode("list")}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={selection.length === 0}
              onClick={() => setStep(1)}
            >
              Configure ▸
            </Button>
          </Group>
        </>
      )}

      {!prefilling && step === 1 && (
        <>
          {/* Step 2 Configure (feature-spec.md:45): "Run Config drawer …
              prefilled from the baseline so changing one axis = one field".
              baseline = {} = the stored originals / live version
              (openapi.yaml:1489 "neither = the live version"). */}
          <Text size="xs" c="dimmed">
            baseline: stored originals · prefilled
          </Text>
          {configs.map((cfg, i) => (
            // key includes the preset so a preset arrival mid-Configure
            // remounts the panel (focus + judge-open are mount-time initial
            // state, not controlled props).
            <Paper key={`${preset ?? "manual"}-${i}`} withBorder p="sm" data-testid={`config-${i}`}>
              <Group justify="space-between" mb={4}>
                <Text size="xs" fw={600}>
                  Config {i + 1}
                </Text>
                {configs.length > 1 && (
                  <Button
                    variant="subtle"
                    color="red"
                    size="compact-xs"
                    onClick={() =>
                      setConfigs((prev) => prev.filter((_, j) => j !== i))
                    }
                  >
                    Remove
                  </Button>
                )}
              </Group>
              <RunConfigPanel
                value={cfg}
                onChange={(next) => {
                  setConfigs((prev) => prev.map((c, j) => (j === i ? next : c)));
                  if (next.agent_id) ensureVersions(next.agent_id);
                }}
                baseline={emptyConfig()}
                agents={agents ?? []}
                versions={cfg.agent_id ? (versionsByAgent[cfg.agent_id] ?? []) : []}
                models={models ?? []}
                rubrics={rubrics ?? []}
                // "Unsaved snapshots display as 'v15-draft (a3f2)'"
                // (feature-spec.md:86) — label carried in the handoff state.
                snapshotLabel={
                  cfg.snapshot_id != null && cfg.snapshot_id === testFlow?.snapshot_id
                    ? testFlow.snapshot_label
                    : undefined
                }
                // Preset shaping (feature-spec.md:102-103), first config only:
                // Tune = version focused + judge off; Evaluate = model
                // focused + judge section expanded.
                initialFocus={
                  i === 0 && preset ? (preset === "tune" ? "version" : "model") : undefined
                }
                judgeInitiallyOpen={
                  i === 0 && preset ? preset === "evaluate" : undefined
                }
              />
            </Paper>
          ))}
          <Button
            variant="light"
            size="compact-xs"
            onClick={() => setConfigs((prev) => [...prev, { ...prev[prev.length - 1] }])}
          >
            + Add config
          </Button>
          <Group justify="flex-end">
            <Button variant="default" size="xs" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button size="xs" loading={queueing} onClick={() => void queueRun()}>
              Queue
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}
