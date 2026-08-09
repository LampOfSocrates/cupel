import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { renderApp } from "../test/render";
import {
  casebookCreates,
  casebookDeletes,
  casebookItemDeletes,
  casebookReplayRequests,
  casebookToEvalSetRequests,
  mockCasebooks,
} from "../test/msw/handlers";
import { CasebooksPage } from "./CasebooksPage";

// Contract under test — Casebook view (cupel-phases.md:79 "Collect
// noteworthy turns into Casebooks with one keystroke, then turn a casebook
// into an eval set, a replay regression suite, or few-shot examples";
// feature-spec.md:237 "Casebook view | GET /casebooks/{id},
// POST …/to-eval-set, POST …/replay"):
// - GET/POST /casebooks (openapi.yaml:1643-1680)
// - DELETE /casebooks/{id} (:1718-1730) — references only
// - DELETE /casebooks/{id}/items/{itemId} (:1759-1775)
// - POST /casebooks/{id}/to-eval-set (:1777-1802) → EvalSet
// - POST /casebooks/{id}/replay (:1804-1830) → CasebookReplayAccepted, one
//   run per tree under one parent task
// Items are REFERENCES (:1689-1691), so the item list renders each one by
// following it to its conversation.

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname}</div>;
}

function renderCasebooks() {
  return renderApp(
    <Routes>
      <Route path="/casebooks" element={<CasebooksPage />} />
      <Route path="*" element={<LocationProbe />} />
    </Routes>,
    { route: "/casebooks" },
  );
}

describe("casebook list", () => {
  it("lists casebooks with their item counts and opens the first one", async () => {
    renderCasebooks();
    const row = await screen.findByTestId("casebook-row");
    expect(within(row).getByText("Refund misses")).toBeInTheDocument();
    expect(within(row).getByText("1")).toBeInTheDocument();
    expect(row).toHaveAttribute("data-selected", "true");
  });

  it("explains the point of the screen when there are none", async () => {
    mockCasebooks.length = 0;
    renderCasebooks();
    const empty = await screen.findByTestId("casebooks-empty");
    expect(empty.textContent).toMatch(/press a on a turn in the inspector/i);
  });

  it("creates a casebook", async () => {
    renderCasebooks();
    await screen.findByTestId("casebook-row");
    fireEvent.change(screen.getByLabelText("New casebook name"), {
      target: { value: "Ops regressions" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(casebookCreates).toEqual([{ name: "Ops regressions" }]));
    // Appears in the list AND opens in the detail pane.
    await waitFor(() => expect(screen.getAllByTestId("casebook-row")).toHaveLength(2));
    expect(screen.getAllByTestId("casebook-row")[0]).toHaveAttribute("data-selected", "true");
    expect(screen.getAllByText("Ops regressions")).toHaveLength(2);
  });

  it("deletes a casebook (references only)", async () => {
    renderCasebooks();
    await screen.findByTestId("casebook-row");
    await userEvent.click(screen.getByRole("button", { name: "Delete casebook" }));
    await waitFor(() => expect(casebookDeletes).toEqual(["cb-1"]));
    expect(await screen.findByTestId("casebooks-empty")).toBeInTheDocument();
  });
});

describe("items rendered by following each reference", () => {
  it("shows the referenced turn's text and its note", async () => {
    renderCasebooks();
    const item = await screen.findByTestId("casebook-item");
    // Text comes from GET /agenttrees/agent1/conversations/c1 → turn t2.
    expect(await within(item).findByText("Approved refunds land in 3-5 days.")).toBeInTheDocument();
    expect(within(item).getByText("hedged answer")).toBeInTheDocument();
    expect(within(item).getByText("agent1")).toBeInTheDocument();
  });

  it("removes an item", async () => {
    renderCasebooks();
    await screen.findByTestId("casebook-item");
    await userEvent.click(screen.getByRole("button", { name: "Remove t2" }));
    await waitFor(() =>
      expect(casebookItemDeletes).toEqual([{ casebookId: "cb-1", itemId: "cbi-1" }]),
    );
    expect(await screen.findByTestId("casebook-items-empty")).toBeInTheDocument();
  });

  it("says so when a casebook holds nothing yet", async () => {
    mockCasebooks[0].items = [];
    renderCasebooks();
    const empty = await screen.findByTestId("casebook-items-empty");
    expect(empty.textContent).toMatch(/nothing collected yet/i);
    expect(screen.getByRole("button", { name: "Create eval set" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Replay" })).toBeDisabled();
  });
});

describe("casebook actions", () => {
  it("creates an eval set from the casebook and links to the workbench", async () => {
    renderCasebooks();
    await screen.findByTestId("casebook-item");
    fireEvent.change(screen.getByLabelText("Eval set name"), {
      target: { value: "refund regressions" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Create eval set" }));

    await waitFor(() => expect(casebookToEvalSetRequests).toHaveLength(1));
    expect(casebookToEvalSetRequests[0]).toEqual({
      casebookId: "cb-1",
      body: { set_name: "refund regressions" },
    });
    const alert = await screen.findByTestId("casebook-set-created");
    expect(alert).toHaveTextContent("refund regressions");
    expect(alert).toHaveTextContent("1 case");
    await userEvent.click(within(alert).getByRole("link", { name: /eval workbench/i }));
    expect(screen.getByTestId("loc")).toHaveTextContent("/eval");
  });

  it("defaults the set name to the casebook name", async () => {
    renderCasebooks();
    await screen.findByTestId("casebook-item");
    await userEvent.click(screen.getByRole("button", { name: "Create eval set" }));
    await waitFor(() =>
      expect(casebookToEvalSetRequests[0].body).toEqual({ set_name: "Refund misses cases" }),
    );
  });

  it("replays the casebook and links to the queue and the resulting run", async () => {
    renderCasebooks();
    await screen.findByTestId("casebook-item");
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));

    await waitFor(() => expect(casebookReplayRequests).toHaveLength(1));
    // context_policy is pinned by the client exactly as on api.replay.
    expect(casebookReplayRequests[0]).toEqual({
      casebookId: "cb-1",
      body: { configs: [{}], context_policy: "frozen" },
    });
    const alert = await screen.findByTestId("casebook-replay-accepted");
    expect(alert).toHaveTextContent("Enqueued 1 evaluation under one task");
    await userEvent.click(within(alert).getByRole("link", { name: "run-cb-1-1" }));
    expect(screen.getByTestId("loc")).toHaveTextContent("/evaluations/run-cb-1-1");
  });

  it("carries the chosen model into the replay config", async () => {
    renderCasebooks();
    await screen.findByTestId("casebook-item");
    await userEvent.click(await screen.findByRole("combobox", { name: "Replay config" }));
    await userEvent.click(await screen.findByRole("option", { name: "Claude Sonnet 5" }));
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));
    await waitFor(() =>
      expect(casebookReplayRequests[0].body).toEqual({
        configs: [{ model: "claude-sonnet-5" }],
        context_policy: "frozen",
      }),
    );
  });

  it("names an evaluation in another tree instead of linking it (evaluation pages are tree-scoped)", async () => {
    mockCasebooks[0].items = [
      {
        id: "cbi-1",
        tree: "agent1",
        conversation_id: "c1",
        turn_id: "t2",
        note: null,
        added_at: "2026-08-04T10:01:00Z",
      },
      {
        id: "cbi-2",
        tree: "agent2",
        conversation_id: "c3",
        turn_id: "t-x",
        note: null,
        added_at: "2026-08-04T10:02:00Z",
      },
    ];
    renderCasebooks();
    await screen.findAllByTestId("casebook-item");
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));
    const alert = await screen.findByTestId("casebook-replay-accepted");
    expect(alert).toHaveTextContent("Enqueued 2 evaluations under one task");
    expect(within(alert).getByRole("link", { name: "run-cb-1-1" })).toBeInTheDocument();
    expect(within(alert).queryByRole("link", { name: "run-cb-1-2" })).not.toBeInTheDocument();
    expect(alert).toHaveTextContent(/opens when agent2 is the active tree/);
  });
});
