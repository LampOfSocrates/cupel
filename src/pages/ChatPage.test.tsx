import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { MantineProvider } from "@mantine/core";
import { ChatPage } from "./ChatPage";
import { App } from "../App";
import { renderApp } from "../test/render";
import {
  cancelRequests,
  chatConfig,
  chatRequests,
  feedbackRequests,
  judgmentRequests,
  mockJudgments,
  pushHumanJudgment,
} from "../test/msw/handlers";

// Contract under test (openapi.yaml:466-476): SSE events task/token/done/
// error; done status cancelled "carries the partial content generated so far,
// which IS persisted". Stop = DELETE /tasks/{task_id} (openapi.yaml:835-839).

function renderChat(route: string) {
  return renderApp(
    <Routes>
      <Route path="/chat" element={<ChatPage />} />
      <Route path="/chat/:conversationId" element={<ChatPage />} />
    </Routes>,
    { route },
  );
}

// Deterministic stream stepping: each token (and the final done) awaits a gate.
function installGate() {
  const pending: Array<() => void> = [];
  chatConfig.gate = () => new Promise<void>((resolve) => pending.push(resolve));
  return {
    release: async () => {
      await waitFor(() => expect(pending.length).toBeGreaterThan(0));
      pending.shift()!();
    },
  };
}

describe("ChatPage streaming", () => {
  it("renders tokens incrementally, then the done turn replaces the stream", async () => {
    const gate = installGate();
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?"); // history via GET conversation

    await user.type(screen.getByPlaceholderText("Message…"), "Tell me more");
    await user.click(screen.getByRole("button", { name: "Send" }));
    // user turn appears immediately
    expect(screen.getByText("Tell me more")).toBeInTheDocument();

    await gate.release(); // token 1
    const streaming = await screen.findByTestId("streaming-turn");
    await waitFor(() => expect(streaming).toHaveTextContent("Hello"));
    expect(streaming).not.toHaveTextContent("world"); // incremental, not all at once

    await gate.release(); // token 2
    await waitFor(() => expect(streaming).toHaveTextContent("Hello streaming"));

    await gate.release(); // token 3
    await gate.release(); // done
    await waitFor(() =>
      expect(screen.queryByTestId("streaming-turn")).not.toBeInTheDocument(),
    );
    const transcript = screen.getByTestId("transcript");
    expect(transcript).toHaveTextContent("Hello streaming world.");
    // markdown rendered (feature-spec.md:10): **world** → <strong>
    expect(transcript.querySelector("strong")?.textContent).toBe("world");
    // stream replaced by the final turn, not duplicated
    expect(transcript.textContent!.match(/Hello streaming/g)).toHaveLength(1);
  });

  it("stop calls DELETE /tasks/{task_id}; done(cancelled) keeps the partial turn", async () => {
    const gate = installGate();
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    await user.type(screen.getByPlaceholderText("Message…"), "stream then stop");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await gate.release(); // token 1 → partial "Hello "
    const streaming = await screen.findByTestId("streaming-turn");
    await waitFor(() => expect(streaming).toHaveTextContent("Hello"));

    await user.click(screen.getByRole("button", { name: "Stop generation" }));
    await waitFor(() => expect(cancelRequests).toContain("task-c1"));

    await gate.release(); // handler notices the cancel → done(cancelled)
    await waitFor(() =>
      expect(screen.queryByTestId("streaming-turn")).not.toBeInTheDocument(),
    );
    // partial content persisted and still rendered (openapi.yaml:1470)
    const transcript = screen.getByTestId("transcript");
    expect(transcript).toHaveTextContent("Hello");
    expect(transcript).not.toHaveTextContent("world");
    // back out of streaming mode
    expect(screen.queryByRole("button", { name: "Stop generation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("renders an inline error state on an SSE error event", async () => {
    chatConfig.errorAfter = 1; // one token, then event: error
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    await user.type(screen.getByPlaceholderText("Message…"), "will fail");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("model exploded")).toBeInTheDocument();
    expect(screen.getByText("Generation failed")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId("streaming-turn")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("fresh send omits conversation_id, navigates to the new conversation and the sidebar shows it", async () => {
    const user = userEvent.setup();
    // Full App: real boot (/me + /agenttrees), Shell sidebar + ChatPage.
    render(
      <MantineProvider>
        <MemoryRouter initialEntries={["/chat"]}>
          <App />
        </MemoryRouter>
      </MantineProvider>,
    );
    await screen.findByText("Refund escalation"); // sidebar loaded

    await user.type(screen.getByPlaceholderText("Message…"), "Hi there{enter}");
    await waitFor(() => expect(chatRequests).toHaveLength(1));
    // "Omitting conversation_id starts a new conversation" (openapi.yaml:488)
    expect(chatRequests[0].conversation_id).toBeUndefined();

    // stream completes into the transcript (no refetch wiped it)
    await waitFor(() =>
      expect(screen.getByTestId("transcript")).toHaveTextContent("Hello streaming world."),
    );
    // sidebar reflects the new conversation: "Hi there" as user bubble + list row
    await waitFor(() => expect(screen.getAllByText("Hi there")).toHaveLength(2));
  });
});

// P1-T03 — turn actions. Contract: POST /feedback {message_id, rating}
// (openapi.yaml:1475-1480), returns the appended type:human Judgment
// (openapi.yaml:578-582); reload state via GET /eval/judgments filtered by
// conversation_id, "newest first" (openapi.yaml:966-968, :994); "copy copies
// raw markdown" (feature-spec.md:276).
describe("Turn actions", () => {
  it("thumb click posts {message_id, rating} and shows the selected state; re-click re-posts (append-only)", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("Approved refunds land in 3-5 days.");

    const up = screen.getByRole("button", { name: "Thumbs up" });
    const down = screen.getByRole("button", { name: "Thumbs down" });
    expect(up).toHaveAttribute("aria-pressed", "false");

    await user.click(up);
    // message_id = Turn.id (openapi.yaml:1479 / feature-spec.md:276)
    await waitFor(() => expect(feedbackRequests).toHaveLength(1));
    expect(feedbackRequests[0]).toEqual({ message_id: "t2", rating: "up" });
    expect(up).toHaveAttribute("aria-pressed", "true");
    expect(down).toHaveAttribute("aria-pressed", "false");

    // switching the vote posts again — appends, never edits
    await user.click(down);
    await waitFor(() => expect(feedbackRequests).toHaveLength(2));
    expect(feedbackRequests[1]).toEqual({ message_id: "t2", rating: "down" });
    expect(down).toHaveAttribute("aria-pressed", "true");
    expect(up).toHaveAttribute("aria-pressed", "false");

    // same-thumb re-click: no un-vote endpoint exists — just re-post
    await user.click(down);
    await waitFor(() => expect(feedbackRequests).toHaveLength(3));
    expect(down).toHaveAttribute("aria-pressed", "true");
  });

  it("reload derives thumbs from judgment history — latest human judgment wins, llm ignored", async () => {
    pushHumanJudgment("t2", "c1", "down", "2026-08-03T10:00:00Z");
    pushHumanJudgment("t2", "c1", "up", "2026-08-04T10:00:00Z"); // newest
    // llm judgments share the store but never drive thumbs (openapi.yaml:1899)
    mockJudgments.unshift({
      id: "j-llm-1",
      case_id: "case1",
      run_id: "run1",
      turn_id: "t2",
      conversation_id: "c1",
      type: "llm",
      judge_model: "gpt-judge",
      rubric_id: "r1",
      rubric_version: 1,
      score: 0,
      reasoning: "meh",
      created_at: "2026-08-04T11:00:00Z",
    });

    renderChat("/chat/c1");
    await screen.findByText("Approved refunds land in 3-5 days.");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Thumbs up" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(screen.getByRole("button", { name: "Thumbs down" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    // one judgments call for the whole transcript, conversation_id filter
    // (openapi.yaml:983-985)
    const calls = judgmentRequests.filter(
      (u) => u.searchParams.get("conversation_id") === "c1",
    );
    expect(calls).toHaveLength(1);
  });

  it("copy puts the turn's raw markdown on the clipboard and confirms", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    // stream a markdown reply to completion (tokens "Hello streaming **world**.")
    await user.type(screen.getByPlaceholderText("Message…"), "md please");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByTestId("transcript")).toHaveTextContent("Hello streaming world."),
    );

    const copyButtons = screen.getAllByRole("button", { name: "Copy message" });
    expect(copyButtons).toHaveLength(2); // t2 + the streamed turn
    await user.click(copyButtons[1]);
    // raw markdown, asterisks intact — not the rendered HTML text
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("Hello streaming **world**."),
    );
    // copied confirmation state
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("no action row on the streaming draft; actions appear once done arrives", async () => {
    const gate = installGate();
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");
    expect(screen.getAllByRole("button", { name: "Thumbs up" })).toHaveLength(1); // t2 only

    await user.type(screen.getByPlaceholderText("Message…"), "stream it");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await gate.release(); // token 1
    const streaming = await screen.findByTestId("streaming-turn");
    await waitFor(() => expect(streaming).toHaveTextContent("Hello"));
    // the in-flight draft bubble carries no actions at all
    expect(within(streaming).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: "Thumbs up" })).toHaveLength(1);

    await gate.release(); // token 2
    await gate.release(); // token 3
    await gate.release(); // done
    await waitFor(() =>
      expect(screen.queryByTestId("streaming-turn")).not.toBeInTheDocument(),
    );
    // the completed turn gets its action row immediately
    expect(screen.getAllByRole("button", { name: "Thumbs up" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(2);
  });
});
