import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderApp } from "../test/render";
import {
  adminConversationConfig,
  adminConversationRequests,
  casebookCreates,
  casebookItemPosts,
  mockAdminMe,
  mockCasebooks,
} from "../test/msw/handlers";
import { Shell } from "../shell/Shell";
import { product } from "../lib/product";
import { InspectorPage } from "./InspectorPage";

// Contract under test — P2-T12a Inspector (cupel-phases.md:78 "Inspect every
// conversation in the system as a super user — filter by user, tree, date, or
// score in a dense keyboard-driven table with an inline transcript reader …
// requires the inspect role, audit-logged"):
// - GET /admin/conversations (openapi.yaml:298-348) with user_id / tree /
//   date_from / date_to / score_min / score_max / page / page_size
// - AdminConversationItem's user_id + latest_score columns (:3129-3144)
// - the reader loads GET /agenttrees/{tree}/conversations/{id} for the
//   selected row (admin rows carry no transcript)
// - POST /casebooks/{id}/items (:1732-1757) from the ⊞ action / `a` key
// - role gating: no `inspect` role → no nav entry and no route

function renderInspector(route = "/inspector") {
  return renderApp(
    <Routes>
      <Route path="/inspector" element={<InspectorPage />} />
    </Routes>,
    { route },
  );
}

function lastQuery() {
  return adminConversationRequests[adminConversationRequests.length - 1].searchParams;
}

describe("inspector table", () => {
  it("renders a cross-user row per conversation with owner and latest score", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(3));
    const rows = screen.getAllByTestId("inspector-row");
    expect(within(rows[0]).getByText("u_admin")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Refund escalation")).toBeInTheDocument();
    expect(within(rows[0]).getByLabelText("score 0.92")).toBeInTheDocument();
    expect(within(rows[1]).getByText("gen-persona-2")).toBeInTheDocument();
    // agent2 rows appear too — the Inspector is not scoped to the active tree.
    expect(within(rows[2]).getByText("agent2")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-count")).toHaveTextContent("3 conversations");
  });

  it("requests page 1 with the page size and no filters on first load", async () => {
    renderInspector();
    await waitFor(() => expect(adminConversationRequests).toHaveLength(1));
    const q = lastQuery();
    expect(q.get("page")).toBe("1");
    expect(q.get("page_size")).toBe("25");
    for (const key of ["user_id", "tree", "date_from", "date_to", "score_min", "score_max"]) {
      expect(q.get(key)).toBeNull();
    }
  });

  it("sends the user filter as ?user_id=", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(3));
    fireEvent.change(screen.getByLabelText("User"), { target: { value: "gen-persona-2" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(lastQuery().get("user_id")).toBe("gen-persona-2"));
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(1));
  });

  it("sends the tree filter as ?tree=", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(3));
    // The filter's label and the term itself come from agentic.config.ts
    // product.trees (PW-1); getByRole, not getByLabelText, because the table
    // header carries the same word.
    await userEvent.click(screen.getByRole("combobox", { name: product.tree.One }));
    await userEvent.click(await screen.findByRole("option", { name: "Agent 2" }));
    await waitFor(() => expect(lastQuery().get("tree")).toBe("agent2"));
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(1));
  });

  it("sends the date range as ?date_from= and ?date_to=", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(3));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-04" } });
    await waitFor(() => expect(lastQuery().get("date_from")).toBe("2026-08-04"));
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-04" } });
    await waitFor(() => expect(lastQuery().get("date_to")).toBe("2026-08-04"));
    // c3's last activity is 2026-08-01 — filtered out by the range.
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(2));
  });

  it("sends the score range as ?score_min= and ?score_max=", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(3));
    fireEvent.change(screen.getByLabelText("Score ≥"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Score ≤"), { target: { value: "0.5" } });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(lastQuery().get("score_min")).toBe("0");
      expect(lastQuery().get("score_max")).toBe("0.5");
    });
    // Triage worst-first: only the 0.31 row survives.
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(1));
  });

  it("keeps applied filters in the URL and clears them again", async () => {
    renderInspector("/inspector?user_id=gen-persona-2");
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(1));
    expect(lastQuery().get("user_id")).toBe("gen-persona-2");
    expect((screen.getByLabelText("User") as HTMLInputElement).value).toBe("gen-persona-2");
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(lastQuery().get("user_id")).toBeNull());
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(3));
  });

  it("paginates with ?page=", async () => {
    renderInspector("/inspector?score_min=0");
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(2));
    // page_size is fixed at 25 so the fixtures fit one page — the control
    // still has to be disabled at the ends.
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("explains itself when nothing matches", async () => {
    renderInspector("/inspector?user_id=nobody");
    const empty = await screen.findByTestId("inspector-empty");
    expect(empty.textContent).toMatch(/every conversation in the system, whoever owns it/i);
  });

  it("surfaces a 403 from a backend that withholds the role", async () => {
    adminConversationConfig.forbidden = true;
    renderInspector();
    expect(await screen.findByTestId("inspector-error")).toHaveTextContent(
      "The inspect role is required.",
    );
  });
});

describe("inline transcript reader", () => {
  it("loads the selected conversation's turns beside the table", async () => {
    renderInspector();
    const reader = await screen.findByTestId("inspector-reader");
    // First row is auto-selected; its transcript comes from the tree-scoped
    // conversation endpoint, not from the admin row.
    await waitFor(() => expect(screen.getAllByTestId("reader-turn")).toHaveLength(2));
    expect(within(reader).getByText("How do refunds work?")).toBeInTheDocument();
    expect(within(reader).getByText("Approved refunds land in 3-5 days.")).toBeInTheDocument();
    // The last assistant turn is focused by default — that is what ⊞ collects.
    const turns = screen.getAllByTestId("reader-turn");
    expect(turns[1]).toHaveAttribute("data-focused", "true");
  });

  it("switches transcripts when another row is selected", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(3));
    await userEvent.click(screen.getAllByTestId("inspector-row")[1]);
    expect(
      await screen.findByText("Why was I charged twice for order 4413?"),
    ).toBeInTheDocument();
  });

  it("moves the selection with j and k", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(3));
    expect(screen.getAllByTestId("inspector-row")[0]).toHaveAttribute("data-selected", "true");

    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() =>
      expect(screen.getAllByTestId("inspector-row")[1]).toHaveAttribute("data-selected", "true"),
    );
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() =>
      expect(screen.getAllByTestId("inspector-row")[0]).toHaveAttribute("data-selected", "true"),
    );
    // Clamped at the top — k on the first row is a no-op, never a wrap.
    fireEvent.keyDown(window, { key: "k" });
    expect(screen.getAllByTestId("inspector-row")[0]).toHaveAttribute("data-selected", "true");
  });

  it("ignores j/k while a filter field has focus", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("inspector-row")).toHaveLength(3));
    const field = screen.getByLabelText("User");
    fireEvent.keyDown(field, { key: "j" });
    expect(screen.getAllByTestId("inspector-row")[0]).toHaveAttribute("data-selected", "true");
  });
});

describe("⊞ collect", () => {
  it("posts the focused turn as a reference to the chosen casebook", async () => {
    renderInspector();
    await screen.findByTestId("inspector-reader");
    await waitFor(() => expect(screen.getAllByTestId("reader-turn")).toHaveLength(2));

    await userEvent.click(screen.getByTestId("reader-collect"));
    expect(await screen.findByTestId("collect-target")).toHaveTextContent("agent1 · c1 · t2");
    fireEvent.change(screen.getByLabelText("Note (optional)"), {
      target: { value: "hedged" },
    });
    await userEvent.click(screen.getByRole("button", { name: "⊞ Add" }));

    await waitFor(() => expect(casebookItemPosts).toHaveLength(1));
    expect(casebookItemPosts[0]).toEqual({
      casebookId: "cb-1",
      body: { tree: "agent1", conversation_id: "c1", turn_id: "t2", note: "hedged" },
    });
    expect(await screen.findByTestId("collect-done")).toHaveTextContent(/already in/i);
  });

  it("opens the collect dialog on the `a` key", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("reader-turn")).toHaveLength(2));
    fireEvent.keyDown(window, { key: "a" });
    expect(await screen.findByTestId("collect-target")).toHaveTextContent("agent1 · c1 · t2");
  });

  it("collects the turn the reader focus is on, not always the last one", async () => {
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("reader-turn")).toHaveLength(2));
    await userEvent.click(screen.getAllByTestId("reader-turn")[0]);
    fireEvent.keyDown(window, { key: "a" });
    expect(await screen.findByTestId("collect-target")).toHaveTextContent("agent1 · c1 · t1");
  });

  it("creates a casebook inline and adds the turn to it", async () => {
    mockCasebooks.length = 0;
    renderInspector();
    await waitFor(() => expect(screen.getAllByTestId("reader-turn")).toHaveLength(2));
    fireEvent.keyDown(window, { key: "a" });
    expect(await screen.findByTestId("collect-empty")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("New casebook name"), {
      target: { value: "Weekend triage" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Create + add" }));

    await waitFor(() => expect(casebookCreates).toEqual([{ name: "Weekend triage" }]));
    await waitFor(() => expect(casebookItemPosts).toHaveLength(1));
    expect(casebookItemPosts[0].body).toEqual({
      tree: "agent1",
      conversation_id: "c1",
      turn_id: "t2",
      note: null,
    });
    expect(await screen.findByTestId("collect-done")).toHaveTextContent("Added to Weekend triage");
  });
});

describe("role gating (never mode gating)", () => {
  const renderShell = (me: typeof mockAdminMe) =>
    renderApp(
      <Routes>
        <Route element={<Shell />}>
          <Route path="*" element={<div />} />
        </Route>
      </Routes>,
      { route: "/chat", queue: true, me },
    );

  it("shows the Inspector nav entry when /me.roles includes inspect", async () => {
    renderShell(mockAdminMe);
    expect(await screen.findByRole("link", { name: "Inspector" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Casebooks" })).toBeInTheDocument();
  });

  it("hides it when the role is absent", async () => {
    renderShell({ ...mockAdminMe, roles: [] });
    expect(await screen.findByRole("link", { name: "Casebooks" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Inspector" })).not.toBeInTheDocument();
  });
});
