import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { Route, Routes } from "react-router";
import { renderApp } from "../test/render";
import { server } from "../test/msw/server";
import {
  BASE,
  instructionSaveRequests,
  mockAgents,
  mockInstructions,
  mockLastSelections,
  snapshotRequests,
} from "../test/msw/handlers";
import { EditorPage } from "./EditorPage";
import { EvaluationsPage } from "./EvaluationsPage";

// Contract under test:
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
    // save disabled until dirty; Test as evaluation always available — "drafts are
    // testable without saving" (feature-spec.md:86)
    expect(screen.getByRole("button", { name: "Save as v4" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test as evaluation" })).toBeEnabled();
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

  // "Test an instruction change in one click: 'Test as evaluation'
  // snapshots your draft and replays your usual conversations against it —
  // using the editor → Evaluations flow (sketches 06 → 03)" (cupel-phases.md:18).
  // Real EvaluationsPage mounted at /evaluations so the router-state handoff is exercised
  // end to end, not against a probe.
  const renderEditorWithEvaluations = (agentId = "ag_concierge") =>
    renderApp(
      <Routes>
        <Route path="/agents/:agentId/editor" element={<EditorPage />} />
        <Route path="/evaluations" element={<EvaluationsPage />} />
      </Routes>,
      { route: `/agents/${agentId}/editor` },
    );

  it("Test as evaluation reuses an unchanged snapshot (no second POST) and opens Evaluations prefilled", async () => {
    // remembered selection → the arrival lands straight on Configure
    // (feature-spec.md:87 "Repeat testing = Test as evaluation → Queue, two taps")
    mockLastSelections.ag_concierge = [{ conversation_id: "c1" }];
    const user = userEvent.setup();
    renderEditorWithEvaluations();
    await setDraft(user, "Draft text.");
    await user.click(screen.getByRole("button", { name: "Snapshot draft" }));
    await screen.findByText("v3-draft (a3f1)");

    await user.click(screen.getByRole("button", { name: "Test as evaluation" }));
    // Evaluations stepper at Configure, config carrying the snapshot + its label
    // ("the draft text is snapshotted immutably into the run config
    // (snapshot_id)", feature-spec.md:86) — Queue is the second tap.
    expect(await screen.findByTestId("config-0")).toBeInTheDocument();
    expect(screen.getByTestId("snapshot-badge")).toHaveTextContent("v3-draft (a3f1)");
    expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument();
    // draft unchanged since its snapshot → REUSED, still exactly one POST
    expect(snapshotRequests).toHaveLength(1);
  });

  it("Test as evaluation with an edited draft POSTs a fresh snapshot; empty last-selection lands on Pick", async () => {
    const user = userEvent.setup();
    renderEditorWithEvaluations();
    await setDraft(user, "Draft text.");
    await user.click(screen.getByRole("button", { name: "Snapshot draft" }));
    await screen.findByText("v3-draft (a3f1)");
    await setDraft(user, "Draft text. Edited.");

    await user.click(screen.getByRole("button", { name: "Test as evaluation" }));
    // "empty items = first-time testing" (openapi.yaml:311) → Pick step
    await screen.findByText("Refund escalation");
    expect(screen.getByRole("button", { name: "Configure ▸" })).toBeDisabled();
    // snapshots are immutable — the edited draft needed a NEW one
    expect(snapshotRequests).toHaveLength(2);
    expect(snapshotRequests[1]).toEqual({
      agentId: "ag_concierge",
      body: { content: "Draft text. Edited.", base_version: 3 },
    });
  });

  // Free-tier export: pure client-side Blob download of the
  // already-fetched history; no request leaves the page (MSW would error on
  // any unhandled one — contract untouched).
  it("Download → JSON triggers a client-side download with the right filename", async () => {
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:cupel-export";
    });
    const revokeObjectURL = vi.fn();
    // jsdom ships neither — install, then remove so other tests see stock URL
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const downloads: string[] = [];
    // jsdom can't navigate blob: URLs — capture the anchor click instead
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
    try {
      const user = userEvent.setup();
      renderEditor();
      await screen.findByLabelText("Instructions");
      const trigger = screen.getByRole("button", { name: "Download" });
      expect(trigger).toBeEnabled();
      await user.click(trigger);
      await user.click(await screen.findByRole("menuitem", { name: "JSON (.json)" }));

      expect(downloads).toEqual(["ag_concierge-instructions-v3.json"]);
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(blobs[0].type).toBe("application/json");
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:cupel-export");
    } finally {
      clickSpy.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  it("v0 agent (no versions) has Download disabled", async () => {
    mockAgents.agent1.push({
      id: "ag_new",
      name: "New Agent",
      parent_id: "ag_concierge",
      live_version: 0,
      tools: [],
      enabled: true,
      format: "text",
    });
    renderEditor("ag_new");
    await screen.findByText("No versions yet — first save creates v1.");
    expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
  });

  // #7 — draft durability. The editor body owns the draft; nothing short of a
  // genuinely different agent/tree may reset it. Two ways it used to die: a
  // write failure swapped the whole page for the error screen (taking the
  // Textarea, and the draft, with it), and a re-seed of the same data would
  // overwrite text typed while a save was in flight.
  describe("the draft survives everything short of a new agent", () => {
    it("a failed save keeps the draft on screen", async () => {
      server.use(
        http.post(`${BASE}/agenttrees/:tree/agents/:agentId/instructions/versions`, () =>
          HttpResponse.json({ code: "internal", message: "instruction store down" }, { status: 500 }),
        ),
      );
      const user = userEvent.setup();
      renderEditor();
      await setDraft(user, "Twenty minutes of unsaved work.");

      await user.click(screen.getByRole("button", { name: "Save as v4" }));
      expect(await screen.findByText("instruction store down")).toBeInTheDocument();
      // the whole point: the save failed, the text did not
      expect(screen.getByLabelText("Instructions")).toHaveValue(
        "Twenty minutes of unsaved work.",
      );
      expect(screen.getByRole("button", { name: "Save as v4" })).toBeEnabled();
    });

    it("a failed Test-as-evaluation snapshot keeps the draft on screen", async () => {
      server.use(
        http.post(`${BASE}/agenttrees/:tree/agents/:agentId/snapshots`, () =>
          HttpResponse.json({ code: "internal", message: "instruction store down" }, { status: 500 }),
        ),
      );
      const user = userEvent.setup();
      renderEditorWithEvaluations();
      await setDraft(user, "Draft worth testing.");

      await user.click(screen.getByRole("button", { name: "Test as evaluation" }));
      expect(await screen.findByText("instruction store down")).toBeInTheDocument();
      expect(screen.getByLabelText("Instructions")).toHaveValue("Draft worth testing.");
    });

    it("typing while a save is in flight is not clobbered when it lands", async () => {
      // The Textarea is deliberately NOT disabled while saving, so this
      // interleaving is reachable: keystrokes land between the PUT and its
      // response, and the post-save re-seed must not roll them back.
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      server.use(
        http.post(`${BASE}/agenttrees/:tree/agents/:agentId/instructions/versions`, async (info) => {
          await gate;
          return info.request.clone().json().then((body) => {
            const b = body as { content: string; format?: "text" | "yaml" };
            return HttpResponse.json(
              {
                version: 4,
                content: b.content,
                format: b.format ?? "text",
                created_at: new Date().toISOString(),
                promoted_from_snapshot_id: null,
              },
              { status: 201 },
            );
          });
        }),
      );
      const user = userEvent.setup();
      renderEditor();
      const textarea = await setDraft(user, "First half.");
      await user.click(screen.getByRole("button", { name: "Save as v4" }));

      await user.click(textarea);
      await user.paste(" Second half typed during the save.");
      release();

      expect(await screen.findByTestId("version-4")).toBeInTheDocument();
      expect(screen.getByLabelText("Instructions")).toHaveValue(
        "First half. Second half typed during the save.",
      );
      // still dirty — what landed as v4 is only the first half
      expect(screen.getByText("unsaved changes")).toBeInTheDocument();
    });
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
