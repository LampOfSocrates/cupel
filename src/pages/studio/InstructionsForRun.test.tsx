import { useState } from "react";
import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderApp } from "../../test/render";
import { instructionSaveRequests, mockAgents, snapshotRequests } from "../../test/msw/handlers";
import { InstructionsForRun, type RunDraft } from "./InstructionsForRun";

// "Agent instructions for this run".
//
// The invariant under test is what editing here does NOT do: it never writes an
// instruction version. A per-run edit is a draft the run carries; publishing is
// a separate explicit action elsewhere.

function Harness({ initial = null as RunDraft | null }) {
  const [draft, setDraft] = useState<RunDraft | null>(initial);
  return (
    <InstructionsForRun
      tree="agent1"
      agents={mockAgents.agent1}
      draft={draft}
      onDraftChange={setDraft}
    />
  );
}

const render = (initial?: RunDraft | null) =>
  renderApp(<Harness initial={initial} />, { route: "/studio/evaluations/new" });

describe("InstructionsForRun", () => {
  it("opens on the first agent, showing its LIVE instruction text", async () => {
    render();
    // ag_concierge's live version is 3 in the fixtures.
    const box = await screen.findByRole("textbox", { name: "Instructions for Concierge" });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toContain("Be polite and brief."));
  });

  it("says an untouched run leaves the live instructions alone", async () => {
    render();
    await screen.findByText(/Editing here only affects this run/);
  });

  it("marks an edited agent, and never posts an instruction version", async () => {
    const user = userEvent.setup();
    render();
    const box = await screen.findByRole("textbox", { name: "Instructions for Concierge" });
    await waitFor(() => expect(box).not.toHaveValue(""));

    await user.type(box, " Always cite the policy.");

    await screen.findByText("edited for this run");
    await screen.findByText(/saved as a draft version, the live one stays untouched/);
    // THE invariant: a per-run edit writes nothing. Not a version here, and
    // not a snapshot either — that happens once, at Queue.
    expect(instructionSaveRequests).toHaveLength(0);
    expect(snapshotRequests).toHaveLength(0);
  });

  it("reset drops the override and returns the live text", async () => {
    const user = userEvent.setup();
    render({ agentId: "ag_concierge", content: "Something else entirely." });

    await user.click(await screen.findByRole("button", { name: "reset to v3" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: "Instructions for Concierge" }) as HTMLTextAreaElement)
          .value,
      ).toContain("Be polite and brief."),
    );
    expect(screen.queryByText("edited for this run")).not.toBeInTheDocument();
  });

  it("typing back to exactly the live text is no override at all", async () => {
    const user = userEvent.setup();
    render();
    const box = await screen.findByRole("textbox", { name: "Instructions for Concierge" });
    await waitFor(() => expect(box).not.toHaveValue(""));

    await user.type(box, "x");
    await screen.findByText("edited for this run");
    await user.type(box, "{backspace}");
    // A snapshot identical to what is already live is not a draft.
    await waitFor(() => expect(screen.queryByText("edited for this run")).not.toBeInTheDocument());
  });

  it("warns that editing a second agent MOVES the override, because a run carries one", async () => {
    const user = userEvent.setup();
    render({ agentId: "ag_concierge", content: "Drafted." });

    await user.click(await screen.findByText("Refunds"));
    // Variant holds a single agent_id + snapshot_id (openapi.yaml Variant), so
    // this is the contract speaking. Said before the fact, not discovered when
    // the run comes back narrower than the screen implied.
    await screen.findByText(/A run carries one instruction override/);
  });

  it("labels each agent live, or live-plus-a-draft", async () => {
    render({ agentId: "ag_concierge", content: "Drafted." });
    await screen.findByText("v3 → draft");
    // Refunds and Shipping both sit at v1 in the fixtures.
    expect(screen.getAllByText("v1 (live)")).toHaveLength(2);
  });
});
