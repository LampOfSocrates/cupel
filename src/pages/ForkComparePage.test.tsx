import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useParams } from "react-router";
import { renderApp } from "../test/render";
import { conv, conversationRequests, mockForks } from "../test/msw/handlers";
import { ForkComparePage } from "./ForkComparePage";

// Contract under test — feature-spec.md:73: "Forked conversations appear in
// GET /conversations (filterable: forks_of={id}), and the comparison grid can
// pivot to compare forks of the same turn across endpoints (column per
// endpoint)". This route is the evaluation-id-less reconstruction of that pivot
// (design rationale in ForkComparePage.tsx): siblings via ?forks_of=,
// filtered client-side by lineage.fork_turn_id; baseline = the original turn
// on the parent; "Open in Chat ↗" per card (feature-spec.md:70).

function ChatProbe() {
  const { conversationId } = useParams();
  return <div>chat-probe {conversationId}</div>;
}

function renderCompare(route: string) {
  return renderApp(
    <Routes>
      <Route path="/forks/:parentId/:turnId" element={<ForkComparePage />} />
      <Route path="/chat/:conversationId" element={<ChatProbe />} />
    </Routes>,
    { route },
  );
}

describe("ForkComparePage", () => {
  it("lists sibling forks of the turn via ?forks_of=, endpoint-name labels, baseline = original", async () => {
    // A fork of a DIFFERENT turn must be filtered out (same parent, t5 ≠ t9).
    mockForks.c2.push(
      conv({
        id: "c2f-other-turn",
        title: "Billing dispute",
        lineage: { parent_conversation_id: "c2", fork_turn_id: "t5", endpoint_id: "ep_agent1_prod" },
      }),
    );
    renderCompare("/forks/c2/t9");

    // baseline card = the original t9 content off the parent conversation
    const baseline = await screen.findByTestId("sibling-baseline");
    expect(baseline).toHaveTextContent(
      "I see two charges; one is a pending authorization that will drop off.",
    );
    await waitFor(() =>
      expect(
        conversationRequests.some((u) => u.searchParams.get("forks_of") === "c2"),
      ).toBe(true),
    );

    // one card per sibling, labeled with the endpoint NAME (GET /endpoints
    // mapping — same labels the re-fire evaluation's columns carry)
    const prodCard = screen.getByTestId("sibling-c2f1");
    await within(prodCard).findByText("prod");
    expect(prodCard).toHaveTextContent(
      "Both charges are temporary holds — the duplicate reverses within 24 hours.",
    );
    expect(prodCard).toHaveTextContent("v15"); // lineage config badge
    const stagingCard = screen.getByTestId("sibling-c2f2");
    await within(stagingCard).findByText("staging");
    expect(stagingCard).toHaveTextContent(
      "One charge is an authorization hold; it is released automatically.",
    );

    // fork of another turn excluded
    expect(screen.queryByTestId("sibling-c2f-other-turn")).not.toBeInTheDocument();
  });

  it("Open in Chat ↗ navigates to the fork; baseline's to the parent", async () => {
    const user = userEvent.setup();
    renderCompare("/forks/c2/t9");
    const stagingCard = await screen.findByTestId("sibling-c2f2");

    await user.click(within(stagingCard).getByText("Open in Chat ↗"));
    await screen.findByText("chat-probe c2f2");
  });

  it("a fork whose regenerated turn has not landed shows generating…", async () => {
    // Copied history only (ends on a user turn) — the regenerated assistant
    // turn is appended when the fork task completes (engine.py:354-363).
    mockForks.c2.push(
      conv({
      id: "c2f-pending",
      created_at: "2026-08-04T09:10:00Z",
      last_activity_at: "2026-08-04T09:10:00Z",
      title: "Billing dispute",
      lineage: {
        parent_conversation_id: "c2",
        fork_turn_id: "t9",
        endpoint_id: "ep_agent1_staging",
      },
      turns: [
        {
          id: "c2fp-t8",
          role: "user",
          author: "user",
          content: "Why was I charged twice for order 4413?",
          created_at: "2026-08-04T08:58:00Z",
          envelope: null,
        },
      ],
      }),
    );
    renderCompare("/forks/c2/t9");

    const card = await screen.findByTestId("sibling-c2f-pending");
    expect(card).toHaveTextContent("generating…");
  });

  it("deleted parent: siblings still compare, and the baseline turn still reads", async () => {
    // Fixture c-orphan's parent c-gone is a TOMBSTONE: it answers 200 with
    // deleted true, and its transcript still reads — so "parent deleted" comes
    // off the flag, not off a 404, and the baseline shows the original turn
    // rather than claiming it is unavailable. That is what the soft delete is
    // FOR: forks keep their lineage and the thing they forked from.
    renderCompare("/forks/c-gone/t1");

    await screen.findByText("parent deleted");
    const orphan = await screen.findByTestId("sibling-c-orphan");
    expect(orphan).toHaveTextContent("generating…"); // no turns stored
    expect(screen.getByTestId("sibling-baseline")).toHaveTextContent(
      "This conversation was deleted.",
    );
    // Deleted takes no new work, so there is nothing to open it FOR.
    expect(screen.queryByText("Open parent")).not.toBeInTheDocument();
  });
});
