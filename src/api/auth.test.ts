import { describe, expect, it, vi } from "vitest";
import {
  AUTH_TOKEN_PREFIX,
  authHeaders,
  clearAuthToken,
  emitAuthRequired,
  getAuthToken,
  onAuthRequired,
  setAuthToken,
  subscribeAuthToken,
} from "./auth";
import { setActiveTarget } from "./target";
import { setProdToken } from "./backendPrefs";

// Token store — one login token PER BACKEND TARGET
// (cupel.auth.token.<targetId>), device-local like the target choice
// (feature-spec.md:157). localStorage is cleared between tests by setup.ts.

describe("auth token store", () => {
  it("stores per target id and defaults to the active target (mock in dev)", () => {
    setAuthToken("jwt-mock"); // active target: dev default = mock
    setAuthToken("jwt-staging", "staging");
    expect(localStorage.getItem(`${AUTH_TOKEN_PREFIX}mock`)).toBe("jwt-mock");
    expect(getAuthToken()).toBe("jwt-mock");
    expect(getAuthToken("staging")).toBe("jwt-staging");

    clearAuthToken(); // clears the ACTIVE target only
    expect(getAuthToken()).toBeNull();
    expect(getAuthToken("staging")).toBe("jwt-staging");
  });

  it("notifies subscribers on set and clear", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAuthToken(listener);
    setAuthToken("t1");
    clearAuthToken();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setAuthToken("t2");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("authHeaders precedence (documented in auth.ts)", () => {
  it("no token anywhere → no Authorization header", () => {
    expect(authHeaders()).toEqual({});
  });

  it("login JWT for the active target attaches as Bearer", () => {
    setAuthToken("login-jwt");
    expect(authHeaders()).toEqual({ Authorization: "Bearer login-jwt" });
  });

  it("static prod token (T17) attaches ONLY on requiresToken targets", () => {
    setProdToken("static-tok");
    // mock target declares no requiresToken → static token never attaches.
    expect(authHeaders()).toEqual({});
    // prod declares requiresToken (agentic.config.ts) → it attaches.
    setActiveTarget("prod");
    expect(authHeaders()).toEqual({ Authorization: "Bearer static-tok" });
  });

  it("login JWT wins over the static prod token", () => {
    setActiveTarget("prod");
    setProdToken("static-tok");
    setAuthToken("login-jwt"); // stored for the active (prod) target
    expect(authHeaders()).toEqual({ Authorization: "Bearer login-jwt" });
    clearAuthToken();
    expect(authHeaders()).toEqual({ Authorization: "Bearer static-tok" });
  });
});

describe("auth-required event", () => {
  it("emit reaches subscribers until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = onAuthRequired(listener);
    emitAuthRequired();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    emitAuthRequired();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
