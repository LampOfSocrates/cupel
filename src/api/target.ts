// P2-CONFIG — runtime backend-target store over agentic.config.ts (the one
// config artifact). The active target is DEVICE-LOCAL (feature-spec.md:161
// "Target is device-local (not synced via /settings)") — persisted in
// localStorage, resolved from the config on every read so the config file
// stays the single source of truth for what targets exist.
import { useSyncExternalStore } from "react";
import { agenticConfig, type BackendTarget } from "../../agentic.config";

export const TARGET_STORAGE_KEY = "skein.backend.target";

/**
 * Default target id per build kind (agentic.config.ts defaultTarget):
 * dev server / vitest → mock; `vite build` bundles → prod (same-origin,
 * preserving the P1-TDEPLOY semantic that base.ts carried).
 * `isProd` is injectable ONLY so tests can exercise both sides —
 * import.meta.env.PROD is statically replaced at build time, so the
 * production branch is unreachable in vitest without the parameter.
 */
export function resolveDefaultTargetId(isProd: boolean = import.meta.env.PROD): string {
  return isProd ? agenticConfig.defaultTarget.production : agenticConfig.defaultTarget.dev;
}

function findTarget(id: string): BackendTarget | undefined {
  return agenticConfig.targets.find((t) => t.id === id);
}

// try/catch mirrors llmKey.ts: localStorage can throw (privacy mode) — the
// store then just always resolves the default.
function storedId(): string | null {
  try {
    return localStorage.getItem(TARGET_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The resolved active target — {baseUrl, remap, …} consumed by the client for
 * every URL it builds. A stored id that no longer exists in the config falls
 * back to the default. Returns the config's own object (stable reference
 * while the id is unchanged — the useSyncExternalStore snapshot contract).
 */
export function getActiveTarget(): BackendTarget {
  const id = storedId();
  return (id ? findTarget(id) : undefined) ?? findTarget(resolveDefaultTargetId())!;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Persist a new active target and notify subscribers (future T17 switcher). */
export function setActiveTarget(id: string): void {
  if (!findTarget(id)) throw new Error(`Unknown backend target: ${id}`);
  try {
    localStorage.setItem(TARGET_STORAGE_KEY, id);
  } catch {
    // storage unavailable — the change still notifies but won't survive reload
  }
  for (const listener of listeners) listener();
}

export function subscribeTarget(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React view of the active target — re-renders on setActiveTarget. */
export function useBackendTarget(): BackendTarget {
  return useSyncExternalStore(subscribeTarget, getActiveTarget);
}
