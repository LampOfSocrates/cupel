import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { MantineProvider } from "@mantine/core";
import { ChatPage } from "./ChatPage";
import { App } from "../App";
import { setSseEnabled } from "../api/backendPrefs";
import { http, HttpResponse } from "msw";
import { renderApp } from "../test/render";
import { server } from "../test/msw/server";
import {
  BASE,
  cancelRequests,
  chatConfig,
  chatRequests,
  feedbackRequests,
  judgmentRequests,
  llmHeaderCaptures,
  mockJudgments,
  modelsRequests,
  pushHumanJudgment,
  replayTurnRequests,
  uploadConfig,
  uploadRequests,
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

  // P2-T17 — the Settings → Backend SSE toggle (feature-spec.md:160 "SSE
  // streaming on/off") drives ChatRequest.stream; off → the T02 JSON path
  // renders the full reply ("the UI degrades gracefully to non-streaming when
  // the SSE toggle is off in mock options", skein-phases.md:43).
  it("sends stream:false when the device-local SSE flag is off and renders the full JSON reply", async () => {
    setSseEnabled(false);
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    await user.type(screen.getByPlaceholderText("Message…"), "No stream please");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(chatRequests).toHaveLength(1));
    expect(chatRequests[0].stream).toBe(false); // MSW wire capture
    // Full reply lands at once via the JSON ChatResponse.
    await waitFor(() =>
      expect(screen.getByTestId("transcript")).toHaveTextContent("Hello streaming world."),
    );
    expect(screen.queryByTestId("streaming-turn")).not.toBeInTheDocument();
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
      <MantineProvider env="test">
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

// P1-T04 — composer attachments. Contract: POST /upload multipart {file} →
// 201 Attachment, "reference its id in ChatRequest.attachments"
// (openapi.yaml:550, :1421-1424); oversize → 413 and "the UI surfaces the
// message" (openapi.yaml:535-536); UI spec: "attach images and files
// (attachment chips, removable before send)" (feature-spec.md:12);
// "multipart upload to /upload before send" (feature-spec.md:277).
describe("Composer attachments", () => {
  // Picks files via the hidden FileButton input (display:none, so
  // fireEvent.change instead of userEvent.upload's visibility-checked click).
  function pickFiles(files: File[]) {
    fireEvent.change(screen.getByLabelText("Attach files input"), {
      target: { files },
    });
  }

  // Global File/FormData are patched to fetch-realm classes in
  // src/test/setup.ts so multipart bodies survive Node's fetch.
  const makeFile = (content: string, name: string, type: string) =>
    new File([content], name, { type });

  it("attach uploads immediately, shows a chip with filename+size, and gates send until settled", async () => {
    const gates: Array<() => void> = [];
    uploadConfig.gate = () => new Promise<void>((r) => gates.push(r));
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    pickFiles([makeFile("hello", "notes.txt", "text/plain")]);
    // upload fired immediately on pick — before any send
    await waitFor(() => expect(uploadRequests).toHaveLength(1));
    expect(uploadRequests[0]).toEqual({ filename: "notes.txt", size: 5 });
    // pending chip: filename + human size, uploading spinner
    const chips = await screen.findByTestId("pending-attachments");
    expect(chips).toHaveTextContent("notes.txt (5 B)");
    expect(within(chips).getByTestId("chip-uploading")).toBeInTheDocument();

    // send disabled until the in-flight upload settles (design choice:
    // disabled, not queued — spec sequences upload BEFORE send)
    await user.type(screen.getByPlaceholderText("Message…"), "See attachment");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    gates.shift()!(); // server responds 201
    await waitFor(() =>
      expect(within(chips).queryByTestId("chip-uploading")).not.toBeInTheDocument(),
    );
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeEnabled();
    await user.click(send);

    // ChatRequest.attachments = uploaded ids (openapi.yaml:1423)
    await waitFor(() => expect(chatRequests).toHaveLength(1));
    expect(chatRequests[0].attachments).toEqual(["att-1"]);
    // chips cleared after send; the user turn bubble renders the chip instead
    expect(screen.queryByTestId("pending-attachments")).not.toBeInTheDocument();
    const transcript = screen.getByTestId("transcript");
    expect(within(transcript).getByText(/notes\.txt/)).toBeInTheDocument();
  });

  it("multi-file: removing one chip excludes its id from the send", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    // sequential picks → deterministic ids: a.txt = att-1, b.txt = att-2
    pickFiles([makeFile("aa", "a.txt", "text/plain")]);
    await waitFor(() => expect(uploadRequests).toHaveLength(1));
    pickFiles([makeFile("bbb", "b.txt", "text/plain")]);
    await waitFor(() => expect(uploadRequests).toHaveLength(2));
    const chips = screen.getByTestId("pending-attachments");
    await waitFor(() =>
      expect(within(chips).queryByTestId("chip-uploading")).not.toBeInTheDocument(),
    );

    // remove a.txt before send (feature-spec.md:12 "removable before send")
    await user.click(screen.getByRole("button", { name: "Remove a.txt" }));
    expect(within(chips).queryByText(/a\.txt/)).not.toBeInTheDocument();
    expect(within(chips).getByText(/b\.txt/)).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Message…"), "just b{enter}");
    await waitFor(() => expect(chatRequests).toHaveLength(1));
    expect(chatRequests[0].attachments).toEqual(["att-2"]);
  });

  it("413 surfaces the server message on the chip and the file is never sent", async () => {
    uploadConfig.maxBytes = 10; // simulate the server-side Phase-1 limit
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    pickFiles([makeFile("x".repeat(50), "big.bin", "application/octet-stream")]);
    // the server's error message, verbatim (openapi.yaml:535-536)
    expect(
      await screen.findByText("File exceeds the 0 MB upload limit."),
    ).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Message…"), "oversize{enter}");
    await waitFor(() => expect(chatRequests).toHaveLength(1));
    // no attachments key at all — the failed file was never added
    expect(chatRequests[0].attachments).toBeUndefined();
    expect(screen.queryByTestId("pending-attachments")).not.toBeInTheDocument();
  });

  it("renders stored attachments on a user turn from Turn.attachments", async () => {
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");
    // fixture turn t1 carries spec.pdf (openapi.yaml:1313-1315)
    const transcript = screen.getByTestId("transcript");
    expect(within(transcript).getByText(/spec\.pdf/)).toBeInTheDocument();
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

// P1-T05 — chat settings submenu. Spec: "Chat has its own Settings submenu
// (model, temperature, system prompt — session-scoped)" (feature-spec.md:7);
// "session-scoped, sent with each /chat call" (feature-spec.md:278); model
// dropdown fed by GET /models (feature-spec.md:122). Contract: ChatRequest
// model/temperature/system_prompt are nullable — untouched settings are
// OMITTED from the body, never sent as null (openapi.yaml:1425-1430).
describe("Chat settings", () => {
  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Chat settings" }));
  }

  // Role queries, not label queries: Mantine associates the label with the
  // visible input AND the hidden form input; the dropdown also mounts async.
  async function pickModel(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(await screen.findByRole("combobox", { name: "Model" }));
    await user.click(await screen.findByRole("option", { name }));
  }

  it("sends exactly the settings the user set on the next chat call", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    await openSettings(user);
    await pickModel(user, "Claude Haiku 4.5");
    await user.type(screen.getByRole("textbox", { name: "Temperature" }), "0.7");
    await user.type(screen.getByRole("textbox", { name: "System prompt" }), "Be terse.");

    await user.type(screen.getByPlaceholderText("Message…"), "hi{enter}");
    await waitFor(() => expect(chatRequests).toHaveLength(1));
    expect(chatRequests[0].model).toBe("claude-haiku-4-5");
    expect(chatRequests[0].temperature).toBe(0.7);
    expect(chatRequests[0].system_prompt).toBe("Be terse.");
  });

  it("untouched settings are absent from the body — not null (openapi.yaml:1425-1430)", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    await openSettings(user);
    await pickModel(user, "DeepSeek V3");

    await user.type(screen.getByPlaceholderText("Message…"), "model only{enter}");
    await waitFor(() => expect(chatRequests).toHaveLength(1));
    expect(chatRequests[0].model).toBe("deepseek-v3");
    // chatRequests holds the JSON-parsed wire body: absent means never sent
    expect("temperature" in chatRequests[0]).toBe(false);
    expect("system_prompt" in chatRequests[0]).toBe(false);
  });

  it("settings persist across conversation switches within the session", async () => {
    const user = userEvent.setup();
    render(
      <MantineProvider env="test">
        <MemoryRouter initialEntries={["/chat/c1"]}>
          <App />
        </MemoryRouter>
      </MantineProvider>,
    );
    await screen.findByText("How do refunds work?");
    await screen.findByText("Billing dispute"); // sidebar loaded

    await openSettings(user);
    await pickModel(user, "Claude Haiku 4.5");
    // deviation indication: summary appears next to the gear (annotated
    // 01-chat.svg shows "model · temp" beside "⚙")
    expect(screen.getByTestId("chat-settings-summary")).toHaveTextContent("Claude Haiku 4.5");

    // switch conversation via the sidebar — settings are session-scoped,
    // not per-conversation (feature-spec.md:7)
    await user.click(screen.getByText("Billing dispute"));
    // c2's transcript loaded (fixture turns added in P1-T14)
    await screen.findByText("Why was I charged twice for order 4413?");
    expect(screen.getByTestId("chat-settings-summary")).toHaveTextContent("Claude Haiku 4.5");

    await user.type(screen.getByPlaceholderText("Message…"), "still custom{enter}");
    await waitFor(() => expect(chatRequests).toHaveLength(1));
    expect(chatRequests[0].conversation_id).toBe("c2");
    expect(chatRequests[0].model).toBe("claude-haiku-4-5");
  });

  it("reset to defaults clears settings from the next request and hides the indication", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    await openSettings(user);
    await pickModel(user, "Gemini Flash");
    await user.type(screen.getByRole("textbox", { name: "Temperature" }), "1.5");
    await user.type(screen.getByPlaceholderText("Message…"), "custom{enter}");
    await waitFor(() => expect(chatRequests).toHaveLength(1));
    expect(chatRequests[0].model).toBe("gemini-flash");
    expect(chatRequests[0].temperature).toBe(1.5);

    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    await waitFor(() =>
      expect(screen.queryByTestId("chat-settings-summary")).not.toBeInTheDocument(),
    );

    await user.type(screen.getByPlaceholderText("Message…"), "default again{enter}");
    await waitFor(() => expect(chatRequests).toHaveLength(2));
    expect("model" in chatRequests[1]).toBe(false);
    expect("temperature" in chatRequests[1]).toBe(false);
    expect("system_prompt" in chatRequests[1]).toBe(false);
  });

  it("GET /models is fetched once and cached for the session", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    await openSettings(user);
    expect(await screen.findByRole("combobox", { name: "Model" })).toBeInTheDocument();
    await waitFor(() => expect(modelsRequests).toHaveLength(1));
    // close by clicking outside the popover
    await user.click(screen.getByText("How do refunds work?"));
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "Model" })).not.toBeInTheDocument(),
    );

    await openSettings(user);
    // options served from the context cache — no second request
    await user.click(await screen.findByRole("combobox", { name: "Model" }));
    expect(await screen.findByRole("option", { name: "Claude Sonnet 5" })).toBeInTheDocument();
    expect(modelsRequests).toHaveLength(1);
  });
});

// P1-T11a — envelope affordance on turns. "every turn records its context
// (date, timezone, region) at generation" (skein-phases.md:25); envelope on
// turn objects in conversation listings (feature-spec.md:81). Sketch 01 shows
// no envelope UI, so the surface is a hover tooltip on each turn's timestamp
// showing the EnvelopeChip.
describe("Turn envelope affordance", () => {
  it("hovering a turn timestamp reveals the EnvelopeChip with the stored envelope", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    // fixture turn t2 created_at 2026-08-04T09:58:00Z; the timestamp text is
    // locale-dependent, so target it via the transcript's meta rows.
    const transcript = screen.getByTestId("transcript");
    const timestamps = within(transcript)
      .getAllByText(/2026|08|04/, { exact: false })
      .filter((el) => el.style.cursor === "help");
    expect(timestamps.length).toBeGreaterThan(0);

    await user.hover(timestamps[0]);
    const chip = await screen.findByTestId("envelope-chip");
    // full fixture envelope: system_date · timezone · region · locale
    expect(chip).toHaveTextContent("2026-08-02 · Europe/London · GB · en-GB");
  });
});

// P1-T13 — turn forks. "🔀 fork action on any turn in Chat itself"
// (feature-spec.md:72) fires POST /agenttrees/{tree}/replay/turn
// (openapi.yaml:623-652); "Forks carry lineage metadata … Shown as a
// badge/breadcrumb" (feature-spec.md:69); "open parent (if fork)"
// (feature-spec.md:6); deleted parent → "the parent link renders as deleted"
// (openapi.yaml:441-443).
describe("Turn forks (P1-T13)", () => {
  it("⑂ on an assistant turn opens the fork modal and fires with that conversation/turn", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    // only the assistant turn (t2) carries the action row → exactly one ⑂
    await user.click(screen.getByRole("button", { name: "Fork turn" }));
    await user.click(await screen.findByRole("combobox", { name: "Endpoints" }));
    await user.click(await screen.findByRole("option", { name: "staging" }));
    await user.click(screen.getByRole("button", { name: "Fork ⑂" }));

    await waitFor(() => expect(replayTurnRequests).toHaveLength(1));
    expect(replayTurnRequests[0].body).toEqual({
      conversation_id: "c1",
      turn_id: "t2",
      endpoints: ["ep_agent1_staging"],
      context_policy: "frozen",
    });
  });

  it("lineage banner renders for a fork; Open parent navigates to the parent", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c2f1"); // fork fixture: parent c2, turn t9, endpoint ep_agent1_prod

    const banner = await screen.findByTestId("lineage-banner");
    // parent title resolves via GET …/conversations/c2
    await waitFor(() => expect(banner).toHaveTextContent("fork of Billing dispute"));
    expect(banner).toHaveTextContent("@ t9");
    expect(banner).toHaveTextContent("via ep_agent1_prod");

    await user.click(screen.getByText("Open parent"));
    // c2 is not a fork → banner gone once the parent conversation loads
    await waitFor(() =>
      expect(screen.queryByTestId("lineage-banner")).not.toBeInTheDocument(),
    );
  });

  it("deleted parent: lineage survives, link renders disabled as 'parent deleted'", async () => {
    renderChat("/chat/c-orphan"); // fixture parent c-gone → GET 404s

    const banner = await screen.findByTestId("lineage-banner");
    await screen.findByText("parent deleted");
    expect(banner).toHaveTextContent("fork of c-gone"); // id fallback, no title
    expect(screen.queryByText("Open parent")).not.toBeInTheDocument();
  });

  // P1-T14 — fork-side entry into the sibling comparison: lineage alone
  // (parent + fork_turn_id) identifies the sibling set ("compare forks of the
  // same turn across endpoints", feature-spec.md:73) — no run id needed.
  it("Compare siblings on the lineage banner routes to /forks/{parent}/{turn}", async () => {
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route path="/chat/:conversationId" element={<ChatPage />} />
        <Route path="/forks/:parentId/:turnId" element={<ForksProbe />} />
      </Routes>,
      { route: "/chat/c2f1" },
    );
    const banner = await screen.findByTestId("lineage-banner");

    await user.click(within(banner).getByText("Compare siblings"));
    await screen.findByText("forks-probe c2 t9");
  });
});

function ForksProbe() {
  const { parentId, turnId } = useParams();
  return <div>forks-probe {parentId} {turnId}</div>;
}

// P1-T16 — "⌁ trace icon on every turn — in Chat, results grid cells, and
// drill-in" (feature-spec.md:145). Chat surface: sketch 01's action row
// (👍👎⧉⑂⌁) exists on assistant turns only, so ⌁ ships there (user turns'
// traces are empty-span per the contract — no affordance).
describe("Turn trace entry (P1-T16)", () => {
  it("⌁ on an assistant turn routes to /trace/{turn_id}", async () => {
    const user = userEvent.setup();
    renderApp(
      <Routes>
        <Route path="/chat/:conversationId" element={<ChatPage />} />
        <Route path="/trace/:turnId" element={<TraceProbe />} />
      </Routes>,
      { route: "/chat/c1" },
    );
    await screen.findByText("Approved refunds land in 3-5 days.");

    // only the assistant turn (t2) carries the action row → exactly one ⌁
    const traceButtons = screen.getAllByRole("button", { name: "Open trace" });
    expect(traceButtons).toHaveLength(1);
    await user.click(traceButtons[0]);
    await screen.findByText("trace-probe t2");
  });
});

function TraceProbe() {
  const { turnId } = useParams();
  return <div>trace-probe {turnId}</div>;
}

// P1-T18c — "Live LLM (BYOK)" section of the chat settings popover. Hard
// rules (docs/deployment.md:24-27): "Client pastes key in UI → browser
// localStorage only" (the specced override of the P1-T05 no-persistence
// note); "Sent per request: X-LLM-Key + X-LLM-Model headers"; visible live
// indicator near the settings gear while a key is active.
describe("Live LLM (BYOK) settings", () => {
  const KEY = "sk-or-test-ui-key";

  async function openSettings(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Chat settings" }));
  }

  it("saves the key to localStorage, shows the live badge, and offers the curated live models", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");
    expect(screen.queryByTestId("live-badge")).not.toBeInTheDocument();

    await openSettings(user);
    await user.type(screen.getByLabelText("OpenRouter key"), KEY);
    await user.click(screen.getByRole("button", { name: "Save key" }));

    // localStorage ONLY (docs/deployment.md:25)
    expect(localStorage.getItem("skein.byok.key")).toBe(KEY);
    expect(await screen.findByTestId("live-badge")).toHaveTextContent("live");
    // /models refetched WITH the key header → curated list in the select
    await waitFor(() =>
      expect(
        llmHeaderCaptures.some((c) => c.path === "/models" && c.key === KEY),
      ).toBe(true),
    );
    await user.click(await screen.findByRole("combobox", { name: "Live model" }));
    await user.click(await screen.findByRole("option", { name: "DeepSeek Chat" }));
    expect(localStorage.getItem("skein.byok.model")).toBe("deepseek/deepseek-chat");
  });

  it("sends chat with X-LLM-Key + X-LLM-Model when a key is stored", async () => {
    localStorage.setItem("skein.byok.key", KEY);
    localStorage.setItem("skein.byok.model", "deepseek/deepseek-chat");
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    await user.type(screen.getByPlaceholderText("Message…"), "go live{enter}");
    await waitFor(() => expect(chatRequests).toHaveLength(1));
    const capture = llmHeaderCaptures.find((c) => c.path.endsWith("/chat"))!;
    expect(capture.key).toBe(KEY);
    expect(capture.model).toBe("deepseek/deepseek-chat");
    expect(capture.url).not.toContain(KEY); // never in URLs
  });

  it("clear key wipes localStorage and hides the badge", async () => {
    localStorage.setItem("skein.byok.key", KEY);
    localStorage.setItem("skein.byok.model", "deepseek/deepseek-chat");
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");
    expect(screen.getByTestId("live-badge")).toBeInTheDocument();

    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "Clear key" }));
    expect(localStorage.getItem("skein.byok.key")).toBeNull();
    expect(localStorage.getItem("skein.byok.model")).toBeNull();
    expect(screen.queryByTestId("live-badge")).not.toBeInTheDocument();
  });
});

// P2-T07c disabled tree (feature-spec.md:20): "existing conversations stay
// READABLE (read-only banner) so history and traces aren't lost"; "new
// chat/replay/judge against it return 409 tree_disabled".
describe("Disabled tree (P2-T07c)", () => {
  const disabledTrees = [
    { id: "agent1", name: "Agent 1", enabled: false },
    { id: "agent2", name: "Agent 2", enabled: true },
  ];

  it("renders the read-only banner over readable history when the active tree is disabled", async () => {
    renderApp(
      <Routes>
        <Route path="/chat/:conversationId" element={<ChatPage />} />
      </Routes>,
      { route: "/chat/c1", trees: disabledTrees },
    );
    // History still loads and renders — disabling never removes data.
    await screen.findByText("How do refunds work?");
    expect(screen.getByTestId("read-only-banner")).toHaveTextContent(
      /Agent 1 is disabled — history is read-only/,
    );
  });

  it("no banner while the tree is enabled", async () => {
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");
    expect(screen.queryByTestId("read-only-banner")).not.toBeInTheDocument();
  });

  it("a 409 tree_disabled on send surfaces the friendly central message", async () => {
    // The server's raw message is deliberately NOT what the user sees: the
    // client maps code tree_disabled once, centrally (client.ts), so every
    // page's existing error rendering says the same thing.
    server.use(
      http.post(`${BASE}/agenttrees/:tree/chat`, () =>
        HttpResponse.json(
          { code: "tree_disabled", message: "Agent tree 'agent1' is disabled — history is read-only." },
          { status: 409 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    await user.type(screen.getByPlaceholderText("Message…"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const alert = await screen.findByText(
      "This agent tree is disabled — history is read-only.",
    );
    expect(alert).toBeInTheDocument();
  });
});
