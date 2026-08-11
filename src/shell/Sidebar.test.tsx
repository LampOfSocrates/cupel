import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { renderApp, type AppStateOverrides } from "../test/render";
import { logoutRequests, mockTasks, taskStreamRig } from "../test/msw/handlers";
import { getAuthToken, setAuthToken } from "../api/auth";
import { Shell } from "./Shell";

// Contract under test — "Sidebar badge: pending count; subtle spinner while
// anything is running" (feature-spec.md:107). Pending = queued + running
// parents; fed by QueueProvider's single app-wide /tasks/stream + GET /tasks
// (openapi.yaml:747-775 "polling fallback + sidebar badge").

// Probe exposing where a nav click landed — pathname + router state.
function LocationProbe() {
  const loc = useLocation();
  return (
    <div data-testid="loc">
      {loc.pathname}|{JSON.stringify(loc.state ?? null)}
    </div>
  );
}

const renderShell = (overrides: AppStateOverrides & { route?: string } = {}) =>
  renderApp(
    <Routes>
      <Route element={<Shell />}>
        <Route path="*" element={<LocationProbe />} />
      </Route>
    </Routes>,
    { route: "/chat", queue: true, ...overrides },
  );

describe("Sidebar queue badge", () => {
  it("counts pending parents and spins while running; clears when tasks finish", async () => {
    renderShell();
    await waitFor(() => expect(taskStreamRig.clients).toBe(1));

    // Seed: one running replay parent → badge "1" + spinner.
    await waitFor(() => expect(screen.getByTestId("queue-badge")).toHaveTextContent("1"));
    expect(screen.getByLabelText("Tasks running")).toBeInTheDocument();

    // The running parent finishes → badge and spinner both clear.
    const seed = mockTasks.find((t) => t.id === "task-seed-replay")!;
    taskStreamRig.emit("task", {
      ...seed,
      children: undefined,
      status: "done",
      progress: { done: 3, total: 3 },
      finished_at: "2026-08-04T10:09:00Z",
    });
    await waitFor(() => expect(screen.queryByTestId("queue-badge")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Tasks running")).not.toBeInTheDocument();

    // A queued (not yet running) parent counts as pending, but no spinner
    // (feature-spec.md:107 separates the two signals).
    taskStreamRig.emit("task", {
      id: "task-queued-only",
      type: "replay",
      status: "queued",
      progress: { done: 0, total: 2 },
      created_at: "2026-08-04T12:00:00Z",
    });
    await waitFor(() => expect(screen.getByTestId("queue-badge")).toHaveTextContent("1"));
    expect(screen.queryByLabelText("Tasks running")).not.toBeInTheDocument();
  });
});

// Doors: Chat and Studio — flat, no sublevels (UX polish 2026-08-10):
// Evaluations, Eval workbench, and Inspector used to be a group plus a
// separate role-gated entry; they're one route with tabs now
// (StudioPage.test.tsx covers the tabs themselves). Casebooks was a third
// entry until Casebook and EvalBenchmark merged; its collections are the
// Benchmarks tab now, and /casebooks no longer exists.
describe("Sidebar Studio entry", () => {
  it("is a flat link to /studio, not a group", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.queryByRole("button", { name: "Evaluate" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Studio" }));
    expect(screen.getByTestId("loc")).toHaveTextContent("/studio|null");
    expect(screen.queryByRole("link", { name: "Casebooks" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Inspector" })).not.toBeInTheDocument();
  });
});

// Settings entry pinned below the recent list.
describe("Sidebar Settings entry", () => {
  it("routes to /settings", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("link", { name: "Settings" }));
    expect(screen.getByTestId("loc")).toHaveTextContent("/settings|null");
  });
});

// Landing / FAQ — a plain <a href="/"> back to the persona landing page
// (docs/index.html, served at the domain root; mock/root.py mounts the whole
// app at /cupel-demo alongside it), NOT a router route.
describe("Sidebar Landing / FAQ entry", () => {
  it("is a plain absolute link to the domain root, not a router link", () => {
    renderShell();
    const link = screen.getByRole("link", { name: "Landing / FAQ" });
    expect(link).toHaveAttribute("href", "/");
  });
});

// Desktop rail collapse (UX polish, planned 2026-08-10): a toggle swaps the
// 280px labeled column for a 68px icon-only rail — Shell.tsx's two navbar
// widths — rather than resurrecting the full-width mobile overlay. Every
// route stays one click away; nav is flat (no groups) since the Studio merge,
// so the rail is a plain one-icon-per-entry list.
describe("Sidebar rail collapse", () => {
  it("collapses to icon-only links, and expands back, on toggle", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.getByRole("button", { name: "+ New chat" })).toBeInTheDocument();
    expect(screen.getByTestId("app-navbar")).toHaveAttribute("data-rail-collapsed", "false");

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(screen.getByTestId("app-navbar")).toHaveAttribute("data-rail-collapsed", "true");
    // The labeled controls are gone — replaced by icon-only equivalents that
    // keep the same accessible names, so every route is still reachable.
    expect(screen.queryByRole("button", { name: "+ New chat" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Studio" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Chat" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand sidebar" }));

    expect(screen.getByTestId("app-navbar")).toHaveAttribute("data-rail-collapsed", "false");
    expect(screen.getByRole("button", { name: "+ New chat" })).toBeInTheDocument();
  });
});

// Session row — user name from /me; "Sign out" shows EXACTLY when a
// login token exists for the active target (no auth-mode branch: an off-mode
// backend issues no token, so the dev user shows without sign-out).
describe("Sidebar session row", () => {
  it("off-mode shape: dev user name, no Sign out (no token stored)", async () => {
    renderShell();
    expect(await screen.findByText("Dev User")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("with a token: Sign out posts /auth/logout best-effort, clears the token, goes to /login", async () => {
    setAuthToken("session-jwt");
    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(logoutRequests).toHaveLength(1));
    // The logout call itself carried the bearer (still held when fired).
    expect(logoutRequests[0]).toBe("Bearer session-jwt");
    expect(getAuthToken()).toBeNull();
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/login"));
    // Token gone → the affordance disappears (token presence is the signal).
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
});

// Tree switcher (built on request, alongside the EvalSet->EvalBenchmark
// rename session) — AppContext.tree used to be a fixed boot-time value with
// no setter; this is the first UI that lets it change. AgentTree.enabled
// (openapi.yaml) gates selectability: "false is only ever seen by admins ...
// render greyed with a disabled badge".
describe("Sidebar tree switcher", () => {
  it("lists every tree and switches: setTree fires, then a landing-route navigation", async () => {
    const setTree = vi.fn();
    const user = userEvent.setup();
    renderShell({ route: "/agents", setTree });

    await user.click(screen.getByRole("combobox", { name: "Tree" }));
    await user.click(await screen.findByRole("option", { name: "Agent 2" }));

    expect(setTree).toHaveBeenCalledWith("agent2");
    // Every tree-scoped id in the old URL belonged to the OLD tree, so a
    // switch always lands on the landing route rather than trying to carry
    // the current page across trees.
    expect(screen.getByTestId("loc")).toHaveTextContent("/chat|null");
  });

  it("re-picking the already-active tree is a no-op — no setTree, no navigation", async () => {
    const setTree = vi.fn();
    const user = userEvent.setup();
    renderShell({ route: "/agents", setTree });

    await user.click(screen.getByRole("combobox", { name: "Tree" }));
    await user.click(await screen.findByRole("option", { name: "Agent 1" }));

    expect(setTree).not.toHaveBeenCalled();
    expect(screen.getByTestId("loc")).toHaveTextContent("/agents|null");
  });

  it("a disabled tree is listed but not selectable", async () => {
    const setTree = vi.fn();
    const user = userEvent.setup();
    renderShell({
      setTree,
      trees: [
        { id: "agent1", name: "Agent 1", enabled: true },
        { id: "agent2", name: "Agent 2", enabled: false },
      ],
    });

    await user.click(screen.getByRole("combobox", { name: "Tree" }));
    const disabledOption = await screen.findByRole("option", { name: "Agent 2 (disabled)" });
    expect(disabledOption).toHaveAttribute("data-combobox-disabled", "true");
    await user.click(disabledOption);

    expect(setTree).not.toHaveBeenCalled();
  });

  it("hides the switcher when there is only one tree to switch to", () => {
    renderShell({ trees: [{ id: "agent1", name: "Agent 1", enabled: true }] });
    expect(screen.queryByRole("combobox", { name: "Tree" })).not.toBeInTheDocument();
  });

  it("hides the switcher on the collapsed rail — no room, same as Recent", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.queryByRole("combobox", { name: "Tree" })).not.toBeInTheDocument();
  });
});
