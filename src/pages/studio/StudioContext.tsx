import {
  createContext,
  useCallback,
  useContext,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { EvalBenchmark, EvalCase, Rubric } from "../../api/types";

// What /studio's tabs share, now that each tab is its own route.
//
// Two different needs live here and they are worth keeping apart:
//
// 1. GENUINELY SHARED DATA — the benchmark list feeds the Cases bucket
//    selector AND the Benchmarks manager; the case cache feeds both; the rubric
//    list feeds the Cases judge form AND the Benchmarks judge form. One fetch,
//    one cache, owned by the frame.
// 2. STATE THAT MERELY HAS TO SURVIVE A TAB CLICK — a half-typed rubric prompt,
//    a staged membership edit, a part-configured evaluation. Before the tabs
//    were routes they were Mantine <Tabs.Panel>s, and Tabs keeps inactive
//    panels mounted by default ("If set to `false`, `Tabs.Panel` content will
//    be unmounted when the associated tab is not active @default true",
//    @mantine/core/lib/components/Tabs/Tabs.d.ts:38-39; the default is applied
//    in Tabs.mjs:23). Routes unmount. useStudioState below is that guarantee
//    made explicit instead of inherited: the value lives in StudioFrame, which
//    outlives every tab, under a namespaced key.

export interface StudioOption {
  value: string;
  label: string;
}

export interface StudioContextValue {
  /** Latest-version benchmarks, a PREFIX of the paged collection. */
  benchmarks: EvalBenchmark[] | null;
  /** EvalBenchmarkPage.total — what the prefix is a prefix OF. */
  benchmarksTotal: number;
  loadBenchmarks: () => Promise<EvalBenchmark[]>;
  loadMoreBenchmarks: () => Promise<void>;

  rubrics: Rubric[] | null;
  /** RubricPage.total. */
  rubricsTotal: number;
  reloadRubrics: () => Promise<void>;
  loadMoreRubrics: () => Promise<void>;

  /** Cases this screen has read, keyed by id (no list-all endpoint exists). */
  cases: Record<string, EvalCase>;
  setCases: Dispatch<SetStateAction<Record<string, EvalCase>>>;
  sessionCaseIds: string[];
  rememberCase: (c: EvalCase) => void;
  /** Every case id either tab knows about — the Benchmarks "add a case" list. */
  knownCaseIds: string[];

  rubricOptions: StudioOption[];
  modelOptions: StudioOption[];

  /** The thrown VALUE, not its message — ApiError carries fields + request id. */
  error: unknown;
  setError: (error: unknown) => void;

  /** Backing store for useStudioState; not read directly by tabs. */
  bag: Record<string, unknown>;
  setBag: Dispatch<SetStateAction<Record<string, unknown>>>;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export const StudioProvider = StudioContext.Provider;

export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext);
  if (value === null) {
    throw new Error("useStudio() outside StudioFrame — the tab needs the frame's shared caches.");
  }
  return value;
}

/**
 * useState whose value lives in StudioFrame, so it survives its own tab being
 * navigated away from and back to (see note 2 above). `key` is namespaced by
 * tab ("cases.draft") and is what makes each buffer greppable.
 *
 * Outside a frame it degrades to a plain useState — a tab mounted standalone in
 * a unit test simply has no cross-tab persistence, which is the honest answer
 * rather than a crash.
 */
export function useStudioState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const studio = useContext(StudioContext);
  // Called unconditionally, and it does double duty. Without a frame it IS the
  // state. With one it is never written, so it stays the once-resolved initial
  // value — which is what the frame's store needs as its fallback before the
  // first write, and it has to be referentially STABLE: a fresh [] or {} every
  // render would re-trigger every effect and prop that reads it
  // (ConversationPicker's initialSelection, for one).
  const [local, setLocal] = useState<T>(initial);

  const setBag = studio?.setBag;
  const stored = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      setBag?.((prev) => {
        const current = (key in prev ? prev[key] : local) as T;
        return {
          ...prev,
          [key]: typeof next === "function" ? (next as (p: T) => T)(current) : next,
        };
      });
    },
    [key, setBag, local],
  );

  if (!studio) return [local, setLocal];
  return [(key in studio.bag ? studio.bag[key] : local) as T, stored];
}
