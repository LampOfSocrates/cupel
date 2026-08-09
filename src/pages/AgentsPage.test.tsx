import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderApp, testAppState } from "../test/render";
import {
  agentCreateRequests,
  conversationRequests,
  mockAgents,
} from "../test/msw/handlers";
import { AgentsPage } from "./AgentsPage";
import { EditorPage } from "./EditorPage";
import { AgentConversationsPage } from "./AgentConversationsPage";

// Contract under test:
// - GET /agenttrees/{tree}/agents — "Flat list of agents with parent links
//   (root has parent_id null)" (openapi.yaml:188) → nested diagram.
// - Node shows "agent name, live instruction version, tools attached (icons),
//   enabled state" (feature-spec.md:25).
// - "Node click → instruction editor"; ⋯ menu: edit / add sub-agent / view
//   recent conversations (feature-spec.md:26).
// - POST → 201 agent with live_version 0 (openapi.yaml:215).

function renderAgents(route = "/agents") {
  return renderApp(
    <Routes>
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/agents/:agentId/editor" element={<EditorPage />} />
      <Route path="/agents/:agentId/conversations" element={<AgentConversationsPage />} />
    </Routes>,
    { route },
  );
}

describe("AgentsPage tree view", () => {
  it("nests the flat parent-linked list: Concierge → Refunds/Shipping", async () => {
    renderAgents();
    const root = await screen.findByTestId("agent-ag_concierge");
    // children render inside the root's subtree container
    expect(within(root).getByText("Refunds")).toBeInTheDocument();
    expect(within(root).getByText("Shipping")).toBeInTheDocument();
    // and not the other way round
    const refunds = screen.getByTestId("agent-ag_refunds");
    expect(within(refunds).queryByText("Concierge")).not.toBeInTheDocument();
  });

  it("shows live version badge and tool chips per node", async () => {
    renderAgents();
    const root = await screen.findByTestId("agent-ag_concierge");
    const rootCard = within(root).getByRole("button", { name: "Open Concierge" });
    expect(within(rootCard).getByText("v3")).toBeInTheDocument();
    expect(within(rootCard).getByText(/search_kb/)).toBeInTheDocument();
    const refundsCard = screen.getByRole("button", { name: "Open Refunds" });
    expect(within(refundsCard).getByText("v1")).toBeInTheDocument();
    expect(within(refundsCard).getByText(/lookup_order/)).toBeInTheDocument();
    expect(within(refundsCard).getByText(/refund$/)).toBeInTheDocument();
  });

  it("dims a disabled agent and badges it", async () => {
    mockAgents.agent1 = mockAgents.agent1.map((a) =>
      a.id === "ag_shipping" ? { ...a, enabled: false } : a,
    );
    renderAgents();
    const card = await screen.findByRole("button", { name: "Open Shipping" });
    expect(card.style.opacity).toBe("0.5");
    expect(within(card).getByText("disabled")).toBeInTheDocument();
  });

  it("node click navigates to the editor route for that agent", async () => {
    const user = userEvent.setup();
    renderAgents();
    await user.click(await screen.findByRole("button", { name: "Open Refunds" }));
    expect(
      await screen.findByText("Instruction editor — ag_refunds"),
    ).toBeInTheDocument();
  });

  it("⋯ Edit instructions navigates to the editor route", async () => {
    const user = userEvent.setup();
    renderAgents();
    await user.click(await screen.findByRole("button", { name: "Actions for Shipping" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit instructions" }));
    expect(
      await screen.findByText("Instruction editor — ag_shipping"),
    ).toBeInTheDocument();
  });

  it("⋯ Add sub-agent posts {name, parent_id, tools, format} and shows the v0 node", async () => {
    const user = userEvent.setup();
    renderAgents();
    await user.click(await screen.findByRole("button", { name: "Actions for Shipping" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add sub-agent" }));
    expect(await screen.findByText("Add sub-agent under Shipping")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Name/), "Returns");
    // TagsInput's visible field is role=combobox (Combobox-based); its label
    // also hits a hidden input, so query by role, not label.
    await user.type(
      screen.getByRole("combobox", { name: "Tools (optional)" }),
      "check_label{Enter}",
    );
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect(agentCreateRequests).toEqual([
      { name: "Returns", parent_id: "ag_shipping", tools: ["check_label"], format: "text" },
    ]);
    // tree refreshed: new node nested under Shipping, in the v0 "no versions
    // yet" state (openapi.yaml:215)
    const shipping = await screen.findByTestId("agent-ag_shipping");
    const returnsCard = within(shipping).getByRole("button", { name: "Open Returns" });
    expect(within(returnsCard).getByText("no versions yet")).toBeInTheDocument();
  });

  it("⋯ View recent conversations lists ?agent_id=-filtered conversations", async () => {
    const user = userEvent.setup();
    renderAgents();
    await user.click(await screen.findByRole("button", { name: "Actions for Refunds" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "View recent conversations" }),
    );
    expect(
      await screen.findByText("Recent conversations — ag_refunds"),
    ).toBeInTheDocument();
    // fixture c1 is ag_refunds; c2/c3 are ag_concierge and must not appear
    expect(await screen.findByText("Refund escalation")).toBeInTheDocument();
    expect(screen.queryByText("Billing dispute")).not.toBeInTheDocument();
    const last = conversationRequests[conversationRequests.length - 1];
    expect(last.searchParams.get("agent_id")).toBe("ag_refunds");
  });

  it("empty tree offers Add root agent (parent_id null POST)", async () => {
    mockAgents.agent1 = [];
    const user = userEvent.setup();
    renderAgents();
    await user.click(await screen.findByRole("button", { name: "Add root agent" }));
    await user.type(await screen.findByLabelText(/Name/), "Root");
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(agentCreateRequests).toEqual([
      { name: "Root", parent_id: null, tools: [], format: "text" },
    ]);
    const card = await screen.findByRole("button", { name: "Open Root" });
    expect(within(card).getByText("no versions yet")).toBeInTheDocument();
  });

  it("renders the second tree when AppContext.tree is agent2", async () => {
    testAppState.tree = "agent2";
    try {
      renderAgents();
      const root = await screen.findByTestId("agent-ag_ops");
      expect(within(root).getByText("Deploys")).toBeInTheDocument();
    } finally {
      testAppState.tree = "agent1";
    }
  });
});
