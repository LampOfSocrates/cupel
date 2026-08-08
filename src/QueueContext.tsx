import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api/client";
import type { Task, TaskProgress } from "./api/types";

// P1-T08 — app-wide task visibility (feature-spec.md:105-112). One provider
// owns the single GET /tasks/stream subscription for the whole app plus the
// task map behind the queue panel and the sidebar badge:
// - "Live updates via SSE (GET /tasks/stream): status changes and progress
//   events push as they happen — no refresh. Fallback: polling GET /tasks"
//   (feature-spec.md:108).
// - "Sidebar badge: pending count; subtle spinner while anything is running"
//   (feature-spec.md:111).
//
// Reconnection choice: on stream drop, reconnect with a LINEAR backoff
// (reconnectBaseMs × consecutive-failures, capped at 5×) — drops are usually
// transient proxy/network resets, so quick early retries recover fast, and
// the cap plus the polling fallback bound the cost of a long outage. After
// `pollAfterFailures` consecutive failures the provider polls GET /tasks
// every `pollMs` (~5s, feature-spec.md:108) until a reconnect succeeds; every
// successful (re)connect does one GET /tasks reconcile (this doubles as the
// boot load) because frames emitted while disconnected are gone for good.
//
// The map holds PARENTS from GET /tasks ("Parents only ... expand via
// GET /tasks/{id}", openapi.yaml:770-771); children are lazily fetched into
// the parent's `children` on expand via GET /tasks/{id} ("Task with children
// populated", :826) — chosen over GET /tasks?parent_id= because one call
// refreshes the parent AND its children together. Chat/Runs pages keep their
// own scoped stream subscriptions from earlier tasks; folding them onto this
// provider is a possible future simplification, out of P1-T08 scope.

const ACTIVE = new Set<Task["status"]>(["queued", "running"]);

export interface QueueState {
  /** Parent tasks, newest first (GET /tasks order, openapi.yaml:769). */
  tasks: Task[];
  /** Queued + running parents (badge count, feature-spec.md:111). */
  pendingCount: number;
  /** Anything running → sidebar spinner (feature-spec.md:111). */
  running: boolean;
  /** Expand: GET /tasks/{id} → children populated (openapi.yaml:826). */
  loadChildren: (taskId: string) => Promise<void>;
  /** DELETE /tasks/{id}; optimistic cancel, cascades (openapi.yaml:836). */
  cancel: (taskId: string) => Promise<void>;
  /** POST /tasks/{id}/retry-failed (openapi.yaml:849-865). */
  retryFailed: (taskId: string) => Promise<void>;
}

export const QueueContext = createContext<QueueState | null>(null);

export function useQueue(): QueueState {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error("useQueue outside QueueProvider");
  return ctx;
}

interface Props {
  children: ReactNode;
  /** Reconnect backoff base; delay = base × failures, capped at 5×. */
  reconnectBaseMs?: number;
  /** Polling-fallback interval (feature-spec.md:108 "~5s"). */
  pollMs?: number;
  /** Consecutive stream failures before the polling fallback engages. */
  pollAfterFailures?: number;
}

export function QueueProvider({
  children,
  reconnectBaseMs = 1000,
  pollMs = 5000,
  pollAfterFailures = 2,
}: Props) {
  const [byId, setById] = useState<Record<string, Task>>({});
  // Latest map for `retryFailed` to consult (was this parent expanded?) without
  // taking `byId` as a dependency — that would rebuild the context value, and
  // so re-render every consumer, on each stream frame.
  const byIdRef = useRef(byId);
  useEffect(() => {
    byIdRef.current = byId;
  }, [byId]);

  // Merge a parent, preserving lazily-loaded children when the incoming Task
  // has none (GET /tasks and `task` frames carry parents without children).
  const upsertParent = useCallback((task: Task) => {
    setById((prev) => ({
      ...prev,
      [task.id]: { ...task, children: task.children ?? prev[task.id]?.children },
    }));
  }, []);

  const applyList = useCallback((list: Task[]) => {
    setById((prev) => {
      const next = { ...prev };
      for (const task of list) {
        next[task.id] = { ...task, children: task.children ?? prev[task.id]?.children };
      }
      return next;
    });
  }, []);

  // A `task` frame for a child (parent_id set) only matters if that parent's
  // children are loaded; otherwise the parent's own frames carry batch state.
  const upsertChild = useCallback((child: Task) => {
    setById((prev) => {
      const parent = child.parent_id != null ? prev[child.parent_id] : undefined;
      if (!parent?.children) return prev;
      const known = parent.children.some((c) => c.id === child.id);
      const nextChildren = known
        ? parent.children.map((c) => (c.id === child.id ? child : c))
        : [...parent.children, child];
      return { ...prev, [parent.id]: { ...parent, children: nextChildren } };
    });
  }, []);

  const applyProgress = useCallback((taskId: string, progress: TaskProgress) => {
    setById((prev) => {
      if (prev[taskId]) return { ...prev, [taskId]: { ...prev[taskId], progress } };
      for (const parent of Object.values(prev)) {
        if (parent.children?.some((c) => c.id === taskId)) {
          return {
            ...prev,
            [parent.id]: {
              ...parent,
              children: parent.children.map((c) => (c.id === taskId ? { ...c, progress } : c)),
            },
          };
        }
      }
      return prev;
    });
  }, []);

  // Single app-wide subscription: connect → reconcile → consume; on drop,
  // linear backoff + polling fallback (design note at the top of the file).
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const refresh = async () => {
      try {
        const list = await api.tasks();
        if (!stopped) applyList(list);
      } catch {
        // next poll tick / reconnect retries
      }
    };
    const stopPolling = () => {
      if (pollTimer != null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(finish, ms);
        function finish() {
          controller.signal.removeEventListener("abort", finish);
          clearTimeout(timer);
          resolve();
        }
        controller.signal.addEventListener("abort", finish);
      });

    void (async () => {
      let failures = 0;
      while (!stopped) {
        try {
          for await (const ev of api.taskStream({
            signal: controller.signal,
            onOpen: () => {
              failures = 0;
              stopPolling();
              void refresh(); // reconcile whatever happened while disconnected
            },
          })) {
            if (ev.event === "task") {
              if (ev.data.parent_id != null) upsertChild(ev.data);
              else upsertParent(ev.data);
            } else if (ev.event === "progress") {
              applyProgress(ev.data.task_id, ev.data.progress);
            }
            // judgment frames: consumed by run-scoped subscribers (T12b).
          }
          // server closed the stream — reconnect like a drop
        } catch {
          // connect/stream error; abort exits via the guard below
        }
        if (stopped || controller.signal.aborted) return;
        failures += 1;
        if (failures >= pollAfterFailures && pollTimer == null) {
          void refresh(); // don't wait a full interval for first data
          pollTimer = setInterval(() => void refresh(), pollMs);
        }
        await sleep(Math.min(reconnectBaseMs * failures, reconnectBaseMs * 5));
      }
    })();

    return () => {
      stopped = true;
      controller.abort();
      stopPolling();
    };
  }, [applyList, applyProgress, upsertChild, upsertParent, pollAfterFailures, pollMs, reconnectBaseMs]);

  const loadChildren = useCallback(async (taskId: string) => {
    const task = await api.task(taskId); // children populated (openapi.yaml:826)
    setById((prev) => ({ ...prev, [task.id]: { ...task, children: task.children ?? [] } }));
  }, []);

  const refreshList = useCallback(async () => {
    try {
      applyList(await api.tasks());
    } catch {
      // stream frames will re-sync
    }
  }, [applyList]);

  // "cancel (parent cancels children)" (feature-spec.md:110): optimistic flip
  // of the parent + its active children, then reconcile from the DELETE
  // response (server-side cascade, openapi.yaml:836-842) and stream frames.
  const cancel = useCallback(
    async (taskId: string) => {
      setById((prev) => {
        const task = prev[taskId];
        if (!task) return prev;
        return {
          ...prev,
          [taskId]: {
            ...task,
            status: "cancelled",
            children: task.children?.map((c) =>
              ACTIVE.has(c.status) ? { ...c, status: "cancelled" } : c,
            ),
          },
        };
      });
      try {
        upsertParent(await api.cancelTask(taskId));
      } catch {
        void refreshList(); // optimistic update may be wrong — re-sync
      }
    },
    [refreshList, upsertParent],
  );

  // "shown as partial failure with retry-failed button" (feature-spec.md:110).
  const retryFailed = useCallback(
    async (taskId: string) => {
      const parent = await api.retryFailedTask(taskId); // 202 (openapi.yaml:858)
      upsertParent(parent);
      // Children were re-enqueued server-side; refetch them if expanded.
      if (byIdRef.current[taskId]?.children) await loadChildren(taskId);
    },
    [loadChildren, upsertParent],
  );

  const tasks = useMemo(
    () =>
      Object.values(byId)
        .filter((t) => t.parent_id == null)
        .sort(
          (a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id),
        ),
    [byId],
  );
  const pendingCount = useMemo(() => tasks.filter((t) => ACTIVE.has(t.status)).length, [tasks]);
  const running = useMemo(() => tasks.some((t) => t.status === "running"), [tasks]);

  const value = useMemo(
    () => ({ tasks, pendingCount, running, loadChildren, cancel, retryFailed }),
    [tasks, pendingCount, running, loadChildren, cancel, retryFailed],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}
