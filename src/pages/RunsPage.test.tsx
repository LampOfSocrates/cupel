import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderApp } from "../test/render";
import { replayRequests, runListRequests } from "../test/msw/handlers";
import { RunsPage } from "./RunsPage";
import { RunDetailPage } from "./RunDetailPage";

// Contract under test — the Runs stepper (loom-phases.md:19: "pick (sketch
// 02), configure (sketch 03), compare (sketch 04)"):
// - GET /agenttrees/{tree}/runs "Runs, newest first" (openapi.yaml:663)
// - ReplayRequest {selection, configs, context_policy} (openapi.yaml:
//   1516-1546) — selection shapes preserved verbatim ("Absent/null = whole
//   conversation; present = just these turns", :1258), configs "One grid
//   column per config" (:1531-1532), context_policy pinned frozen by the
//   client (:1540-1546)
// - 202 "run row appears immediately and fills incrementally" (:617) →
//   navigate to the detail grid.

function renderRuns(route = "/runs") {
  return renderApp(
    <Routes>
      <Route path="/runs" element={<RunsPage />} />
      <Route path="/runs/:runId" element={<RunDetailPage />} />
    </Routes>,
    { route },
  );
}

describe("RunsPage — landing", () => {
  it("lists runs from GET runs and routes to the detail on row click", async () => {
    const user = userEvent.setup();
    renderRuns();
    // seeded fixture run-old-1, label from the summary shape
    await screen.findByText("Replay · 1 config(s)");
    expect(runListRequests).toEqual(["agent1"]);

    await user.click(screen.getByRole("button", { name: /Open Replay · 1 config/ }));
    // detail route renders the stored grid (baseline + v3 columns)
    await screen.findByText("Run run-old-1");
    expect(screen.getByText("v3")).toBeInTheDocument();
    expect(screen.getByTestId("cell-0-1")).toHaveAttribute("data-status", "done");
  });
});

describe("RunsPage — stepper", () => {
  it("gates Configure until the selection is non-empty", async () => {
    const user = userEvent.setup();
    renderRuns();
    await user.click(await screen.findByRole("button", { name: "New run" }));

    // Step 1: picker with server-fed conversations
    await screen.findByText("Refund escalation");
    const next = screen.getByRole("button", { name: "Configure ▸" });
    expect(next).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: "Select Refund escalation" }));
    expect(next).toBeEnabled();

    // unticking empties the selection again → gate re-closes
    await user.click(screen.getByRole("checkbox", { name: "Select Refund escalation" }));
    expect(next).toBeDisabled();
  });

  it("queues a replay whose POST body matches the contract exactly, then navigates to the pending grid", async () => {
    const user = userEvent.setup();
    renderRuns();
    await user.click(await screen.findByRole("button", { name: "New run" }));

    // Select: a single turn of c1 (expand → tick t2) + all of c2 — both
    // SelectionItem shapes (openapi.yaml:1250-1259).
    await screen.findByText("Refund escalation");
    await user.click(screen.getByRole("button", { name: "Toggle turns of Refund escalation" }));
    await user.click(await screen.findByRole("checkbox", { name: "Select turn t2" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Billing dispute" }));
    await user.click(screen.getByRole("button", { name: "Configure ▸" }));

    // Configure: config 1 untouched (= live/stored baseline); add a second
    // config and change its model — "one column per run config"
    // (feature-spec.md:49).
    await screen.findByText("baseline: stored originals · prefilled");
    await user.click(screen.getByRole("button", { name: "+ Add config" }));
    const config2 = await screen.findByTestId("config-1");
    await user.click(within(config2).getByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name: "Claude Haiku 4.5" }));

    // judge section dormant in this task (wiring is P1-T12b)
    expect(screen.queryByRole("switch", { name: "⚖ Judge" })).not.toBeInTheDocument();
    // endpoints hidden — turn re-fire is P1-T13
    expect(screen.queryByRole("combobox", { name: "Endpoints" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Queue" }));

    await waitFor(() => expect(replayRequests).toHaveLength(1));
    expect(replayRequests[0].tree).toBe("agent1");
    // Exact body: shapes preserved, frozen policy hard-pinned by the client
    // (client.ts api.replay; openapi.yaml:1540-1546).
    expect(replayRequests[0].body).toEqual({
      selection: [{ conversation_id: "c1", turn_ids: ["t2"] }, { conversation_id: "c2" }],
      configs: [{}, { model: "claude-haiku-4-5" }],
      context_policy: "frozen",
    });

    // 202 → navigate to the run detail: initial grid with baseline done and
    // one pending cell per config (openapi.yaml:617).
    await screen.findByText("Run run-1");
    expect(screen.getByTestId("cell-0-0")).toHaveAttribute("data-status", "done");
    expect(screen.getByTestId("cell-0-1")).toHaveAttribute("data-status", "pending");
    expect(screen.getByTestId("cell-0-2")).toHaveAttribute("data-status", "pending");
    // column labels: config-derived ("config 1" fallback, model id)
    expect(screen.getByText("config 1")).toBeInTheDocument();
    expect(screen.getByText("claude-haiku-4-5")).toBeInTheDocument();
  });
});
