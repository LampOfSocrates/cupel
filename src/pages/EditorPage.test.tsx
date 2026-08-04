import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderApp } from "../test/render";
import {
  instructionSaveRequests,
  mockAgents,
  mockInstructions,
  snapshotRequests,
} from "../test/msw/handlers";
import { EditorPage } from "./EditorPage";

// P1-T10b contract under test:
// - GET .../instructions → live pointer + full ascending history
//   (openapi.yaml:221-239, InstructionHistory :1194-1204).
// - PUT .../instructions → 201 new version, now live — "Save instructions as
//   a NEW version (append-only)" (openapi.yaml:243); "Rollback = PUT the old
//   version's content (creates a new version)" (openapi.yaml:249-250).
// - POST .../snapshots → immutable {snapshot_id, label} — "Unsaved snapshots
//   display as 'v15-draft (a3f2)'" (openapi.yaml:277-278).
// - snapshot_id on PUT promotes the draft (openapi.yaml:245-249).

const V3 = "You are Concierge.\nBe polite and brief.\nEscalate refunds to the Refunds agent.";
const V1 = "You are Concierge.\nBe brief.";

function renderEditor(agentId = "ag_concierge") {
  return renderApp(
    <Routes>
      <Route path="/agents/:agentId/editor" element={<EditorPage />} />
    </Routes>,
    { route: `/agents/${agentId}/editor` },
  );
}

async function setDraft(user: ReturnType<typeof userEvent.setup>, text: string) {
  const textarea = await screen.findByLabelText("Instructions");
  await user.clear(textarea);
  await user.click(textarea);
  await user.paste(text);
  return textarea;
}

describe("EditorPage", () => {
  it("loads live content into the editor and lists all versions in the rail", async () => {
    renderEditor();
    expect(await screen.findByLabelText("Instructions")).toHaveValue(V3);
    // rail: v3 live-badged, v2/v1 present with restore actions, draft on top
    expect(within(screen.getByTestId("version-3")).getByText("live")).toBeInTheDocument();
    expect(screen.getByTestId("version-2")).toBeInTheDocument();
    expect(screen.getByTestId("version-1")).toBeInTheDocument();
    expect(screen.getByText("v4 · draft")).toBeInTheDocument();
    expect(screen.queryByText("unsaved changes")).not.toBeInTheDocument();
    // save disabled until dirty; no Test-in-Runs affordance (that is P1-T20b)
    expect(screen.getByRole("button", { name: "Save as v4" })).toBeDisabled();
    expect(screen.queryByText(/Test in Runs/)).not.toBeInTheDocument();
  });

  it("save PUTs {content, format}; the new version appends and becomes live", async () => {
    const user = userEvent.setup();
    renderEditor();
    await setDraft(user, "You are Concierge v4.");
    expect(screen.getByText("unsaved changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save as v4" }));
    expect(await screen.findByTestId("version-4")).toBeInTheDocument();
    expect(instructionSaveRequests).toEqual([
      { agentId: "ag_concierge", body: { content: "You are Concierge v4.", format: "text" } },
    ]);
    // live badge moved to v4; draft rolls forward; clean again
    expect(within(screen.getByTestId("version-4")).getByText("live")).toBeInTheDocument();
    expect(within(screen.getByTestId("version-3")).queryByText("live")).not.toBeInTheDocument();
    expect(screen.getByText("v5 · draft")).toBeInTheDocument();
    expect(screen.queryByText("unsaved changes")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as v5" })).toBeDisabled();
  });

  it("diff defaults to live vs draft and colors added/removed lines", async () => {
    const user = userEvent.setup();
    renderEditor();
    await setDraft(user, "You are Concierge.\nNEW LINE");
    await user.click(screen.getByRole("radio", { name: "Diff" }));

    const dels = screen.getAllByTestId("diff-del").map((el) => el.textContent);
    const adds = screen.getAllByTestId("diff-add").map((el) => el.textContent);
    expect(dels).toEqual(["- Be polite and brief.", "- Escalate refunds to the Refunds agent."]);
    expect(adds).toEqual(["+ NEW LINE"]);
    expect(screen.getAllByTestId("diff-equal").map((el) => el.textContent)).toEqual([
      "  You are Concierge.",
    ]);
  });

  it("diffs any two versions via the from/to selectors", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText("Instructions");
    await user.click(screen.getByRole("radio", { name: "Diff" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Diff from" }), "1");
    await user.selectOptions(screen.getByRole("combobox", { name: "Diff to" }), "2");

    expect(screen.getAllByTestId("diff-add").map((el) => el.textContent)).toEqual([
      "+ Escalate refunds to the Refunds agent.",
    ]);
    expect(screen.queryByTestId("diff-del")).not.toBeInTheDocument();
  });

  it("rollback: restore an old version into the draft, then Save PUTs its content as a new version", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText("Instructions");
    await user.click(screen.getByRole("button", { name: "Restore v1" }));
    expect(screen.getByLabelText("Instructions")).toHaveValue(V1);
    expect(screen.getByText("unsaved changes")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save as v4" }));
    expect(await screen.findByTestId("version-4")).toBeInTheDocument();
    // "Rollback = PUT the old version's content (creates a new version)"
    // (openapi.yaml:249-250) — v1's content became v4, v1..v3 untouched.
    expect(instructionSaveRequests).toEqual([
      { agentId: "ag_concierge", body: { content: V1, format: "text" } },
    ]);
    expect(mockInstructions.ag_concierge.versions.map((v) => v.version)).toEqual([1, 2, 3, 4]);
  });

  it("Snapshot draft POSTs {content, base_version} and lists the returned label", async () => {
    const user = userEvent.setup();
    renderEditor();
    await setDraft(user, "Draft text.");
    await user.click(screen.getByRole("button", { name: "Snapshot draft" }));

    expect(await screen.findByText("v3-draft (a3f1)")).toBeInTheDocument();
    expect(snapshotRequests).toEqual([
      { agentId: "ag_concierge", body: { content: "Draft text.", base_version: 3 } },
    ]);
  });

  it("saving a draft unchanged since its snapshot promotes it (snapshot_id on PUT)", async () => {
    const user = userEvent.setup();
    renderEditor();
    await setDraft(user, "Draft text.");
    await user.click(screen.getByRole("button", { name: "Snapshot draft" }));
    await screen.findByText("v3-draft (a3f1)");

    await user.click(screen.getByRole("button", { name: "Save as v4" }));
    expect(await screen.findByTestId("version-4")).toBeInTheDocument();
    expect(instructionSaveRequests).toEqual([
      {
        agentId: "ag_concierge",
        body: { content: "Draft text.", format: "text", snapshot_id: "a3f1" },
      },
    ]);
    // promoted-from-snapshot annotation on the rail entry (openapi.yaml:1189-1192)
    expect(
      within(screen.getByTestId("version-4")).getByText("from snapshot a3f1"),
    ).toBeInTheDocument();
  });

  it("editing after a snapshot drops the promotion — save has no snapshot_id", async () => {
    const user = userEvent.setup();
    renderEditor();
    await setDraft(user, "Draft text.");
    await user.click(screen.getByRole("button", { name: "Snapshot draft" }));
    await screen.findByText("v3-draft (a3f1)");
    await setDraft(user, "Draft text. Edited after snapshot.");

    await user.click(screen.getByRole("button", { name: "Save as v4" }));
    await screen.findByTestId("version-4");
    expect(instructionSaveRequests[0].body.snapshot_id).toBeUndefined();
  });

  it("v0 agent starts empty; first save creates v1", async () => {
    mockAgents.agent1.push({
      id: "ag_new",
      name: "New Agent",
      parent_id: "ag_concierge",
      live_version: 0,
      tools: [],
      enabled: true,
      format: "text",
    });
    const user = userEvent.setup();
    renderEditor("ag_new");
    expect(await screen.findByLabelText("Instructions")).toHaveValue("");
    expect(screen.getByText("No versions yet — first save creates v1.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save as v1" })).toBeDisabled();

    await setDraft(user, "First draft.");
    await user.click(screen.getByRole("button", { name: "Save as v1" }));
    expect(await screen.findByTestId("version-1")).toBeInTheDocument();
    expect(instructionSaveRequests).toEqual([
      { agentId: "ag_new", body: { content: "First draft.", format: "text" } },
    ]);
    expect(within(screen.getByTestId("version-1")).getByText("live")).toBeInTheDocument();
    expect(screen.getByText("v2 · draft")).toBeInTheDocument();
  });

  it("format select is metadata only and is sent on save", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByLabelText("Instructions");
    // no validation UI in Phase 1: "Phase 1 treats both as plain text; YAML
    // schema validation is Phase 2" (openapi.yaml:1163-1164)
    await user.selectOptions(screen.getByRole("combobox", { name: "Format" }), "yaml");
    await setDraft(user, "name: concierge");
    await user.click(screen.getByRole("button", { name: "Save as v4" }));
    await screen.findByTestId("version-4");
    expect(instructionSaveRequests).toEqual([
      { agentId: "ag_concierge", body: { content: "name: concierge", format: "yaml" } },
    ]);
  });
});
