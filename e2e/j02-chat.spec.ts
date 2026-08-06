import { expect, test } from "./helpers/api";

// E2E checklist journey 2 (feature-spec.md:207):
// "Chat: send → SSE tokens render; 👍/👎 posts feedback; copy; attach +
//  upload; stop generation"
// Endpoint tags (feature-spec.md:227-228, sketch 01):
//   POST /agenttrees/{tree}/chat (SSE → task_id) · stop = DELETE /tasks/{id}
//   POST /upload · POST /feedback · GET /models
//
// smoke.spec.ts already proves boot → send → SSE → done; this journey walks
// the turn actions and the composer around it.

const MSG = "Chat journey: where is my refund?"; // <48 chars → title verbatim
const MSG_2 = "Chat journey: second, longer message";

test.use({ permissions: ["clipboard-write", "clipboard-read"] });

test("chat: attach + upload → send → SSE tokens → 👍 + comment → copy → link → stop generation", async ({
  page,
  api,
}) => {
  await page.goto("/chat");
  await expect(page.getByPlaceholder("Message…")).toBeVisible();

  await test.step("chat settings load the model list", async () => {
    await page.getByRole("button", { name: "Chat settings" }).click();
    await expect(page.getByRole("combobox", { name: "Model" })).toBeVisible();
    await api.expectCalled("GET /models");
    await page.keyboard.press("Escape");
  });

  await test.step("attach a file: it uploads and becomes a chip", async () => {
    await page.getByLabel("Attach files input").setInputFiles({
      name: "shipping-label.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("tracking: SKN-1234"),
    });
    await expect(page.getByTestId("pending-attachments")).toContainText("shipping-label.txt");
    await api.expectCalled("POST /upload");
  });

  await test.step("send: the reply streams in token by token", async () => {
    await page.getByPlaceholder("Message…").fill(MSG);
    await page.getByRole("button", { name: "Send" }).click();
    const streaming = page.getByTestId("streaming-turn");
    await expect(streaming).toBeVisible();
    // Non-empty while the bubble still exists = tokens rendered mid-stream
    // (the bubble is replaced by the transcript entry on `done`).
    await expect
      .poll(async () => (await streaming.innerText().catch(() => "")).trim().length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    await page.waitForURL(/\/chat\/conv_/);
    await expect(streaming).toHaveCount(0, { timeout: 30_000 });
    await api.expectCalled("POST /agenttrees/{tree}/chat");
  });

  const transcript = page.getByTestId("transcript");

  await test.step("👍 posts feedback and the optional comment sticks", async () => {
    api.clear();
    await transcript.getByRole("button", { name: "Thumbs up" }).click();
    await api.expectCalled("POST /feedback");
    await expect(transcript.getByRole("button", { name: "Thumbs up" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // P2-CHATUX: the thumb opens a comment box; the note is stored as the
    // judgment's reasoning and renders under that turn.
    const box = page.getByTestId("feedback-comment-box");
    await expect(box).toBeVisible();
    await box.getByLabel("Feedback comment").fill("Exactly the policy I needed.");
    await box.getByRole("button", { name: "Send" }).click();
    await expect(page.locator('[data-testid^="turn-comment-"]')).toContainText(
      "Exactly the policy I needed.",
    );
    await api.expectCalled("POST /feedback", 2);
  });

  await test.step("👎 is the other half of the same control", async () => {
    await transcript.getByRole("button", { name: "Thumbs down" }).click();
    await expect(transcript.getByRole("button", { name: "Thumbs down" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByTestId("feedback-comment-box").getByLabel("Close comment box").click();
  });

  await test.step("copy the reply as markdown", async () => {
    await transcript.getByRole("button", { name: "Copy message" }).click();
    await expect(transcript.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("**");
  });

  await test.step("copy a link to the turn and open it (P2-SHARE, off-mode)", async () => {
    await transcript.getByRole("button", { name: "Copy link to turn" }).click();
    await expect(transcript.getByRole("button", { name: "Link copied" })).toBeVisible();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toContain("?turn=turn_");
    await page.goto(new URL(link).pathname + new URL(link).search);
    const target = transcript.locator('[data-share-target="true"]');
    await expect(target).toHaveCount(1);
    await expect(target.getByRole("button", { name: "Copy link to turn" })).toBeVisible();
  });

  await test.step("stop generation mid-stream: partial text is kept", async () => {
    api.clear();
    await page.getByPlaceholder("Message…").fill(MSG_2);
    await page.getByRole("button", { name: "Send" }).click();
    // Send is replaced by ■ Stop for exactly as long as the stream runs.
    await page.getByRole("button", { name: "Stop generation" }).click();
    await api.expectCalled("DELETE /tasks/{id}");
    await expect(page.getByTestId("streaming-turn")).toHaveCount(0, { timeout: 30_000 });
    // The user turn survives, and so does whatever the assistant had written.
    await expect(transcript).toContainText(MSG_2);
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  });
});
