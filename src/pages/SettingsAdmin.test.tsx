import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import type { Me } from "../api/types";
import { renderApp } from "../test/render";
import { server } from "../test/msw/server";
import {
  BASE,
  adminUserUpserts,
  mockAdminMe,
  permissionPuts,
  treeTogglePatches,
} from "../test/msw/handlers";
import { SettingsPage } from "./SettingsPage";

// Contract under test — Settings → Members + Settings → Agent trees
// (feature-spec.md:19-20) — a per-tree view/tune/evaluate
// matrix, and disable a whole tree (new work blocked, history kept
// read-only):
// - GET /admin/users (openapi.yaml:169-189) + GET /admin/users/{id}/permissions
//   (:220-240) fill the matrix; a checkbox PUTs the FULL matrix (:241-265
//   "Full replacement").
// - PUT /admin/users (:190-218) is "invite by email" — a new email creates an
//   invited user.
// - PATCH /admin/agenttrees/{id} {enabled} (:267-296) toggles a tree.
// Visibility is ROLE-driven: "Admin UI (visible when /me grants admin)"
// (feature-spec.md:19) — the sections key off /me.roles, never off how the
// backend authenticates.

function renderSettings(me?: Me) {
  return renderApp(
    <Routes>
      <Route path="/settings" element={<SettingsPage />} />
    </Routes>,
    { route: "/settings", me },
  );
}

describe("admin sections are role-gated", () => {
  it("hides Members and Agent trees when /me carries no admin role", async () => {
    renderSettings(); // default fixture /me: no roles at all
    // Backend section still renders — this is the same page for everyone.
    await screen.findByTestId("health-result");
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent trees")).not.toBeInTheDocument();
  });

  it("hides them for a signed-in user whose roles omit admin", async () => {
    renderSettings({
      user: { id: "u_restricted", name: "Restricted", email: "restricted@demo" },
      roles: ["inspect"], // inspect gates the Inspector, not admin UI
      permissions: { agent1: ["view", "evaluate"] },
    });
    await screen.findByTestId("health-result");
    expect(screen.queryByText("Members")).not.toBeInTheDocument();
    expect(screen.queryByText("Agent trees")).not.toBeInTheDocument();
  });

  it("shows both when /me grants admin", async () => {
    renderSettings(mockAdminMe);
    expect(await screen.findByText("Members")).toBeInTheDocument();
    expect(screen.getByText("Agent trees")).toBeInTheDocument();
  });
});

describe("Members permission matrix", () => {
  it("renders a user row per member with a view/tune/evaluate checkbox per tree, checked from GET permissions", async () => {
    renderSettings(mockAdminMe);
    await screen.findByText("admin@demo");
    expect(screen.getByText("restricted@demo")).toBeInTheDocument();

    // u_restricted's stored matrix is {agent1: [view, evaluate]} — agent1
    // view/evaluate checked, agent1 tune and all of agent2 unchecked.
    await waitFor(() =>
      expect(screen.getByLabelText("restricted@demo agent1 view")).toBeChecked(),
    );
    expect(screen.getByLabelText("restricted@demo agent1 evaluate")).toBeChecked();
    expect(screen.getByLabelText("restricted@demo agent1 tune")).not.toBeChecked();
    for (const perm of ["view", "tune", "evaluate"]) {
      expect(screen.getByLabelText(`restricted@demo agent2 ${perm}`)).not.toBeChecked();
    }
    // The admin's own row is full-rights on both trees.
    expect(screen.getByLabelText("admin@demo agent2 tune")).toBeChecked();
  });

  it("granting a right PUTs the full replacement matrix for that user only", async () => {
    const user = userEvent.setup();
    renderSettings(mockAdminMe);
    await waitFor(() =>
      expect(screen.getByLabelText("restricted@demo agent1 view")).toBeChecked(),
    );

    await user.click(screen.getByLabelText("restricted@demo agent2 view"));

    await waitFor(() => expect(permissionPuts).toHaveLength(1));
    expect(permissionPuts[0]).toEqual({
      userId: "u_restricted",
      // Full replacement (openapi.yaml:246): the untouched agent1 row travels
      // too, and the new grant is appended in contract-enum order.
      permissions: { agent1: ["view", "evaluate"], agent2: ["view"] },
    });
    expect(screen.getByLabelText("restricted@demo agent2 view")).toBeChecked();
  });

  it("revoking a right sends the matrix without it", async () => {
    const user = userEvent.setup();
    renderSettings(mockAdminMe);
    await waitFor(() =>
      expect(screen.getByLabelText("restricted@demo agent1 view")).toBeChecked(),
    );

    await user.click(screen.getByLabelText("restricted@demo agent1 view"));

    await waitFor(() => expect(permissionPuts).toHaveLength(1));
    expect(permissionPuts[0].permissions).toEqual({ agent1: ["evaluate"] });
    expect(screen.getByLabelText("restricted@demo agent1 view")).not.toBeChecked();
  });

  it("a failed PUT reverts the optimistic checkbox and surfaces the error", async () => {
    server.use(
      http.put(`${BASE}/admin/users/:userId/permissions`, () =>
        HttpResponse.json(
          { code: "forbidden", message: "The admin role is required." },
          { status: 403 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderSettings(mockAdminMe);
    await waitFor(() =>
      expect(screen.getByLabelText("restricted@demo agent1 tune")).not.toBeChecked(),
    );

    await user.click(screen.getByLabelText("restricted@demo agent1 tune"));

    expect(await screen.findByText("The admin role is required.")).toBeInTheDocument();
    expect(screen.getByLabelText("restricted@demo agent1 tune")).not.toBeChecked();
    // The rest of the row is untouched by the failed write.
    expect(screen.getByLabelText("restricted@demo agent1 view")).toBeChecked();
  });

  it("invite by email upserts the address and the new member appears as invited", async () => {
    const user = userEvent.setup();
    renderSettings(mockAdminMe);
    await screen.findByText("admin@demo");

    await user.type(screen.getByLabelText("Invite email"), "newbie@demo");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    await waitFor(() => expect(adminUserUpserts).toEqual([{ email: "newbie@demo" }]));
    const row = (await screen.findByText("newbie@demo")).closest("tr")!;
    expect(within(row).getByText("invited")).toBeInTheDocument();
    // A fresh invite grants nothing — "Trees absent from the map grant
    // nothing" (openapi.yaml:3049).
    expect(screen.getByLabelText("newbie@demo agent1 view")).not.toBeChecked();
    expect(screen.getByLabelText("Invite email")).toHaveValue("");
  });
});

describe("Agent trees enable/disable", () => {
  it("disabling asks for confirmation, PATCHes {enabled:false} and badges the row", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderSettings(mockAdminMe);
    await screen.findByText("Agent trees");

    await user.click(screen.getByLabelText("agent2 enabled"));

    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("Disable \"Agent 2\"?"),
    );
    await waitFor(() =>
      expect(treeTogglePatches).toEqual([{ treeId: "agent2", enabled: false }]),
    );
    expect(await screen.findByText("disabled")).toBeInTheDocument();
    expect(screen.getByLabelText("agent2 enabled")).not.toBeChecked();
    confirm.mockRestore();
  });

  it("declining the confirmation leaves the tree alone — nothing is sent", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    renderSettings(mockAdminMe);
    await screen.findByText("Agent trees");

    await user.click(screen.getByLabelText("agent1 enabled"));

    expect(confirm).toHaveBeenCalled();
    expect(treeTogglePatches).toEqual([]);
    expect(screen.getByLabelText("agent1 enabled")).toBeChecked();
    confirm.mockRestore();
  });

  it("re-enabling needs no confirmation — it only restores (feature-spec.md:21)", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderSettings(mockAdminMe);
    await screen.findByText("Agent trees");

    await user.click(screen.getByLabelText("agent1 enabled")); // disable
    await waitFor(() => expect(treeTogglePatches).toHaveLength(1));
    confirm.mockClear();

    await user.click(screen.getByLabelText("agent1 enabled")); // re-enable
    await waitFor(() => expect(treeTogglePatches).toHaveLength(2));
    expect(confirm).not.toHaveBeenCalled();
    expect(treeTogglePatches[1]).toEqual({ treeId: "agent1", enabled: true });
    expect(screen.queryByText("disabled")).not.toBeInTheDocument();
    confirm.mockRestore();
  });

  it("a failed PATCH reverts the switch and surfaces the error", async () => {
    server.use(
      http.patch(`${BASE}/admin/agenttrees/:treeId`, () =>
        HttpResponse.json(
          { code: "not_found", message: "Agent tree 'agent2' not found." },
          { status: 404 },
        ),
      ),
    );
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderSettings(mockAdminMe);
    await screen.findByText("Agent trees");

    await user.click(screen.getByLabelText("agent2 enabled"));

    expect(
      await screen.findByText("Agent tree 'agent2' not found."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("agent2 enabled")).toBeChecked();
    confirm.mockRestore();
  });
});
