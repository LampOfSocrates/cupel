import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { renderApp } from "../test/render";
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

const renderShell = () =>
  renderApp(
    <Routes>
      <Route element={<Shell />}>
        <Route path="*" element={<LocationProbe />} />
      </Route>
    </Routes>,
    { route: "/chat", queue: true },
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

// Two doors: Chat and Evaluate. Runs / Eval / Casebooks are one workflow, so
// they nest under the Evaluate group rather than sitting as three peers —
// their routes are unchanged and the group is open by default.
describe("Sidebar Evaluate group", () => {
  it("nests Runs, Eval and Casebooks under Evaluate, each at its own route", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.getByRole("button", { name: "Evaluate" })).toBeInTheDocument();
    for (const [label, path] of [
      ["Evaluations", "/evaluations"],
      ["Eval", "/eval"],
      ["Casebooks", "/casebooks"],
    ]) {
      await user.click(screen.getByRole("link", { name: label }));
      expect(screen.getByTestId("loc")).toHaveTextContent(`${path}|null`);
    }
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

// Session row — user name from /me; "Sign out" shows EXACTLY when a
// login token exists for the active target (no auth-mode branch: an off-mode
// backend issues no token, so the dev user shows without sign-out).
describe("Sidebar session row (P2-T07)", () => {
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
