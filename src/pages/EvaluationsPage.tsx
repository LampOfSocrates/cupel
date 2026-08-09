import { useCallback, useEffect, useReducer, useRef, useState } from "react";
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
import type { Agent, Rubric, Variant, SelectionItem } from "../api/types";
import { useAsync } from "../hooks/useAsync";
import { ConversationPicker, RunConfigPanel, RunsList } from "../components";
import { ReadOnlyTreeBanner } from "../shell/ReadOnlyTreeBanner";
import { useApp } from "../AppContext";

// Evaluations 3-step flow (cupel-phases.md:19): "Replay stored conversations
// — or a single turn — under a different instruction version, model, or
// endpoint — using the Evaluations stepper: pick (sketch 02), configure (sketch 03),
// compare (sketch 04)". Engine (feature-spec.md:41): "take stored
// conversations or individual turns, re-execute them under a changed config…
// queue the work, compare outputs."
//
// Landing = RunsList of GET /agenttrees/{tree}/evaluations ("Evaluations, newest first",
// openapi.yaml:663) + "New run" opening the stepper; row click → the evaluation
// detail route (EvaluationPage — step 3 doubles as the results view for old
// evaluations).
//
// Step 2 supports MULTIPLE configs because the grid is "baseline column + one
// column per run config" (feature-spec.md:49; ReplayRequest.configs[] "One
// grid column per config", openapi.yaml:1527-1533). Sketch 03 shows a single
// config drawer, so the UI is one panel per config + an "Add config"
// affordance that duplicates the previous config (documented deviation:
// minimum 1 config, matching the sketch's single-drawer density).
//
// Judge section live (feature-spec.md:48 "Judge (optional, collapsed
// by default): toggle on → judge model + rubric fields appear") — rubric
// dropdown fed by GET /eval/rubrics (feature-spec.md:226 "Evaluations · 2 Configure |
// … GET /eval/rubrics"), judge model from the session models cache. The judge
// FIRES from EvaluationPage when the evaluation reaches done (see its judge-trigger
// note) — queueing here only records the intent in the config.
//
// Scope guards (never build ahead, cupel-phases.md:158):
// - endpoints hidden (showEndpoints defaults false).
// - baseline_evaluation_id UI skipped: the clean sketch 03 shows only a "baseline:
//   … · prefilled" caption, no picker — baseline = the stored originals.
//
// Test-as-evaluation arrival (cupel-phases.md:18 "editor → Evaluations flow
// (sketches 06 → 03)"): the editor navigates here with router state
// {testInRuns: {agent_id, snapshot_id, snapshot_label}} (see EditorPage's
// handoff note). Prefill (feature-spec.md:87 "the previous conversation set
// is remembered per agent (GET/PUT /agents/{id}/last-selection). Repeat
// testing = Test as evaluation → Queue, two taps."):
// - GET last-selection; non-empty items → seed the selection and land on
//   Configure directly (the two taps: Test as evaluation → Queue); "empty items =
//   first-time testing" (openapi.yaml:311) → land on Pick.
// - the single config is prefilled {agent_id, snapshot_id}; the panel shows
//   the snapshot's label ("v3-draft (a3f1)", feature-spec.md:86).
// - Queue PUTs last-selection with the selection ACTUALLY queued (preloaded
//   or user-changed) before POSTing the replay, so the next test remembers it.
// A fresh "New run" clears the flow — the PUT belongs to Test-as-evaluation only.

interface TestInRunsState {
  agent_id: string;
  snapshot_id: string;
  snapshot_label: string;
}

/** Router state this page can arrive with — the editor's Test-as-evaluation handoff. */
interface Handoff {
  testInRuns?: TestInRunsState;
}

const emptyConfig = (): Variant => ({});

// One reducer owns everything the stepper navigates by. Router state has a
// single reader — the `arrive` case, which both seeds the initial state and
// folds in later arrivals — and `navKey` makes it idempotent, since the effect
// that dispatches arrivals also fires for the one the initial state consumed.
interface NavState {
  /** location.key already folded in; null before the first arrival. */
  navKey: string | null;
  mode: "list" | "stepper";
  /** 0 = Select, 1 = Configure; step 2 (Results) lives on the evaluation-detail route. */
  step: number;
  /** Waiting on GET last-selection before the stepper knows its landing step. */
  prefilling: boolean;
  testFlow: TestInRunsState | null;
  selection: SelectionItem[];
  configs: Variant[];
}

type NavAction =
  | { type: "arrive"; key: string; handoff: Handoff | null }
  | { type: "prefilled"; items: SelectionItem[] }
  | { type: "prefillFailed" }
  | { type: "newEvaluation" }
  | { type: "cancel" }
  | { type: "goToStep"; step: number }
  | { type: "select"; items: SelectionItem[] }
  | { type: "addConfig" }
  | { type: "removeConfig"; index: number }
  | { type: "updateConfig"; index: number; config: Variant };

// A fresh stepper entry drops any Test-as-evaluation handoff: its config prefill and
// its Queue-time last-selection PUT belong to that flow only.
const freshStepper = (state: NavState): NavState => ({
  ...state,
  mode: "stepper",
  step: 0,
  prefilling: false,
  testFlow: null,
  selection: [],
  configs: [emptyConfig()],
});

function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case "arrive": {
      if (action.key === state.navKey) return state;
      const next = { ...state, navKey: action.key };
      const { testInRuns } = action.handoff ?? {};
      if (!testInRuns) return next;
      return {
        ...next,
        mode: "stepper",
        step: 0,
        prefilling: true,
        testFlow: testInRuns,
        selection: [],
        configs: [{ agent_id: testInRuns.agent_id, snapshot_id: testInRuns.snapshot_id }],
      };
    }
    case "prefilled":
      // "empty items = first-time testing" (openapi.yaml:311) → start at Pick.
      return {
        ...state,
        selection: action.items,
        step: action.items.length > 0 ? 1 : 0,
        prefilling: false,
      };
    case "prefillFailed":
      return { ...state, prefilling: false };
    case "newEvaluation":
      return freshStepper(state);
    case "cancel":
      return { ...state, mode: "list" };
    case "goToStep":
      return { ...state, step: action.step };
    case "select":
      return { ...state, selection: action.items };
    case "addConfig":
      return {
        ...state,
        configs: [...state.configs, { ...state.configs[state.configs.length - 1] }],
      };
    case "removeConfig":
      return { ...state, configs: state.configs.filter((_, i) => i !== action.index) };
    case "updateConfig":
      return {
        ...state,
        configs: state.configs.map((c, i) => (i === action.index ? action.config : c)),
      };
  }
}

const initialNav = (handoff: Handoff | null, key: string): NavState =>
  navReducer(
    {
      navKey: null,
      mode: "list",
      step: 0,
      prefilling: false,
      testFlow: null,
      selection: [],
      configs: [emptyConfig()],
    },
    { type: "arrive", key, handoff },
  );

export function EvaluationsPage() {
  const { tree, models, ensureModels } = useApp();
  const navigate = useNavigate();
  const location = useLocation();

  // Seeded from the arrival so a handoff opens the stepper without a
  // list-mode flash; every later arrival goes through the same reducer case.
  const [nav, dispatch] = useReducer(navReducer, null, () =>
    initialNav(location.state as Handoff | null, location.key),
  );
  const { mode, step, prefilling, testFlow, selection, configs } = nav;

  const { data: evaluations, error: evaluationsError } = useAsync(() => api.evaluations(tree), [tree]);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [rubrics, setRubrics] = useState<Rubric[] | null>(null);
  const [versionsByAgent, setVersionsByAgent] = useState<Record<string, number[]>>({});
  const versionsRequested = useRef(new Set<string>());
  const [queueing, setQueueing] = useState(false);

  // Configure-step dropdown data (feature-spec.md:226 "Evaluations · 2 Configure |
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

  // Test-as-evaluation prefill: fetch the per-agent remembered selection on arrival
  // (GET .../last-selection, openapi.yaml:295-313).
  useEffect(() => {
    if (!testFlow) return;
    let cancelled = false;
    ensureVersions(testFlow.agent_id); // version dropdown data for the prefilled agent
    api
      .lastSelection(tree, testFlow.agent_id)
      .then((sel) => {
        if (!cancelled) dispatch({ type: "prefilled", items: sel.items });
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        dispatch({ type: "prefillFailed" });
      });
    return () => {
      cancelled = true;
    };
  }, [testFlow, tree, ensureVersions]);

  // Arrivals — fires for every location change, so a Test-as-evaluation handoff
  // reaching a page that is ALREADY mounted still applies; the reducer drops a
  // key it already folded in.
  useEffect(() => {
    dispatch({
      type: "arrive",
      key: location.key,
      handoff: location.state as Handoff | null,
    });
  }, [location]);

  const startStepper = () => dispatch({ type: "newEvaluation" });

  const queueEvaluation = async () => {
    setQueueing(true);
    try {
      // Test-as-evaluation: remember the selection ACTUALLY queued for this agent
      // before enqueueing (PUT .../last-selection, openapi.yaml:315-332;
      // feature-spec.md:87 "Repeat testing = Test as evaluation → Queue, two
      // taps").
      if (testFlow) {
        await api.putLastSelection(tree, testFlow.agent_id, { items: selection });
      }
      // POST /agenttrees/{tree}/replay → "202: Work enqueued; evaluation row appears
      // immediately and fills incrementally" (openapi.yaml:616-617) — navigate
      // straight to the detail route, which owns the live fill.
      const accepted = await api.replay(tree, { selection, configs });
      navigate(`/evaluations/${accepted.evaluation_id}`);
    } catch (e) {
      setError((e as Error).message);
      setQueueing(false);
    }
  };

  if (mode === "list") {
    return (
      <Stack gap="sm" p="md" maw={640}>
        <Group justify="space-between">
          <Title order={3}>Evaluations</Title>
          <Button size="xs" onClick={startStepper}>
            New evaluation
          </Button>
        </Group>
        {/* A disabled tree keeps its evaluations readable while queueing new
            work 409s (feature-spec.md:20 "read-only banner"). */}
        <ReadOnlyTreeBanner />
        {(evaluationsError ?? error) && (
          <Alert color="red" title="Error">
            {evaluationsError?.message ?? error}
          </Alert>
        )}
        {evaluations == null ? (
          <Loader size="sm" mx="auto" my="md" />
        ) : (
          <RunsList evaluations={evaluations} onOpen={(evaluation) => navigate(`/evaluations/${evaluation.id}`)} />
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
              last-selection on Test-as-evaluation arrival, or Back from Configure). */}
          <ConversationPicker
            tree={tree}
            onSelectionChange={(items) => dispatch({ type: "select", items })}
            initialSelection={selection}
          />
          <Group justify="space-between">
            <Button variant="default" size="xs" onClick={() => dispatch({ type: "cancel" })}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={selection.length === 0}
              onClick={() => dispatch({ type: "goToStep", step: 1 })}
            >
              Configure ▸
            </Button>
          </Group>
        </>
      )}

      {!prefilling && step === 1 && (
        <>
          {/* Step 2 Configure (feature-spec.md:45): "Variant drawer …
              prefilled from the baseline so changing one axis = one field".
              baseline = {} = the stored originals / live version
              (openapi.yaml:1489 "neither = the live version"). */}
          <Text size="xs" c="dimmed">
            baseline: stored originals · prefilled
          </Text>
          {configs.map((cfg, i) => (
            <Paper key={i} withBorder p="sm" data-testid={`config-${i}`}>
              <Group justify="space-between" mb={4}>
                <Text size="xs" fw={600}>
                  Config {i + 1}
                </Text>
                {configs.length > 1 && (
                  <Button
                    variant="subtle"
                    color="red"
                    size="compact-xs"
                    onClick={() => dispatch({ type: "removeConfig", index: i })}
                  >
                    Remove
                  </Button>
                )}
              </Group>
              <RunConfigPanel
                value={cfg}
                onChange={(next) => {
                  dispatch({ type: "updateConfig", index: i, config: next });
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
              />
            </Paper>
          ))}
          <Button
            variant="light"
            size="compact-xs"
            onClick={() => dispatch({ type: "addConfig" })}
          >
            + Add config
          </Button>
          <Group justify="flex-end">
            <Button variant="default" size="xs" onClick={() => dispatch({ type: "goToStep", step: 0 })}>
              Back
            </Button>
            <Button size="xs" loading={queueing} onClick={() => void queueEvaluation()}>
              Queue
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}
