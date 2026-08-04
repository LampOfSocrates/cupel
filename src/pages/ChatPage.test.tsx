import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { MantineProvider } from "@mantine/core";
import { ChatPage } from "./ChatPage";
import { App } from "../App";
import { renderApp } from "../test/render";
import { cancelRequests, chatConfig, chatRequests } from "../test/msw/handlers";

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
