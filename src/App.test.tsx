import { describe, expect, it } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { MantineProvider } from "@mantine/core";
import { http, HttpResponse } from "msw";
import { agenticConfig } from "../agentic.config";
import { App } from "./App";
import { emitAuthRequired } from "./api/auth";
import { server } from "./test/msw/server";
import {
  healthzRequests,
  localBaseRequests,
  mockAdminMe,
  mockTrees,
} from "./test/msw/handlers";

// Live switch — "switch between mock/local/staging/prod live".
// Design under test (App.tsx): the boot fetch is keyed
// on the active target; a switch resets me/trees → loader → full page-tree
// remount, so every store refetches against the new base. /me is always
// called (invariant) — including once per switch.

describe("live target switch", () => {
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
    // Boot error names the target.
    await screen.findByText("Backend unreachable");
    expect(screen.getByText(/is the Staging backend/)).toBeInTheDocument();

    // Recovery: back to the build default (mock in dev) → app boots again.
    await user.click(screen.getByRole("button", { name: "Switch back to Mock" }));
    await screen.findByTestId("env-banner");
    expect(screen.getByTestId("env-banner")).toHaveTextContent("MOCK BACKEND");
  });
});

// Boot flow: "/me is always called" stays the boot (invariant);
// an auth-on backend answers 401 → the LOGIN SCREEN
// renders instead of the error screen, the deep link rides along as
// return_to, and a successful login re-runs the boot with the token. Against
// an off-mode backend (the deployed demo) none of this fires — /me succeeds
// and the app boots straight in, zero UI change (all other App tests).
describe("boot auth", () => {
  const BASE = agenticConfig.targets.find((t) => t.id === "mock")!.baseUrl;
  const unauthorized = () =>
    HttpResponse.json(
      { code: "unauthorized", message: "Missing, invalid or expired bearer token." },
      { status: 401 },
    );

  it("boot 401 → login screen; login → boots at the preserved deep link with a session row", async () => {
    // Auth-on shape: /me and /agenttrees 401 without a bearer, answer with it.
    server.use(
      http.get(`${BASE}/me`, ({ request }) =>
        request.headers.get("authorization")
          ? HttpResponse.json(mockAdminMe)
          : unauthorized(),
      ),
      http.get(`${BASE}/agenttrees`, ({ request }) =>
        request.headers.get("authorization")
          ? HttpResponse.json(mockTrees)
          : unauthorized(),
      ),
    );

    const user = userEvent.setup();
    render(
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/chat/c1?turn=t2"]}>
          <App />
        </MemoryRouter>
      </MantineProvider>,
    );

    // Login screen, not the "Backend unreachable" error screen.
    await screen.findByText("Sign in to continue");
    expect(screen.queryByText("Backend unreachable")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText(/Email/), "admin@demo");
    await user.type(screen.getByLabelText(/^Password/), "demo");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // Booted with the token: shell renders, session row shows the /me user
    // with Sign out (a token exists for the active target).
    await screen.findByRole("button", { name: "+ New chat" });
    expect(await screen.findByText("Admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    // The deep link survived the round-trip: ChatPage loaded conversation c1.
    await screen.findByTestId("transcript");
  });

  it("mid-session 401 → /login carrying WHERE THE USER NOW IS as return_to", async () => {
    const user = userEvent.setup();
    render(
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/evaluations"]}>
          <App />
          <LocationProbe />
        </MemoryRouter>
      </MantineProvider>,
    );
    // Booted, then navigated AWAY from the entry route — return_to must follow
    // the user, not the location the listener was first subscribed at.
    await screen.findByRole("button", { name: "+ New chat" });
    await user.click(screen.getByRole("link", { name: "Queue" }));
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/queue"));

    // The session expires: every call 401s from here. No token was stored to
    // clear (off-mode boot), so the signal alone must re-run the boot check —
    // otherwise the stale booted tree would stay up.
    server.use(
      http.get(`${BASE}/me`, () => unauthorized()),
      http.get(`${BASE}/agenttrees`, () => unauthorized()),
    );
    act(() => emitAuthRequired());

    await screen.findByText("Sign in to continue");
    expect(screen.getByTestId("loc")).toHaveTextContent("/login?return_to=%2Fqueue");
  });
});

// Legacy /runs deep links (#2). The pages moved to /evaluations, but links
// shared before the rename are in the wild, so /runs and /runs/{id} redirect
// rather than 404. The redirect is a plain route, so it fires in BOTH auth
// modes: off-mode straight through; auth-on after the login bounce replays
// return_to — which still carries the OLD path — through the same route.
describe("legacy /runs deep links (#2)", () => {
  const BASE = agenticConfig.targets.find((t) => t.id === "mock")!.baseUrl;

  it("off-mode: a bookmarked /runs/{id} lands on /studio/evaluations/{id}", async () => {
    render(
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/runs/evaluation-old-1"]}>
          <App />
          <LocationProbe />
        </MemoryRouter>
      </MantineProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/studio/evaluations/evaluation-old-1"),
    );
    // Not a 404 shell: the detail page for that evaluation actually rendered —
    // and the Studio tab strip is around it, which is the point of the move.
    await screen.findByText("Evaluation evaluation-old-1");
    expect(screen.getByRole("tab", { name: "Cases" })).toBeInTheDocument();
  });

  it("the bare /runs redirects and keeps the query", async () => {
    render(
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/runs?from=share"]}>
          <App />
          <LocationProbe />
        </MemoryRouter>
      </MantineProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/studio/evaluations?from=share"),
    );
  });

  // `?tab=` was the middle generation of Studio link, and `results` is the tab
  // that got renamed — it named both the tab and the flow's third step.
  it("a legacy ?tab=results deep link lands on the Evaluations tab, query intact", async () => {
    render(
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/studio?tab=results&from=share"]}>
          <App />
          <LocationProbe />
        </MemoryRouter>
      </MantineProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/studio/evaluations?from=share"),
    );
    await screen.findByRole("heading", { name: "Evaluations" });
  });

  it("auth-on: /runs/{id} → login carrying it as return_to → /evaluations/{id}", async () => {
    const unauthorized = () =>
      HttpResponse.json(
        { code: "unauthorized", message: "Missing, invalid or expired bearer token." },
        { status: 401 },
      );
    server.use(
      http.get(`${BASE}/me`, ({ request }) =>
        request.headers.get("authorization") ? HttpResponse.json(mockAdminMe) : unauthorized(),
      ),
      http.get(`${BASE}/agenttrees`, ({ request }) =>
        request.headers.get("authorization") ? HttpResponse.json(mockTrees) : unauthorized(),
      ),
    );
    const user = userEvent.setup();
    render(
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/runs/evaluation-old-1"]}>
          <App />
          <LocationProbe />
        </MemoryRouter>
      </MantineProvider>,
    );

    await screen.findByText("Sign in to continue");
    // The OLD path is what gets carried — sanitizeReturnTo is not a route
    // allowlist, so nothing rewrites it before the round-trip.
    expect(screen.getByTestId("loc")).toHaveTextContent("/login?return_to=%2Fruns%2Fevaluation-old-1");

    await user.type(screen.getByLabelText(/Email/), "admin@demo");
    await user.type(screen.getByLabelText(/^Password/), "demo");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    // Bounced to /runs/evaluation-old-1, then the redirect route takes it home.
    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/evaluations/evaluation-old-1"),
    );
    await screen.findByText("Evaluation evaluation-old-1");
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}
