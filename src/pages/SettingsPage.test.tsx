import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { agenticConfig } from "../../agentic.config";
import {
  CUSTOM_URL_KEY,
  TARGET_STORAGE_KEY,
  getActiveTarget,
} from "../api/target";
import { PROD_TOKEN_KEY, SSE_STORAGE_KEY, getSseEnabled } from "../api/backendPrefs";
import { renderApp } from "../test/render";
import { server } from "../test/msw/server";
import {
  LOCAL_BASE,
  healthConfig,
  healthzRequests,
  localBaseRequests,
} from "../test/msw/handlers";
import { SettingsPage } from "./SettingsPage";

// Contract under test — Settings → Backend, sketch 09 (feature-spec.md:
// 157-161): ":158 Target switcher: Mock / Local / Staging / Prod presets +
// custom Base URL field"; ":159 Health check: GET {base}/healthz on select —
// shows status, latency, server version, and (for mock) the loaded seed"
// (latency client-measured, openapi.yaml:88); ":160 Mock options (visible
// when target = Mock)"; ":161 Target is device-local …; Prod requires an
// auth token field".

function renderSettings() {
  return renderApp(
    <Routes>
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>,
    { route: "/settings" },
  );
}

describe("target switcher", () => {
  it("renders every config preset plus Custom; the active target (mock) is selected", async () => {
    renderSettings();
    for (const t of agenticConfig.targets) {
      expect(screen.getByRole("radio", { name: t.label })).toBeInTheDocument();
    }
    expect(screen.getByRole("radio", { name: "Custom" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Mock" })).toBeChecked();
    // Base URL field shows the active preset's URL (read-only for presets).
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue(
      agenticConfig.targets.find((t) => t.id === "mock")!.baseUrl,
    );
  });

  it("checks health on mount: status, client-measured latency, version, and the mock seed", async () => {
    renderSettings();
    const result = await screen.findByTestId("health-result");
    expect(result).toHaveTextContent(/ok · \d+ms · v0\.2\.0 · seed demo-agent1/);
    expect(healthzRequests).toEqual(["mock"]);
  });

  it("select → setActiveTarget persists device-locally and healthz runs against the NEW base", async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByTestId("health-result"); // initial mock check done

    await user.click(screen.getByRole("radio", { name: "Local" }));
    expect(localStorage.getItem(TARGET_STORAGE_KEY)).toBe("local");
    await waitFor(() => expect(localBaseRequests).toContain("/healthz"));
    // Local health has no seed → no seed segment rendered.
    await waitFor(() =>
      expect(screen.getByTestId("health-result")).toHaveTextContent(/ok · \d+ms · v0\.9-local$/),
    );
    // Mock options are gone off-mock (feature-spec.md:156 "visible when
    // target = Mock").
    expect(screen.queryByText("Mock options")).not.toBeInTheDocument();
  });

  it("failed healthz shows the fail state; Re-check retries", async () => {
    healthConfig.status = 503;
    const user = userEvent.setup();
    renderSettings();
    await waitFor(() =>
      expect(screen.getByTestId("health-result")).toHaveTextContent(/fail · \d+ms · backend down/),
    );

    healthConfig.status = 200;
    await user.click(screen.getByRole("button", { name: "Re-check" }));
    await waitFor(() =>
      expect(screen.getByTestId("health-result")).toHaveTextContent(/ok · \d+ms · v0\.2\.0/),
    );
    expect(healthzRequests.length).toBe(2);
  });
});

describe("custom target (feature-spec.md:154 'custom Base URL field')", () => {
  it("Custom without a URL stays pending; committing a URL persists it and switches", async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByTestId("health-result");

    await user.click(screen.getByRole("radio", { name: "Custom" }));
    // No URL yet — no switch, prompt instead of a health probe.
    expect(localStorage.getItem(TARGET_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId("health-result")).toHaveTextContent("enter a base URL");

    const url = screen.getByRole("textbox", { name: "Base URL" });
    await user.type(url, `${LOCAL_BASE}{Enter}`);
    expect(localStorage.getItem(CUSTOM_URL_KEY)).toBe(LOCAL_BASE);
    expect(localStorage.getItem(TARGET_STORAGE_KEY)).toBe("custom");
    expect(getActiveTarget()).toMatchObject({ id: "custom", baseUrl: LOCAL_BASE });
    // Health check ran against the custom base.
    await waitFor(() => expect(localBaseRequests).toContain("/healthz"));
    await waitFor(() =>
      expect(screen.getByTestId("health-result")).toHaveTextContent("v0.9-local"),
    );
  });

  it("a stored custom target is selected and editable on revisit", async () => {
    localStorage.setItem(CUSTOM_URL_KEY, LOCAL_BASE);
    localStorage.setItem(TARGET_STORAGE_KEY, "custom");
    renderSettings();
    expect(screen.getByRole("radio", { name: "Custom" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue(LOCAL_BASE);
    expect(screen.getByRole("textbox", { name: "Base URL" })).not.toHaveAttribute("readonly");
    // Mounting against the custom target fires a health check at LOCAL_BASE.
    // The assertions above are synchronous, so without this the test finishes
    // first and the handler's `healthzRequests.push("local")` lands AFTER
    // afterEach cleared the array — i.e. inside whichever test runs next,
    // which then sees a request it never made. Own the request you started.
    await waitFor(() => expect(healthzRequests).toContain("local"));
  });
});

describe("prod auth token (feature-spec.md:157)", () => {
  it("selecting Prod shows a masked token field stored device-locally", async () => {
    // Prod is same-origin (baseUrl "") — answer its healthz so the on-select
    // check resolves.
    server.use(
      http.get(`${globalThis.location.origin}/healthz`, () =>
        HttpResponse.json({ status: "ok", version: "1.0", seed: null }),
      ),
    );
    const user = userEvent.setup();
    renderSettings();
    await screen.findByTestId("health-result");

    expect(screen.queryByLabelText("Auth token")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Prod" }));

    const token = await screen.findByLabelText("Auth token");
    expect(token).toHaveAttribute("type", "password"); // masked
    await user.type(token, "sekrit-token");
    expect(localStorage.getItem(PROD_TOKEN_KEY)).toBe("sekrit-token");
    // The field now documents that it IS sent as a Bearer token,
    // with the signed-in session's JWT taking precedence (auth.ts).
    expect(
      screen.getByText(/sent as a Bearer token on this target/),
    ).toBeInTheDocument();
  });
});

describe("mock options (feature-spec.md:156)", () => {
  it("SSE streaming toggle is real: flips the device-local flag both ways", async () => {
    const user = userEvent.setup();
    renderSettings();
    const sse = screen.getByRole("switch", { name: "SSE streaming" });
    expect(sse).toBeChecked(); // default on
    expect(getSseEnabled()).toBe(true);

    await user.click(sse);
    expect(getSseEnabled()).toBe(false);
    expect(localStorage.getItem(SSE_STORAGE_KEY)).toBe("off");

    await user.click(sse);
    expect(getSseEnabled()).toBe(true);
    expect(localStorage.getItem(SSE_STORAGE_KEY)).toBeNull();
  });

  it("latency / failure % / seed picker render disabled with the P2-GEN tooltip", async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(screen.getByRole("switch", { name: "Simulate latency" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Random task failures (5%)" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Seed dataset/ })).toBeDisabled();

    await user.hover(screen.getByText("Simulate latency"));
    await screen.findByText("Arrives with generator controls (P2-GEN)");
  });
});
