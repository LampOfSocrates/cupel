import { describe, expect, it, vi } from "vitest";
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
  evalBenchmarkItemPosts,
  chatConfig,
  chatRequests,
  conv,
  mockRoots,
  feedbackRequests,
  judgmentRequests,
  llmHeaderCaptures,
  modelsRequests,
  pushHumanJudgment,
  pushLlmJudgment,
  replayTurnRequests,
  turnRequests,
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

  // The Settings → Backend SSE toggle (feature-spec.md:156 "SSE
  // streaming on/off") drives ChatRequest.stream; off → the JSON path
  // renders the full reply ("the UI degrades gracefully to non-streaming when
  // the SSE toggle is off in mock options").
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

// listTurns (item 7 stage F2): the transcript is a paged collection, opened on
// its LAST page. A long conversation therefore renders its tail — and the page
// must SAY so rather than presenting a prefix of the history as the whole of
// it.
describe("ChatPage paged transcript", () => {
  const longConversation = () =>
    conv({
      id: "c-long",
      title: "Long thread",
      turns: Array.from({ length: 120 }, (_, i) => ({
        id: `lt${i}`,
        role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
        author: i % 2 === 0 ? "user" : "concierge",
        content: `turn number ${i}`,
        created_at: `2026-08-04T09:${String(i).padStart(2, "0")}:00Z`,
        envelope: null,
      })),
    });

  it("opens on the tail and loads earlier turns on demand, never silently truncating", async () => {
    const user = userEvent.setup();
    mockRoots.push(longConversation());
    renderChat("/chat/c-long");

    // Default page_size is 50, so 120 turns land on page 3 — the newest 20.
    await screen.findByText("turn number 119");
    expect(screen.queryByText("turn number 69")).not.toBeInTheDocument();
    const asked = turnRequests.at(-1)!;
    expect(asked.searchParams.get("page"), "the first load must not pin a page").toBeNull();

    const earlier = await screen.findByTestId("load-earlier-turns");
    await user.click(earlier);
    // Page 2 PREPENDS: chronological order makes the older block contiguous
    // with what is already on screen, so nothing is duplicated or reordered.
    await screen.findByText("turn number 50");
    expect(screen.getByText("turn number 119")).toBeInTheDocument();
    expect(turnRequests.at(-1)!.searchParams.get("page")).toBe("2");

    await user.click(screen.getByTestId("load-earlier-turns"));
    await screen.findByText("turn number 0");
    // Page 1 is on screen — there is nothing earlier, so the affordance goes.
    await waitFor(() =>
      expect(screen.queryByTestId("load-earlier-turns")).not.toBeInTheDocument(),
    );
  });

  it("a short conversation offers nothing to load — the first turn shown is the first turn", async () => {
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");
    expect(screen.queryByTestId("load-earlier-turns")).not.toBeInTheDocument();
  });
});

// Composer attachments. Contract: POST /upload multipart {file} →
// 201 Attachment, "reference its id in ChatRequest.attachments"
// (openapi.yaml:550, :1421-1424); oversize → 413 and "the UI surfaces the
// message" (openapi.yaml:535-536); UI spec: "attach images and files
// (attachment chips, removable before send)" (feature-spec.md:12);
// "multipart upload to /upload before send" (feature-spec.md:273).
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

  // docs/review-2026-08-05.md A7: image chips take an object URL for their
  // thumbnail, revoked on remove/send/conversation switch — but leaving the
  // page mid-compose leaked one blob per picked image.
  it("revokes image-preview object URLs when the page unmounts", async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const create = vi.fn((_: Blob) => {
      const url = `blob:preview-${created.length}`;
      created.push(url);
      return url;
    });
    const revoke = vi.fn((url: string) => void revoked.push(url));
    // Patch the two statics only — replacing global URL breaks fetch/MSW.
    // jsdom implements neither (hence the guard in ChatPage.addFiles).
    const original = {
      create: URL.createObjectURL,
      revoke: URL.revokeObjectURL,
    };
    URL.createObjectURL = create as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revoke;
    try {
      const { unmount } = renderChat("/chat/c1");
      await screen.findByText("How do refunds work?");
      pickFiles([makeFile("img", "shot.png", "image/png")]);
      await waitFor(() => expect(uploadRequests).toHaveLength(1));
      await screen.findByTestId("pending-attachments");
      expect(created).toHaveLength(1);
      expect(revoked).toEqual([]);

      unmount();
      expect(revoked).toEqual(created);
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    }
  });

  // Clipboard paste reuses the SAME upload path as the picker
  // and drag-drop; only files are intercepted, so text paste is untouched.
  it("paste with files uploads through the existing path and chips a generated filename", async () => {
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    // A pasted screenshot: Chromium hands over image/png named "image.png".
    const composer = screen.getByPlaceholderText("Message…");
    const cancelled = !fireEvent.paste(composer, {
      clipboardData: { files: [makeFile("pngbytes", "image.png", "image/png")] },
    });
    // default prevented ONLY because files were handled
    expect(cancelled).toBe(true);

    await waitFor(() => expect(uploadRequests).toHaveLength(1));
    // generated name, so neither the chip nor the stored attachment is blank
    expect(uploadRequests[0]).toEqual({ filename: "pasted-image-1.png", size: 8 });
    const chips = await screen.findByTestId("pending-attachments");
    expect(chips).toHaveTextContent("pasted-image-1.png (8 B)");
    await waitFor(() =>
      expect(within(chips).queryByTestId("chip-uploading")).not.toBeInTheDocument(),
    );

    // second paste keeps counting, and a NAMED pasted file keeps its own name
    fireEvent.paste(composer, {
      clipboardData: { files: [makeFile("more", "image.png", "image/png")] },
    });
    await waitFor(() => expect(uploadRequests).toHaveLength(2));
    expect(uploadRequests[1].filename).toBe("pasted-image-2.png");
    fireEvent.paste(composer, {
      clipboardData: { files: [makeFile("doc", "report.pdf", "application/pdf")] },
    });
    await waitFor(() => expect(uploadRequests).toHaveLength(3));
    expect(uploadRequests[2].filename).toBe("report.pdf");
  });

  it("paste of plain text inserts normally and uploads nothing", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    const composer = screen.getByPlaceholderText("Message…");
    await user.click(composer);
    await user.paste("pasted prose");

    // text landed in the textarea; the file path was never entered
    expect(composer).toHaveValue("pasted prose");
    expect(uploadRequests).toHaveLength(0);
    expect(screen.queryByTestId("pending-attachments")).not.toBeInTheDocument();
  });

  it("a pasted oversize file surfaces the server's 413 message on its chip", async () => {
    uploadConfig.maxBytes = 10;
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    fireEvent.paste(screen.getByPlaceholderText("Message…"), {
      clipboardData: { files: [makeFile("x".repeat(50), "image.png", "image/png")] },
    });
    // same error surfacing as the picker path (openapi.yaml:535-536)
    expect(
      await screen.findByText("File exceeds the 0 MB upload limit."),
    ).toBeInTheDocument();
    expect(screen.getByTestId("pending-attachments")).toHaveTextContent("pasted-image-1.png");
  });

  it("renders stored attachments on a user turn from Turn.attachments", async () => {
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");
    // fixture turn t1 carries spec.pdf (openapi.yaml:1313-1315)
    const transcript = screen.getByTestId("transcript");
    expect(within(transcript).getByText(/spec\.pdf/)).toBeInTheDocument();
  });
});

// Turn actions. Contract: POST /feedback {message_id, rating}
// (openapi.yaml:1475-1480), returns the appended type:human Judgment
// (openapi.yaml:578-582); reload state via GET /eval/judgments filtered by
// conversation_id, "newest first" (openapi.yaml:966-968, :994); "copy copies
// raw markdown" (feature-spec.md:272).
describe("Turn actions", () => {
  it("thumb click posts {message_id, rating} and shows the selected state; re-click re-posts (append-only)", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("Approved refunds land in 3-5 days.");

    const up = screen.getByRole("button", { name: "Thumbs up" });
    const down = screen.getByRole("button", { name: "Thumbs down" });
    expect(up).toHaveAttribute("aria-pressed", "false");

    await user.click(up);
    // message_id = Turn.id (openapi.yaml:1479 / feature-spec.md:272)
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
    // LLM judgments share the store but never drive thumbs — this one is
    // scoped to the same conversation AND newer than both thumbs, so only its
    // subject kind (case, not turn) keeps it out of deriveThumbs.
    pushLlmJudgment({
      case_id: "case1",
      evaluation_id: "evaluation1",
      conversation_id: "c1",
      scorer: { model: "gpt-judge", ref: "r1", version: 1 },
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

  // The comment box. Design (agreed with the user 2026-08-06):
  // the comment is NOT a Turn — it rides on the type:human judgment's
  // `reasoning` (FeedbackRequest.comment) and renders under its assistant
  // turn. The rating itself is still ONE click; the box is optional extra.
  it("a thumb saves the rating immediately AND reveals the comment box", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("Approved refunds land in 3-5 days.");
    expect(screen.queryByTestId("feedback-comment-box")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Thumbs up" }));
    // rating went out on the click — a rater who wants nothing more is done
    await waitFor(() => expect(feedbackRequests).toHaveLength(1));
    expect(feedbackRequests[0]).toEqual({ message_id: "t2", rating: "up" });

    const box = await screen.findByTestId("feedback-comment-box");
    // prompt follows the sentiment
    expect(within(box).getByPlaceholderText("What made this good?")).toBeInTheDocument();

    // 👎 re-prompts with the negative wording
    await user.click(screen.getByRole("button", { name: "Thumbs down" }));
    await waitFor(() => expect(feedbackRequests).toHaveLength(2));
    expect(
      within(screen.getByTestId("feedback-comment-box")).getByPlaceholderText(
        "What went wrong?",
      ),
    ).toBeInTheDocument();
  });

  it("submitting the comment APPENDS a second judgment carrying rating + comment, and renders it", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("Approved refunds land in 3-5 days.");

    await user.click(screen.getByRole("button", { name: "Thumbs down" }));
    await waitFor(() => expect(feedbackRequests).toHaveLength(1));

    await user.type(screen.getByLabelText("Feedback comment"), "It missed the SLA");
    await user.keyboard("{Enter}"); // Enter submits, per the composer convention
    await waitFor(() => expect(feedbackRequests).toHaveLength(2));
    // a NEW post with the same rating + the comment — never an edit of the first
    expect(feedbackRequests[1]).toEqual({
      message_id: "t2",
      rating: "down",
      comment: "It missed the SLA",
    });
    // box closes, note renders under the turn it judges
    await waitFor(() =>
      expect(screen.queryByTestId("feedback-comment-box")).not.toBeInTheDocument(),
    );
    const note = screen.getByTestId("turn-comment-t2");
    expect(note).toHaveTextContent("It missed the SLA");
    expect(note).toHaveTextContent("\u{1F44E}"); // the thumb it accompanied
  });

  it("Shift+Enter newlines instead of submitting; dismissing posts nothing extra", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("Approved refunds land in 3-5 days.");

    await user.click(screen.getByRole("button", { name: "Thumbs up" }));
    await waitFor(() => expect(feedbackRequests).toHaveLength(1));

    const field = screen.getByLabelText("Feedback comment");
    await user.type(field, "line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(field, "line two");
    expect(field).toHaveValue("line one\nline two");
    expect(feedbackRequests).toHaveLength(1); // still nothing submitted

    // dismiss: optional means optional — the rating stands, no second post
    await user.click(screen.getByRole("button", { name: "Close comment box" }));
    await waitFor(() =>
      expect(screen.queryByTestId("feedback-comment-box")).not.toBeInTheDocument(),
    );
    expect(feedbackRequests).toHaveLength(1);
    expect(screen.queryByTestId("turn-comment-t2")).not.toBeInTheDocument();
    // the thumb itself is untouched
    expect(screen.getByRole("button", { name: "Thumbs up" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("comments survive reload: the newest human judgment's reasoning renders under its turn", async () => {
    // oldest → newest; pushHumanJudgment unshifts, so the store is newest-first
    pushHumanJudgment("t2", "c1", "up", "2026-08-03T10:00:00Z", "first take");
    pushHumanJudgment("t2", "c1", "down", "2026-08-04T10:00:00Z", "actually wrong");
    // a judgment for a turn in ANOTHER conversation must not leak in here
    pushHumanJudgment("t9", "c2", "up", "2026-08-04T11:00:00Z", "other conversation");

    renderChat("/chat/c1");
    const bubble = (await screen.findByText("Approved refunds land in 3-5 days."))
      .closest("[class*='Paper']")!;

    // newest wins for BOTH the thumb and its comment
    await waitFor(() => expect(screen.getByTestId("turn-comment-t2")).toBeInTheDocument());
    const note = screen.getByTestId("turn-comment-t2");
    expect(note).toHaveTextContent("actually wrong");
    expect(note).not.toHaveTextContent("first take");
    expect(screen.getByRole("button", { name: "Thumbs down" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // rendered inside the assistant turn it belongs to, not floating elsewhere
    expect(bubble).toContainElement(note);
    expect(screen.queryByTestId("turn-comment-t9")).not.toBeInTheDocument();
    expect(screen.queryByText("other conversation")).not.toBeInTheDocument();
  });

  it("a later bare thumb supersedes the earlier comment (newest judgment wins)", async () => {
    pushHumanJudgment("t2", "c1", "down", "2026-08-03T10:00:00Z", "old complaint");
    pushHumanJudgment("t2", "c1", "up", "2026-08-04T10:00:00Z"); // newest, no comment

    renderChat("/chat/c1");
    await screen.findByText("Approved refunds land in 3-5 days.");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Thumbs up" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(screen.queryByTestId("turn-comment-t2")).not.toBeInTheDocument();
  });

  it("copy puts the turn's raw markdown on the clipboard and confirms", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");

    // stream a markdown reply to completion (tokens "Hello streaming **world**.")
    await user.type(screen.getByPlaceholderText("Message…"), "md please");
    await user.click(screen.getByRole("button", { name: "Send" }));
    // Wait for the DRAFT to be replaced by the done turn: the draft bubble
    // renders the same text, so waiting on the text alone can catch the
    // last-token frame (the draft owns its own state since A8).
    await waitFor(() =>
      expect(screen.queryByTestId("streaming-turn")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("transcript")).toHaveTextContent("Hello streaming world.");

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

// Chat settings submenu. Spec: "Chat has its own Settings submenu
// (model, temperature, system prompt — session-scoped)" (feature-spec.md:7);
// "session-scoped, sent with each /chat call" (feature-spec.md:274); model
// dropdown fed by GET /models (feature-spec.md:118). Contract: ChatRequest
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
    // c2's transcript loaded
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

// Envelope affordance on turns. Every turn records its context
// (date, timezone, region) at generation; envelope on
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

// Turn forks. "🔀 fork action on any turn in Chat itself"
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
    renderChat("/chat/c-orphan"); // fixture parent c-gone is a tombstone

    const banner = await screen.findByTestId("lineage-banner");
    await screen.findByText("parent deleted");
    expect(banner).toHaveTextContent("fork of c-gone"); // id fallback, no title
    expect(screen.queryByText("Open parent")).not.toBeInTheDocument();
  });

  it("a deleted conversation opens read-only: history renders, the composer does not", async () => {
    // Soft delete is VISIBLE (Conversation.deleted), so this page can open a
    // tombstone at all — and having opened it, it must not offer a message box
    // whose every send would 409 conversation_deleted.
    renderChat("/chat/c-gone");

    await screen.findByText("This conversation was deleted.");
    await screen.findByTestId("deleted-conversation-banner");
    expect(screen.queryByPlaceholderText("Message…")).not.toBeInTheDocument();
    // Not the unavailable state: a tombstone is deleted, not absent.
    expect(screen.queryByTestId("conversation-unavailable")).not.toBeInTheDocument();
  });

  // Fork-side entry into the sibling comparison: lineage alone
  // (parent + fork_turn_id) identifies the sibling set ("compare forks of the
  // same turn across endpoints", feature-spec.md:73) — no evaluation id needed.
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

// "⌁ trace icon on every turn — in Chat, results grid cells, and
// drill-in" (feature-spec.md:141). Chat surface: sketch 01's action row
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

// "Live LLM (BYOK)" section of the chat settings popover. Hard
// rules (docs/deployment.md:24-27): "Client pastes key in UI → browser
// localStorage only" (the specced override of the no-persistence
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
    expect(localStorage.getItem("cupel.byok.key")).toBe(KEY);
    expect(await screen.findByTestId("live-badge")).toHaveTextContent("live");
    // /models refetched WITH the key header → curated list in the select
    await waitFor(() =>
      expect(
        llmHeaderCaptures.some((c) => c.path === "/models" && c.key === KEY),
      ).toBe(true),
    );
    await user.click(await screen.findByRole("combobox", { name: "Live model" }));
    await user.click(await screen.findByRole("option", { name: "DeepSeek Chat" }));
    expect(localStorage.getItem("cupel.byok.model")).toBe("deepseek/deepseek-chat");
  });

  it("sends chat with X-LLM-Key + X-LLM-Model when a key is stored", async () => {
    localStorage.setItem("cupel.byok.key", KEY);
    localStorage.setItem("cupel.byok.model", "deepseek/deepseek-chat");
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
    localStorage.setItem("cupel.byok.key", KEY);
    localStorage.setItem("cupel.byok.model", "deepseek/deepseek-chat");
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("How do refunds work?");
    expect(screen.getByTestId("live-badge")).toBeInTheDocument();

    await openSettings(user);
    await user.click(screen.getByRole("button", { name: "Clear key" }));
    expect(localStorage.getItem("cupel.byok.key")).toBeNull();
    expect(localStorage.getItem("cupel.byok.model")).toBeNull();
    expect(screen.queryByTestId("live-badge")).not.toBeInTheDocument();
  });
});

// Copy-link sharing. Deliberately contract-neutral: the links are
// the app's own routes and ride the existing GET conversation endpoint. A
// received ?turn= scrolls + marks that turn; an unknown one is ignored; a
// conversation the receiver can't see is 404 for BOTH "deleted" and
// "unpermitted" (openapi.yaml:1948) and renders one friendly state.
// Anonymous tokenized public links are not planned (dropped 2026-08-11).
describe("Share links (P2-SHARE)", () => {
  it("🔗 on an assistant turn copies the conversation URL plus ?turn={id}", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("Approved refunds land in 3-5 days.");

    // only the assistant turn (t2) carries the action row → exactly one 🔗
    const shareButtons = screen.getAllByRole("button", { name: "Copy link to turn" });
    expect(shareButtons).toHaveLength(1);
    await user.click(shareButtons[0]);

    expect(await navigator.clipboard.readText()).toBe(
      `${window.location.origin}/chat/c1?turn=t2`,
    );
    // Same confirmation grammar as the existing ⧉ copy affordance.
    expect(await screen.findByRole("button", { name: "Link copied" })).toBeInTheDocument();
  });

  it("no 🔗 on a brand-new chat — there is no conversation to link to yet", async () => {
    renderChat("/chat");
    await screen.findByText("Send a message to start the conversation.");
    expect(screen.queryByRole("button", { name: "Copy link to turn" })).not.toBeInTheDocument();
  });

  it("opening /chat/{id}?turn={id} scrolls that turn into view and marks it", async () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    renderChat("/chat/c1?turn=t2");
    const transcript = await screen.findByTestId("transcript");

    await waitFor(() =>
      expect(transcript.querySelectorAll('[data-share-target="true"]')).toHaveLength(1),
    );
    const marked = transcript.querySelector('[data-share-target="true"]')!;
    // the RIGHT bubble: t2, not the user turn t1
    expect(marked).toHaveTextContent("Approved refunds land in 3-5 days.");
    expect(marked).not.toHaveTextContent("How do refunds work?");
    // the explicit target owns the initial viewport, overriding the bottom pin
    expect(scrollIntoView).toHaveBeenCalled();
    scrollIntoView.mockRestore();
  });

  it("a ?turn= pointing at the user turn marks that bubble instead", async () => {
    renderChat("/chat/c1?turn=t1");
    const transcript = await screen.findByTestId("transcript");
    await waitFor(() =>
      expect(transcript.querySelectorAll('[data-share-target="true"]')).toHaveLength(1),
    );
    expect(transcript.querySelector('[data-share-target="true"]')).toHaveTextContent(
      "How do refunds work?",
    );
  });

  it("an unknown turn id is ignored — the conversation loads normally, no error", async () => {
    renderChat("/chat/c1?turn=does-not-exist");
    await screen.findByText("Approved refunds land in 3-5 days.");
    const transcript = screen.getByTestId("transcript");
    expect(transcript).toHaveTextContent("How do refunds work?");
    expect(transcript.querySelector("[data-share-target]")).toBeNull();
    expect(screen.queryByTestId("conversation-unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText("Could not load conversation")).not.toBeInTheDocument();
  });

  it("a 404 conversation (deleted OR unpermitted) shows the friendly no-access state", async () => {
    renderChat("/chat/c-nope?turn=t2");

    expect(await screen.findByTestId("conversation-unavailable")).toBeInTheDocument();
    expect(screen.getByText("This conversation isn't available")).toBeInTheDocument();
    expect(
      screen.getByText("It may have been deleted, or you may not have access."),
    ).toBeInTheDocument();
    // Not a crash, not a blank transcript, and no raw backend message leaking
    // which of the two reasons applied.
    expect(screen.queryByTestId("transcript")).not.toBeInTheDocument();
    expect(screen.queryByText("conversation not found")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start a new chat" })).toBeInTheDocument();
  });

  it("a non-404 load failure keeps the existing red error surface", async () => {
    server.use(
      http.get(`${BASE}/agenttrees/:tree/conversations/:id`, () =>
        HttpResponse.json({ code: "server_error", message: "boom" }, { status: 500 }),
      ),
    );
    renderChat("/chat/c1");
    expect(await screen.findByText("Could not load conversation")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByTestId("conversation-unavailable")).not.toBeInTheDocument();
  });
});

// Disabled tree (feature-spec.md:20): "existing conversations stay
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

// ⊞ — "Entry points: ⊞ on any turn, Chat, the Inspector … and results
// cells". The chat action row gains one glyph; the picker behind it is the
// same CollectModal the Inspector opens, and what it posts is a REFERENCE
// {tree, conversation_id, turn_id} — into an eval benchmark, since the
// Casebook merged into that noun.
describe("⊞ collect from the chat turn action row (P2-T12a)", () => {
  it("posts the turn as an eval-benchmark item reference", async () => {
    const user = userEvent.setup();
    renderChat("/chat/c1");
    await screen.findByText("Approved refunds land in 3-5 days.");

    // Only the assistant turn carries the action row → exactly one ⊞.
    const collect = screen.getAllByRole("button", { name: "Collect into eval benchmark" });
    expect(collect).toHaveLength(1);
    await user.click(collect[0]);

    expect(await screen.findByTestId("collect-target")).toHaveTextContent("agent1 · c1 · t2");
    await user.click((await screen.findAllByRole("button", { name: "⊞ Add" }))[0]);
    await waitFor(() => expect(evalBenchmarkItemPosts).toHaveLength(1));
    expect(evalBenchmarkItemPosts[0]).toEqual({
      benchmarkId: "set-refunds",
      body: {
        source: { tree: "agent1", conversation_id: "c1", turn_id: "t2" },
        note: null,
      },
    });
  });

  it("no ⊞ on a brand-new chat — there is no turn reference to store yet", async () => {
    renderChat("/chat");
    await screen.findByText("Send a message to start the conversation.");
    expect(
      screen.queryByRole("button", { name: "Collect into eval benchmark" }),
    ).not.toBeInTheDocument();
  });
});
