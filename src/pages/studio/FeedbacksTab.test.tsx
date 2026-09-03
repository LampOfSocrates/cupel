import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router";
import { renderApp } from "../../test/render";
import { pushHumanJudgment, pushLlmJudgment, judgmentRequests } from "../../test/msw/handlers";
import { StudioFrame } from "./StudioFrame";
import { FeedbacksTab } from "./FeedbacksTab";

// The real route shape — the tab renders inside the frame that owns setError,
// so mounting it bare would not exercise what ships.
function renderFeedbacks() {
  return renderApp(
    <Routes>
      <Route path="/studio" element={<StudioFrame />}>
        <Route path="feedbacks" element={<FeedbacksTab />} />
      </Route>
    </Routes>,
    { route: "/studio/feedbacks" },
  );
}

// Studio ▸ Feedbacks. The screen exists to answer one question — "what did
// people say about this tree?" — and the contract only learned to answer it in
// v0.7.0, so the request it sends is as much the subject of these tests as the
// rows it renders.

describe("Studio ▸ Feedbacks", () => {
  it("asks for human judgments on the current tree, in one request", async () => {
    pushHumanJudgment("t2", "c1", "down", "2026-08-04T10:05:00Z", "missed the refund window");
    renderFeedbacks();

    await screen.findByText("missed the refund window");

    // The two v0.7.0 filters, both present: without scorer_kind the queue
    // fills with the judge's machine scores, without tree it shows another
    // tree's feedback.
    const asked = judgmentRequests.at(-1)!;
    expect(asked.searchParams.get("scorer_kind")).toBe("human");
    expect(asked.searchParams.get("tree")).toBe("agent1");
  });

  it("shows the note, and says so when a thumb has none", async () => {
    pushHumanJudgment("t2", "c1", "up", "2026-08-04T10:05:00Z", null);
    renderFeedbacks();

    // An empty line would read like a half-loaded row; the row says what it is.
    await screen.findByText("No note — just the thumb.");
  });

  it("links a note back to the turn it is about", async () => {
    pushHumanJudgment("t2", "c1", "down", "2026-08-04T10:05:00Z", "wrong policy quoted");
    renderFeedbacks();

    const jump = await screen.findByRole("link", { name: "Jump to conversation" });
    // Possible only because Judgment carries conversation_id as of v0.7.0 —
    // every route to a turn is addressed by conversation.
    expect(jump).toHaveAttribute("href", "/chat/c1?turn=t2");
  });

  it("leaves out the judge's own scores", async () => {
    pushHumanJudgment("t2", "c1", "down", "2026-08-04T10:05:00Z", "a human said this");
    pushLlmJudgment({ case_id: "case-1", score: 0.2, reasoning: "a model said this" });
    renderFeedbacks();

    await screen.findByText("a human said this");
    expect(screen.queryByText("a model said this")).not.toBeInTheDocument();
  });

  it("explains what to do when there is no feedback yet", async () => {
    renderFeedbacks();
    await waitFor(() =>
      expect(screen.getByText(/No feedback on this tree yet/)).toBeInTheDocument(),
    );
  });
});
