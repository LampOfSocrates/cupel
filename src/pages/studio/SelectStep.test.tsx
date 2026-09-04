import { useState } from "react";
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/render";
import type { SelectionItem } from "../../api/types";
import { SelectStep } from "./SelectStep";

// Step 1 of the evaluation wizard. The behaviour worth pinning is the SPLIT
// that inverts — "the stage you finished shrinks to a ribbon you can always
// reopen" — and the Selected panel's two removals, which have to obey the same
// narrowing rule the grid's checkboxes do (src/pages/studio/selection.ts).

function Harness({ initial = [] as SelectionItem[] }) {
  const [selection, setSelection] = useState<SelectionItem[]>(initial);
  return <SelectStep tree="agent1" selection={selection} onSelectionChange={setSelection} />;
}

const renderStep = (initial?: SelectionItem[]) =>
  renderApp(<Harness initial={initial} />, { route: "/studio/evaluations/new" });

describe("SelectStep — the inverting split", () => {
  it("opens with the grid, and no ribbon, while nothing is picked", async () => {
    renderStep();
    await screen.findByText("Refund escalation");
    expect(screen.queryByTestId("browse-ribbon")).not.toBeInTheDocument();
  });

  it("explains the empty Selected panel rather than showing an empty box", async () => {
    renderStep();
    await screen.findByText(/Tick a conversation to include all of its turns/);
  });

  it("collapses the grid to a ribbon on the first pick", async () => {
    const user = userEvent.setup();
    renderStep();
    await screen.findByText("Refund escalation");

    await user.click(screen.getByRole("checkbox", { name: "Select Refund escalation" }));
    await screen.findByTestId("browse-ribbon");
    expect(screen.queryByRole("checkbox", { name: "Select Refund escalation" })).not.toBeInTheDocument();
  });

  it("opens with the grid ALREADY collapsed when a selection arrives preloaded", async () => {
    renderStep([{ conversation_id: "c1" }]);
    await screen.findByTestId("browse-ribbon");
  });

  it("reopens the grid from the ribbon, and stays open through the next pick", async () => {
    // The tri-state: once someone has asked for the grid back, a further pick
    // must not collapse it under them again.
    const user = userEvent.setup();
    renderStep();
    await screen.findByText("Refund escalation");
    await user.click(screen.getByRole("checkbox", { name: "Select Refund escalation" }));

    await user.click(await screen.findByTestId("browse-ribbon"));
    await user.click(await screen.findByRole("checkbox", { name: "Select Billing dispute" }));
    expect(screen.queryByTestId("browse-ribbon")).not.toBeInTheDocument();
  });

  it("Clear all empties the selection and gives the grid back", async () => {
    const user = userEvent.setup();
    renderStep([{ conversation_id: "c1" }]);
    await screen.findByTestId("browse-ribbon");

    await user.click(screen.getByRole("button", { name: "Clear all" }));
    // Not just empty — reachable. An empty panel over a collapsed grid would
    // be a screen with nothing on it and no obvious way back.
    await screen.findByRole("checkbox", { name: "Select Refund escalation" });
    expect(screen.queryByTestId("browse-ribbon")).not.toBeInTheDocument();
  });
});

describe("SelectStep — the Selected panel", () => {
  it("counts a whole conversation by its turn_count, with no transcript fetched", async () => {
    renderStep([{ conversation_id: "c1" }]);
    // c1 holds two turns in the fixtures.
    await waitFor(() => expect(screen.getByText(/1 conversation · 2 turns/)).toBeInTheDocument());
  });

  it("removes a whole conversation from the group ✕", async () => {
    const user = userEvent.setup();
    renderStep([{ conversation_id: "c1" }]);
    await user.click(await screen.findByRole("button", { name: "Remove Refund escalation" }));
    await screen.findByText(/Tick a conversation to include all of its turns/);
  });

  it("removing one turn narrows the set instead of dropping the conversation", async () => {
    const user = userEvent.setup();
    renderStep([{ conversation_id: "c1", turn_ids: ["t1", "t2"] }]);

    await user.click(await screen.findByRole("button", { name: "Remove turn t1" }));
    // Still selected, now one turn lighter — the rule the handoff states twice.
    await waitFor(() => expect(screen.getByText(/1 conversation · 1 turn/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Remove turn t2" })).toBeInTheDocument();
  });

  it("opens and closes the In/Out pane from a turn row", async () => {
    const user = userEvent.setup();
    renderStep([{ conversation_id: "c1", turn_ids: ["t2"] }]);

    const row = await screen.findByText("t2", { exact: false });
    await user.click(row);
    const pane = await screen.findByTestId("in-out-pane");
    // The OUT is the turn itself; the IN is the user turn before it.
    await waitFor(() =>
      expect(pane).toHaveTextContent("Approved refunds land in 3-5 days."),
    );
    expect(pane).toHaveTextContent("How do refunds work?");

    await user.click(screen.getByRole("button", { name: "Close turn detail" }));
    expect(screen.queryByTestId("in-out-pane")).not.toBeInTheDocument();
  });
});
