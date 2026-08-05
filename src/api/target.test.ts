import { describe, expect, it, vi } from "vitest";
import { agenticConfig } from "../../agentic.config";
import {
  TARGET_STORAGE_KEY,
  getActiveTarget,
  resolveDefaultTargetId,
  setActiveTarget,
  subscribeTarget,
} from "./target";

// P2-CONFIG — the runtime store over agentic.config.ts. localStorage is
// cleared between tests by src/test/setup.ts, so each test starts unpersisted.

describe("default target resolution", () => {
  // import.meta.env.PROD is statically replaced at `vite build` time — in
  // vitest it is always false, so the production branch is exercised via the
  // injectable isProd parameter (see resolveDefaultTargetId doc comment).
  it("dev builds default to mock, production builds to prod (agentic.config.ts defaultTarget)", () => {
    expect(resolveDefaultTargetId(false)).toBe("mock");
    expect(resolveDefaultTargetId(true)).toBe("prod");
  });

  it("prod target baseUrl is '' = same-origin (P1-TDEPLOY semantic preserved)", () => {
    const prod = agenticConfig.targets.find((t) => t.id === "prod")!;
    expect(prod.baseUrl).toBe("");
    expect(prod.requiresToken).toBe(true);
  });

  it("vitest runs are dev builds — the active target is the config's mock entry", () => {
    // Reference equality with the config object: the store resolves, never
    // copies. (The literal host lives ONLY in agentic.config.ts — asserting
    // it here would trip tests/no-hardcoded-hosts.test.js.)
    expect(getActiveTarget()).toBe(agenticConfig.targets.find((t) => t.id === "mock"));
  });

  it("returns a stable reference while unchanged (useSyncExternalStore snapshot contract)", () => {
    expect(getActiveTarget()).toBe(getActiveTarget());
  });
});

describe("device-local persistence (feature-spec.md:161)", () => {
  it("setActiveTarget persists to localStorage and getActiveTarget resolves it", () => {
    setActiveTarget("local");
    expect(localStorage.getItem(TARGET_STORAGE_KEY)).toBe("local");
    expect(getActiveTarget()).toBe(agenticConfig.targets.find((t) => t.id === "local"));
  });

  it("a stored id no longer in the config falls back to the default target", () => {
    localStorage.setItem(TARGET_STORAGE_KEY, "deleted-target");
    expect(getActiveTarget().id).toBe("mock");
  });

  it("rejects unknown target ids", () => {
    expect(() => setActiveTarget("nope")).toThrow(/Unknown backend target/);
  });
});

describe("change notification (consumed by the T17 switcher + EnvBanner)", () => {
  it("notifies subscribers on change; unsubscribe stops notifications", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTarget(listener);
    setActiveTarget("staging");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setActiveTarget("mock");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
