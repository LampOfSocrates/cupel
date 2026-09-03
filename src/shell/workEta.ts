import type { Task } from "../api/types";

/**
 * The dock's ETA, derived — never invented.
 *
 * The contract carries no ETA field, so the only honest source is the task's
 * own rate: elapsed since started_at, divided by the fraction finished. That
 * needs BOTH a start time and at least one finished unit, and returns null
 * otherwise. A task that has done nothing yet has no rate, and a made-up
 * "about a minute" on a queue people plan around is worse than no number.
 *
 * @param now injected so the caller (and its test) controls the clock.
 */
/**
 * Above this, the estimate is not believable and is suppressed.
 *
 * The rate is averaged over the whole run, and the contract gives no
 * last-tick timestamp — so a task that ticked once and then stalled reports an
 * elapsed time that keeps growing against a `done` that does not, and the
 * arithmetic yields hundreds of hours. That is exactly what a task left
 * running in a stored snapshot looks like. The number is real; it is just not
 * information, and a queue people plan around should say "still generating…"
 * rather than "~1463h".
 */
const IMPLAUSIBLE_ETA_SECONDS = 6 * 60 * 60;

export function etaSeconds(task: Task, now: number): number | null {
  if (task.status !== "running") return null;
  const { done, total } = task.progress;
  if (!task.started_at || done <= 0 || total <= 0 || done >= total) return null;
  const elapsedMs = now - Date.parse(task.started_at);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
  const remaining = ((total - done) * elapsedMs) / done;
  const seconds = Math.round(remaining / 1000);
  return seconds > IMPLAUSIBLE_ETA_SECONDS ? null : seconds;
}

/** Compact mono ETA: "8s", "2m 40s", "1h 04m". */
export function formatEta(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${String(mins % 60).padStart(2, "0")}m`;
}

/**
 * What the dock shows in its mono column. The ETA when one is derivable,
 * otherwise the server's own stage text — which is why a just-started task
 * reads "generating…" rather than a fabricated duration.
 */
export function etaLabel(task: Task, now: number): string {
  const eta = etaSeconds(task, now);
  if (eta != null) return `~${formatEta(eta)}`;
  return task.progress.stage ?? "";
}
