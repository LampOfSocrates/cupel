import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationList } from "./ConversationList";
import { renderApp } from "../test/render";
import { conversationRequests } from "../test/msw/handlers";

describe("ConversationList", () => {
  it("renders the root conversations with relative times", async () => {
    renderApp(<ConversationList tree="agent1" />);
    expect(await screen.findByText("Refund escalation")).toBeInTheDocument();
    expect(screen.getByText("Billing dispute")).toBeInTheDocument();
    expect(screen.getByText("Onboarding help")).toBeInTheDocument();
    // First fetch is the default listing — roots only, no forks_of
    const url = conversationRequests[0];
    expect(url.pathname).toBe("/agenttrees/agent1/conversations");
    expect(url.searchParams.get("forks_of")).toBeNull();
  });

  it("search box triggers ?search= after debounce and filters the list", async () => {
    const user = userEvent.setup();
    renderApp(<ConversationList tree="agent1" />);
    await screen.findByText("Refund escalation");

    await user.type(screen.getByPlaceholderText("Search"), "billing");
    await waitFor(() => {
      const last = conversationRequests.at(-1)!;
      expect(last.searchParams.get("search")).toBe("billing");
    });
    await waitFor(() => {
      expect(screen.queryByText("Refund escalation")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Billing dispute")).toBeInTheDocument();
  });

  it("expanding the fork chip calls ?forks_of= and nests forks with lineage badges", async () => {
    const user = userEvent.setup();
    renderApp(<ConversationList tree="agent1" />);
    await screen.findByText("Billing dispute");

    await user.click(screen.getByRole("button", { name: /2 forks/ }));
    await waitFor(() => {
      const forkReq = conversationRequests.find((u) => u.searchParams.get("forks_of") === "c2");
      expect(forkReq).toBeDefined();
    });
    // Lineage badges per fork (feature-spec.md:5; sketch 07 "↳ prod · v15").
    // Fixture endpoint ids use the ep_agent1_* form of the endpoint fixtures
    // (normalized in P1-T14); the badge shows the id verbatim (T13 choice —
    // no per-fork GET /endpoints).
    expect(await screen.findByText("ep_agent1_prod · v15")).toBeInTheDocument();
    expect(screen.getByText("ep_agent1_staging · v15")).toBeInTheDocument();
  });
});
