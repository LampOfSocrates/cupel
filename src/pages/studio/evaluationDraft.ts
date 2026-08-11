import type { SelectionItem, Variant } from "../../api/types";

// The evaluation stepper's buffer, lifted out of EvaluationsPage and into the
// Studio frame (StudioContext's bag, under EVALUATION_DRAFT_KEY).
//
// WHY IT MOVED: the stepper used to be a <Tabs.Panel> that Mantine kept mounted
// while you visited another tab, so a part-configured evaluation survived the
// trip. Tabs are routes now and routes unmount, so the buffer has to live in
// the thing that does not — the frame. StudioFrame reads it for the "still
// there" dot on the Evaluations tab.
//
// WHAT LEFT: the old NavState.mode ("list" | "stepper"). The route says which
// one now — /studio/evaluations is the list, /studio/evaluations/new is the
// stepper — so a "cancel" action became a navigation.

export const EVALUATION_DRAFT_KEY = "evaluations.draft";

export interface TestInRunsState {
  agent_id: string;
  snapshot_id: string;
  snapshot_label: string;
}

/** Router state the stepper can arrive with — the editor's Test-as-evaluation handoff. */
export interface Handoff {
  testInRuns?: TestInRunsState;
}

export const emptyConfig = (): Variant => ({});

export interface EvaluationDraft {
  /** location.key already folded in; null before the first arrival. */
  navKey: string | null;
  /** 0 = Select, 1 = Configure. Step 3 (Compare) is /studio/evaluations/{id}. */
  step: number;
  /** Waiting on GET last-selection before the stepper knows its landing step. */
  prefilling: boolean;
  testFlow: TestInRunsState | null;
  selection: SelectionItem[];
  configs: Variant[];
}

export type EvaluationDraftAction =
  | { type: "arrive"; key: string; handoff: Handoff | null }
  | { type: "prefilled"; items: SelectionItem[] }
  | { type: "prefillFailed" }
  | { type: "reset" }
  | { type: "goToStep"; step: number }
  | { type: "select"; items: SelectionItem[] }
  | { type: "addConfig" }
  | { type: "removeConfig"; index: number }
  | { type: "updateConfig"; index: number; config: Variant };

export const EMPTY_DRAFT: EvaluationDraft = {
  navKey: null,
  step: 0,
  prefilling: false,
  testFlow: null,
  selection: [],
  configs: [emptyConfig()],
};

// A fresh stepper entry drops any Test-as-evaluation handoff: its config prefill
// and its Queue-time last-selection PUT belong to that flow only.
const fresh = (state: EvaluationDraft): EvaluationDraft => ({
  ...EMPTY_DRAFT,
  navKey: state.navKey,
});

export function evaluationDraftReducer(
  state: EvaluationDraft,
  action: EvaluationDraftAction,
): EvaluationDraft {
  switch (action.type) {
    case "arrive": {
      if (action.key === state.navKey) return state;
      const next = { ...state, navKey: action.key };
      const { testInRuns } = action.handoff ?? {};
      if (!testInRuns) return next;
      return {
        ...next,
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
    case "reset":
      return fresh(state);
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

export const initialEvaluationDraft = (handoff: Handoff | null, key: string): EvaluationDraft =>
  evaluationDraftReducer(EMPTY_DRAFT, { type: "arrive", key, handoff });
