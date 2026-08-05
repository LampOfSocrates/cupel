import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { MantineProvider } from "@mantine/core";
import { http, HttpResponse } from "msw";
import { agenticConfig } from "../agentic.config";
import { App } from "./App";
import { server } from "./test/msw/server";
import { healthzRequests, localBaseRequests } from "./test/msw/handlers";

// P2-T17 live switch — "switch between mock/local/staging/prod live"
// (skein-phases.md:73). Design under test (App.tsx): the boot fetch is keyed
// on the active target; a switch resets me/trees → loader → full page-tree
// remount, so every store refetches against the new base. /me is always
// called (invariant, skein-phases.md:160) — including once per switch.

describe("live target switch (P2-T17)", () => {
  it("switching target refetches /me, /agenttrees, sidebar + queue + healthz against the new base", async () => {
    const user = userEvent.setup();
    render(
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/settings"]}>
          <App />
        </MemoryRouter>
      </MantineProvider>,
    );

    // Boot on mock (dev default): config banner + settings + healthz on mock.
    await screen.findByTestId("env-banner");
    expect(screen.getByTestId("env-banner")).toHaveTextContent("MOCK BACKEND");
    await waitFor(() => expect(healthzRequests).toContain("mock"));
    expect(localBaseRequests).toHaveLength(0);

    await user.click(screen.getByRole("radio", { name: "Local" }));

    // Boot refetch against the NEW base.
    await waitFor(() => expect(localBaseRequests).toContain("/me"));
    await waitFor(() => expect(localBaseRequests).toContain("/agenttrees"));
    // Remounted tree refetches there too: sidebar conversations, the
    // app-wide task stream (QueueProvider), and the settings health check.
    await waitFor(() => expect(localBaseRequests).toContain("/conversations"));
    await waitFor(() => expect(localBaseRequests).toContain("/tasks/stream"));
    await waitFor(() => expect(localBaseRequests).toContain("/healthz"));
    // Local declares no banner config → fallback rule labels the target.
    await waitFor(() =>
      expect(screen.getByTestId("env-banner")).toHaveTextContent("Local backend"),
    );
  });

  it("a dead target shows the boot error naming it, with a switch-back recovery", async () => {
    // Staging answers 503 → boot /me fails against it.
    const staging = agenticConfig.targets.find((t) => t.id === "staging")!.baseUrl;
    server.use(
      http.get(`${staging}/me`, () =>
        HttpResponse.json({ code: "unavailable", message: "backend down" }, { status: 503 }),
      ),
      http.get(`${staging}/agenttrees`, () =>
        HttpResponse.json({ code: "unavailable", message: "backend down" }, { status: 503 }),
      ),
      http.get(`${staging}/healthz`, () =>
        HttpResponse.json({ code: "unavailable", message: "backend down" }, { status: 503 }),
      ),
    );
    const user = userEvent.setup();
    render(
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/settings"]}>
          <App />
        </MemoryRouter>
      </MantineProvider>,
    );
    await screen.findByRole("radio", { name: "Staging" });

    await user.click(screen.getByRole("radio", { name: "Staging" }));
    // Boot error names the target (P2-CONFIG hint, kept by T17).
    await screen.findByText("Backend unreachable");
    expect(screen.getByText(/is the Staging backend/)).toBeInTheDocument();

    // Recovery: back to the build default (mock in dev) → app boots again.
    await user.click(screen.getByRole("button", { name: "Switch back to Mock" }));
    await screen.findByTestId("env-banner");
    expect(screen.getByTestId("env-banner")).toHaveTextContent("MOCK BACKEND");
  });
});
