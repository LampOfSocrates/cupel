import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import { ConversationPicker } from "./ConversationPicker";
import { conversationRequests } from "../test/msw/handlers";

// Contract under test: SelectionItem (openapi.yaml:1250-1259) — "Absent/null =
// whole conversation; present = just these turns (feature-spec.md:44)".
// Search is server-side ?search= (openapi.yaml:352-354). Fixtures: c1 has
// turns t1 (user) + t2 (assistant); c2/c3 have none (handlers.ts:65-102).

function renderPicker(onSelectionChange: (items: unknown) => void) {
  return render(
    <MantineProvider env="test">
      <ConversationPicker tree="agent1" onSelectionChange={onSelectionChange} />
    </MantineProvider>,
  );
}

describe("ConversationPicker", () => {
  it("emits a whole-conversation item with NO turn_ids key", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderPicker(onChange);
    await screen.findByText("Refund escalation");

    await user.click(screen.getByRole("checkbox", { name: "Select Refund escalation" }));
    // toStrictEqual: turn_ids must be absent, not undefined/null noise
    expect(onChange).toHaveBeenLastCalledWith([{ conversation_id: "c1" }]);
    expect(onChange.mock.lastCall![0][0]).not.toHaveProperty("turn_ids");
    expect(screen.getByTestId("picker-summary")).toHaveTextContent("1 conversation · 0 turns");
  });

  it("expands turns; assistant turns selectable, user turns are not; partial emits turn_ids", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderPicker(onChange);
    await screen.findByText("Refund escalation");

    await user.click(screen.getByRole("button", { name: "Toggle turns of Refund escalation" }));
    // user turn t1 renders as context, without a checkbox
    expect(screen.getByText("How do refunds work?")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Select turn t1" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Select turn t2" }));
    expect(onChange).toHaveBeenLastCalledWith([{ conversation_id: "c1", turn_ids: ["t2"] }]);
    expect(screen.getByTestId("picker-summary")).toHaveTextContent("0 conversations · 1 turn");
  });

  it("unticking a turn while the whole conversation is selected narrows the selection", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderPicker(onChange);
    await screen.findByText("Refund escalation");

    await user.click(screen.getByRole("checkbox", { name: "Select Refund escalation" }));
    await user.click(screen.getByRole("button", { name: "Toggle turns of Refund escalation" }));
    // whole-conversation selection shows the assistant turn as checked
    const turn = screen.getByRole("checkbox", { name: "Select turn t2" });
    expect(turn).toBeChecked();
    // c1 has exactly one assistant turn — removing it empties the selection
    await user.click(turn);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("selects across conversations and mixes whole + partial items", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderPicker(onChange);
    await screen.findByText("Refund escalation");

    await user.click(screen.getByRole("button", { name: "Toggle turns of Refund escalation" }));
    await user.click(screen.getByRole("checkbox", { name: "Select turn t2" }));
    await user.click(screen.getByRole("checkbox", { name: "Select Onboarding help" }));
    expect(onChange).toHaveBeenLastCalledWith([
      { conversation_id: "c1", turn_ids: ["t2"] },
      { conversation_id: "c3" },
    ]);
    expect(screen.getByTestId("picker-summary")).toHaveTextContent("1 conversation · 1 turn");
  });

  it("search hits the server with ?search= and filters the list", async () => {
    const user = userEvent.setup();
    renderPicker(vi.fn());
    await screen.findByText("Refund escalation");

    await user.type(screen.getByPlaceholderText("Search conversations"), "billing");
    await waitFor(() => {
      const urls = conversationRequests.map((u) => u.searchParams.get("search"));
      expect(urls).toContain("billing");
    });
    await screen.findByText("Billing dispute");
    expect(screen.queryByText("Refund escalation")).not.toBeInTheDocument();
  });
});
