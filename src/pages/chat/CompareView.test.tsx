import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { ChatPage } from "../ChatPage";
import { RunDetailPage } from "../RunDetailPage";
import { api } from "../../api/client";
import { renderApp, type AppStateOverrides } from "../../test/render";
import { mockEndpoints, mockMe, replayTurnRequests } from "../../test/msw/handlers";

// PAB-1 — A/B compare in chat within one backend (docs/plan-ab-compare.md §3).
// The four things the plan pins: the `tune` gate (§3 "Do not invent a 'dev'
// role"), the column cap (§5.3), the cost warning BEFORE the send (§5.2), and
// "the result IS a run" — the fan-out lands in the existing grid unchanged
// (§2a).

function renderChat(route = "/chat/c1", overrides: AppStateOverrides = {}) {
  return renderApp(
    <Routes>
      <Route path="/chat" element={<ChatPage />} />
      <Route path="/chat/:conversationId" element={<ChatPage />} />
      <Route path="/runs/:runId" element={<RunDetailPage />} />
    </Routes>,
    { route, ...overrides },
  );
}

async function enterCompare(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText("How do refunds work?"); // history loaded
  await user.click(screen.getByLabelText("Compare"));
  await screen.findByTestId("compare-cost-warning");
}

describe("chat compare mode — permission gate", () => {
  it("is invisible without tune on the active tree", async () => {
    renderChat("/chat/c1", { me: { ...mockMe, permissions: { agent1: ["view"] } } });
    await screen.findByText("How do refunds work?");
    expect(screen.queryByTestId("compare-toggle")).not.toBeInTheDocument();
  });

  it("appears with tune — the existing permission decides, no new role", async () => {
    // mockMe holds view+tune+evaluate on agent1 and view only on agent2.
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");
    expect(screen.getByTestId("compare-toggle")).toBeInTheDocument();
  });

  it("leaves the single-column transcript untouched while off", async () => {
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");
    expect(screen.getByTestId("transcript")).toBeInTheDocument();
    expect(screen.queryByTestId("compare-transcript")).not.toBeInTheDocument();
  });
});

describe("chat compare mode — cost warning", () => {
  it("says N variants = N generations = N bills before anything is sent", async () => {
    const user = userEvent.setup();
    renderChat();
    await enterCompare(user);
    // agent1 deploys to prod + staging → baseline + 2 endpoints = 3 columns.
    expect(screen.getByTestId("compare-cost-warning")).toHaveTextContent(
      "3 variants — 3 generations, 3 bills",
    );
    // "before the send, not after" (plan §5.2): nothing has been sent yet.
    expect(screen.queryByTestId("compare-columns")).not.toBeInTheDocument();
    expect(replayTurnRequests).toHaveLength(0);
  });

  it("counts the baseline reply as one of the bills", async () => {
    const seeded = mockEndpoints.agent1;
    mockEndpoints.agent1 = [seeded[0]];
    try {
      const user = userEvent.setup();
      renderChat();
      await enterCompare(user);
      // One endpoint to fan out to, but the shared turn is generated too —
      // two generations, and the warning must say so.
      expect(screen.getByTestId("compare-cost-warning")).toHaveTextContent(
        "2 variants — 2 generations, 2 bills",
      );
      expect(screen.queryByTestId("compare-cap-hint")).not.toBeInTheDocument();
    } finally {
      mockEndpoints.agent1 = seeded;
    }
  });
});

describe("chat compare mode — column cap", () => {
  it("never exceeds three columns and points at Runs instead", async () => {
    const seeded = mockEndpoints.agent1;
    mockEndpoints.agent1 = [...seeded, { id: "ep_agent1_canary", name: "canary" }];
    try {
      const user = userEvent.setup();
      renderChat();
      await enterCompare(user);

      // Three deploy targets exist, but the picker stops at MAX-1 endpoints.
      expect(screen.getByTestId("compare-cost-warning")).toHaveTextContent("3 variants");
      expect(screen.queryByRole("button", { name: "Remove canary" })).not.toBeInTheDocument();
      expect(screen.getByTestId("compare-cap-hint")).toHaveTextContent("use Runs");

      await user.type(screen.getByPlaceholderText("Message…"), "which is best?");
      await user.click(screen.getByRole("button", { name: "Send" }));
      const columns = await screen.findByTestId("compare-columns");
      expect(columns.children).toHaveLength(3);
      await waitFor(() => expect(replayTurnRequests).toHaveLength(1));
      expect(replayTurnRequests[0].body.endpoints).toHaveLength(2);
    } finally {
      mockEndpoints.agent1 = seeded;
    }
  });
});

describe("chat compare mode — the result IS a run", () => {
  it("fans one send out server-side and opens it in the existing grid", async () => {
    const user = userEvent.setup();
    renderChat();
    await enterCompare(user);

    await user.type(screen.getByPlaceholderText("Message…"), "Which is better?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The shared user turn sits above the columns (plan §3).
    expect(await screen.findByTestId("compare-prompt")).toHaveTextContent("Which is better?");
    // Column 0 = the baseline reply, streamed by POST /chat.
    await waitFor(() =>
      expect(screen.getByTestId("compare-column-baseline")).toHaveTextContent(
        "Hello streaming world.",
      ),
    );

    // ONE server-side fan-out on the shared turn — not a request per column.
    await waitFor(() => expect(replayTurnRequests).toHaveLength(1));
    expect(replayTurnRequests[0].tree).toBe("agent1");
    expect(replayTurnRequests[0].body.conversation_id).toBe("c1");
    expect(replayTurnRequests[0].body.endpoints).toEqual([
      "ep_agent1_prod",
      "ep_agent1_staging",
    ]);

    // The run is listed by the plain runs endpoint the Runs page reads.
    const listed = await api.runs("agent1");
    expect(listed.some((r) => r.label === "Re-fire · 2 endpoint(s)")).toBe(true);

    // …and the existing comparison grid renders it with no new code.
    await user.click(await screen.findByTestId("compare-run-link"));
    const grid = await screen.findByTestId("comparison-grid");
    expect(within(grid).getAllByText("baseline").length).toBeGreaterThan(0);
    expect(within(grid).getByText("prod")).toBeInTheDocument();
    expect(within(grid).getByText("staging")).toBeInTheDocument();
  });

  it("leaving compare mode returns to the single conversation", async () => {
    const user = userEvent.setup();
    renderChat();
    await enterCompare(user);
    expect(screen.getByTestId("compare-transcript")).toBeInTheDocument();
    await user.click(screen.getByLabelText("Compare"));
    await waitFor(() => expect(screen.getByTestId("transcript")).toBeInTheDocument());
    expect(screen.queryByTestId("compare-transcript")).not.toBeInTheDocument();
  });
});
