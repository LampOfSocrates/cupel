import { useCallback, useEffect, useRef, useState } from "react";

// ONE loading/error contract for every async read in the UI. Before this, each
// fetch site hand-rolled `useState(null)` + a `cancelled` flag, and each picked
// its own loading sentinel and error narrowing (`.catch((e: Error) => …)` was
// the common one — a lie, the rejection value is `unknown`).

/** A read is in exactly one of these three states. */
export type AsyncState<T> =
  | { kind: "loading" }
  | { kind: "ok"; data: T }
  | { kind: "error"; error: Error };

export interface Async<T> {
  state: AsyncState<T>;
  /** Projection of `state` for call sites that only branch on presence. */
  data: T | null;
  error: Error | null;
  loading: boolean;
  /**
   * Refetch under the CURRENT deps without dropping back to `loading` — the
   * rendered value stays up while the new response is in flight (live pages
   * refetch on stream frames; a flash back to a spinner would be wrong).
   */
  reload: () => void;
  /**
   * Local edit of an already-loaded value (optimistic updates, appends, merges
   * from a stream). A no-op unless the state is `ok`: there is nothing to edit
   * while loading or errored.
   */
  setData: (update: T | ((prev: T) => T)) => void;
}

/**
 * Run `fn` on mount and whenever `deps` change, tracking it as one
 * loading/ok/error state.
 *
 * `fn` is NOT a dependency — pass an inline closure freely; `deps` alone
 * decides when a refetch happens, exactly like the `useEffect` it replaces.
 *
 * Pass `null` for `fn` when there is nothing to fetch yet (a closed modal, an
 * unselected row) — the state rests at `loading` and no request goes out. Put
 * whatever decides that in `deps`, so becoming ready triggers the fetch.
 */
export function useAsync<T>(fn: (() => Promise<T>) | null, deps: unknown[]): Async<T> {
  const [state, setState] = useState<AsyncState<T>>({ kind: "loading" });

  // Declared BEFORE the fetch effect so it has already committed the current
  // render's closure by the time that effect (or a later reload) reads it.
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  // Each request remembers the seq it was issued under and only applies while
  // it is still the newest. The cleanup bump is what makes both unmount and a
  // dep change safe: a response from a stale dep set can never land, even
  // though the promise itself keeps running.
  const seq = useRef(0);
  const run = useCallback((resetToLoading: boolean) => {
    const mine = ++seq.current;
    if (resetToLoading) {
      setState((prev) => (prev.kind === "loading" ? prev : { kind: "loading" }));
    }
    const call = fnRef.current;
    if (call === null) return;
    call().then(
      (data) => {
        if (mine === seq.current) setState({ kind: "ok", data });
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        setState({
          kind: "error",
          error: e instanceof Error ? e : new Error(String(e)),
        });
      },
    );
  }, []);

  useEffect(() => {
    // KEPT, with the reset it names: this hook IS the fetch seam every call
    // site delegates to, and `loading` has to be true from the moment the
    // request goes out — a request in flight while the state still reads `ok`
    // with the PREVIOUS deps' data is the stale render the seq guard exists to
    // prevent. There is nothing to derive from: the data lives on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    run(true);
    return () => {
      // The rule's advice (copy the ref into a local first) is exactly wrong
      // here: the point of the cleanup is to bump the LIVE counter so an
      // in-flight response from the previous dep set can no longer land.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      seq.current++;
    };
    // `deps` is the caller's own dependency list, passed through by design, so
    // the rule can neither verify it nor see that `run` is stable ([] deps).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(() => run(false), [run]);

  const setData = useCallback((update: T | ((prev: T) => T)) => {
    setState((prev) =>
      prev.kind === "ok"
        ? {
            kind: "ok",
            data:
              typeof update === "function"
                ? (update as (previous: T) => T)(prev.data)
                : update,
          }
        : prev,
    );
  }, []);

  return {
    state,
    data: state.kind === "ok" ? state.data : null,
    error: state.kind === "error" ? state.error : null,
    loading: state.kind === "loading",
    reload,
    setData,
  };
}
