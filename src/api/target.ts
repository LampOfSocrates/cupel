// P2-CONFIG — runtime backend-target store over agentic.config.ts (the one
// config artifact). The active target is DEVICE-LOCAL (feature-spec.md:161
// "Target is device-local (not synced via /settings)") — persisted in
// localStorage, resolved from the config on every read so the config file
// stays the single source of truth for what targets exist.
import { useSyncExternalStore } from "react";
import { agenticConfig, type BackendTarget } from "../../agentic.config";

export const TARGET_STORAGE_KEY = "cupel.backend.target";

// P2-T17 — the "custom Base URL field" of feature-spec.md:158: one extra
// non-preset target whose baseUrl the user types in Settings → Backend.
// Device-local like the target choice itself (feature-spec.md:161).
export const CUSTOM_TARGET_ID = "custom";
export const CUSTOM_URL_KEY = "cupel.backend.customUrl";

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

export function getCustomUrl(): string {
  try {
    return localStorage.getItem(CUSTOM_URL_KEY) ?? "";
  } catch {
    return "";
  }
}

// Synthesized custom target. Cached so the reference is stable while the URL
// is unchanged (the useSyncExternalStore snapshot contract getActiveTarget
// documents); a URL edit invalidates the cache → new object → re-render.
let customCache: BackendTarget | null = null;
function customTarget(): BackendTarget | undefined {
  const baseUrl = getCustomUrl();
  if (!baseUrl) return undefined; // no URL entered yet — not selectable
  if (!customCache || customCache.baseUrl !== baseUrl) {
    customCache = { id: CUSTOM_TARGET_ID, label: "Custom", baseUrl };
  }
  return customCache;
}

/** Persist the custom base URL (cupel.backend.customUrl) and notify — the
 * client rebuilds URLs from getActiveTarget() on every call, so an edit while
 * the custom target is active retargets the app immediately. */
export function setCustomUrl(url: string): void {
  try {
    if (url) localStorage.setItem(CUSTOM_URL_KEY, url);
    else localStorage.removeItem(CUSTOM_URL_KEY);
  } catch {
    // storage unavailable — nothing to persist; the custom target stays
    // unavailable (mirrors llmKey.ts).
  }
  for (const listener of listeners) listener();
}

function findTarget(id: string): BackendTarget | undefined {
  return (
    agenticConfig.targets.find((t) => t.id === id) ??
    (id === CUSTOM_TARGET_ID ? customTarget() : undefined)
  );
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
