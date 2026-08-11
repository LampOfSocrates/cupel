import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { api } from "./client";
import { getAuthToken, onAuthRequired, setAuthToken } from "./auth";
import { setProdToken } from "./backendPrefs";
import { setActiveTarget } from "./target";
import { server } from "../test/msw/server";
import { BASE, mockMe } from "../test/msw/handlers";

// The SINGLE client attaches auth centrally ("token attached by the
// single API client", feature-spec.md:18) and handles every 401 centrally
// ("401 anywhere → back to login"). No caller passes tokens; no component
// branches on the auth mode.

const captureAuthHeader = (base: string, captured: Array<string | null>) =>
  http.get(`${base}/me`, ({ request }) => {
    captured.push(request.headers.get("authorization"));
    return HttpResponse.json(mockMe);
  });

describe("bearer attach", () => {
  it("attaches Authorization: Bearer <login token> when one is stored", async () => {
    const captured: Array<string | null> = [];
    server.use(captureAuthHeader(BASE, captured));

    await api.me(); // no token yet → no header
    setAuthToken("login-jwt");
    await api.me();
    expect(captured).toEqual([null, "Bearer login-jwt"]);
  });

  it("attaches the static prod token (T17) on requiresToken targets; the login JWT wins", async () => {
    // prod's baseUrl is "" (same-origin) — in jsdom that resolves to the
    // page origin — and its remap prefixes every path with /cupel-demo (the
    // hosted demo is mounted there, agentic.config.ts, mock/root.py).
    setActiveTarget("prod");
    const captured: Array<string | null> = [];
    server.use(captureAuthHeader(`${window.location.origin}/cupel-demo`, captured));

    setProdToken("static-tok");
    await api.me();
    // Login JWT for the prod target takes precedence (auth.ts contract).
    setAuthToken("login-jwt", "prod");
    await api.me();
    expect(captured).toEqual(["Bearer static-tok", "Bearer login-jwt"]);
  });
});

describe("central 401 handling", () => {
  it("any 401 clears the active target's token and emits auth-required", async () => {
    server.use(
      http.get(`${BASE}/me`, () =>
        HttpResponse.json(
          { code: "unauthorized", message: "Missing, invalid or expired bearer token." },
          { status: 401 },
        ),
      ),
    );
    setAuthToken("expired-jwt");
    const authRequired = vi.fn();
    const unsubscribe = onAuthRequired(authRequired);

    await expect(api.me()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(getAuthToken()).toBeNull();
    expect(authRequired).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("a 401 from POST /auth/token (bad credentials) is the form's error — no clear, no redirect", async () => {
    setAuthToken("existing-jwt");
    const authRequired = vi.fn();
    const unsubscribe = onAuthRequired(authRequired);

    await expect(api.login("admin@demo", "wrong")).rejects.toMatchObject({
      status: 401,
      code: "invalid_credentials",
    });
    expect(getAuthToken()).toBe("existing-jwt");
    expect(authRequired).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("logout posts to /auth/logout and resolves on 204", async () => {
    setAuthToken("jwt");
    await expect(api.logout()).resolves.toBeUndefined();
  });
});
