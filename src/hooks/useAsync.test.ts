import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useAsync } from "./useAsync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useAsync", () => {
  it("starts loading and lands on ok", async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useAsync(() => d.promise, []));

    expect(result.current.state).toEqual({ kind: "loading" });
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await act(async () => d.resolve("hello"));

    expect(result.current.state).toEqual({ kind: "ok", data: "hello" });
    expect(result.current.data).toBe("hello");
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("lands on error and normalises a non-Error rejection", async () => {
    const d = deferred<string>();
    const { result } = renderHook(() => useAsync(() => d.promise, []));

    await act(async () => d.reject("boom"));

    expect(result.current.state.kind).toBe("error");
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("boom");
    expect(result.current.data).toBeNull();
  });

  it("preserves a thrown Error instance", async () => {
    const d = deferred<string>();
    const boom = new Error("nope");
    const { result } = renderHook(() => useAsync(() => d.promise, []));

    await act(async () => d.reject(boom));

    expect(result.current.error).toBe(boom);
  });

  it("refetches and returns to loading when deps change", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fn = vi.fn((id: number) => (id === 0 ? first.promise : second.promise));
    const { result, rerender } = renderHook(
      ({ id }) => useAsync(() => fn(id), [id]),
      { initialProps: { id: 0 } },
    );

    await act(async () => first.resolve("first"));
    expect(result.current.data).toBe("first");

    rerender({ id: 1 });
    expect(result.current.state).toEqual({ kind: "loading" });

    await act(async () => second.resolve("second"));
    expect(result.current.data).toBe("second");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("drops an in-flight response from a stale dep set", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const { result, rerender } = renderHook(
      ({ id }) => useAsync(() => (id === 0 ? slow.promise : fast.promise), [id]),
      { initialProps: { id: 0 } },
    );

    // Deps change while the first request is still open, then the NEW request
    // answers first — the classic overwrite.
    rerender({ id: 1 });
    await act(async () => fast.resolve("new"));
    expect(result.current.data).toBe("new");

    await act(async () => slow.resolve("stale"));
    expect(result.current.data).toBe("new");
  });

  it("drops a rejection from a stale dep set", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const { result, rerender } = renderHook(
      ({ id }) => useAsync(() => (id === 0 ? slow.promise : fast.promise), [id]),
      { initialProps: { id: 0 } },
    );

    rerender({ id: 1 });
    await act(async () => fast.resolve("new"));

    await act(async () => slow.reject(new Error("stale failure")));
    expect(result.current.state).toEqual({ kind: "ok", data: "new" });
  });

  it("ignores a response that arrives after unmount", async () => {
    const d = deferred<string>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = renderHook(() => useAsync(() => d.promise, []));

    unmount();
    await act(async () => d.resolve("late"));

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("reload refetches without flashing back to loading", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let call = 0;
    const { result } = renderHook(() =>
      useAsync(() => (call++ === 0 ? first.promise : second.promise), []),
    );

    await act(async () => first.resolve("v1"));

    act(() => result.current.reload());
    expect(result.current.state).toEqual({ kind: "ok", data: "v1" });

    await act(async () => second.resolve("v2"));
    await waitFor(() => expect(result.current.data).toBe("v2"));
  });

  it("reload supersedes an older in-flight request", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let call = 0;
    const { result } = renderHook(() =>
      useAsync(() => (call++ === 0 ? first.promise : second.promise), []),
    );

    act(() => result.current.reload());
    await act(async () => second.resolve("newer"));
    await act(async () => first.resolve("older"));

    expect(result.current.data).toBe("newer");
  });

  it("setData edits a loaded value and is ignored while loading", async () => {
    const d = deferred<number[]>();
    const { result } = renderHook(() => useAsync(() => d.promise, []));

    act(() => result.current.setData([9]));
    expect(result.current.state).toEqual({ kind: "loading" });

    await act(async () => d.resolve([1, 2]));
    act(() => result.current.setData((prev) => [...prev, 3]));
    expect(result.current.data).toEqual([1, 2, 3]);

    act(() => result.current.setData([7]));
    expect(result.current.data).toEqual([7]);
  });

  it("rests at loading and issues no request while fn is null", async () => {
    const fn = vi.fn(() => Promise.resolve("data"));
    const { result, rerender } = renderHook(
      ({ ready }) => useAsync(ready ? fn : null, [ready]),
      { initialProps: { ready: false } },
    );

    expect(result.current.state).toEqual({ kind: "loading" });
    expect(fn).not.toHaveBeenCalled();

    rerender({ ready: true });
    await waitFor(() => expect(result.current.data).toBe("data"));

    // Going back to not-ready drops the stale value rather than showing it.
    rerender({ ready: false });
    expect(result.current.state).toEqual({ kind: "loading" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls the latest closure, not the one from the render that set the deps", async () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ label }) =>
        useAsync(() => {
          seen.push(label);
          return Promise.resolve(label);
        }, []),
      { initialProps: { label: "a" } },
    );

    await waitFor(() => expect(result.current.data).toBe("a"));
    rerender({ label: "b" });
    await act(async () => result.current.reload());

    expect(seen).toEqual(["a", "b"]);
  });
});
