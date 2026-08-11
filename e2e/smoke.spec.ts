import { expect, test } from "@playwright/test";

// THE smoke e2e: "boot on mock → send chat turn
// (SSE renders) → queue a 2-conversation replay → grid fills → judge one →
// score appears". Runs against the real mock on :4010 (no MSW) with a fresh
// scratch DB per evaluation (playwright.config.ts), so all history is created here.

const MOCK = "http://localhost:4010";

// canned_title (mock/util.py:32) truncates at 48 chars — messages under that
// become conversation titles verbatim, giving the picker stable checkbox
// names (`Select ${title}`, ConversationPicker.tsx:174).
const MSG_A = "Smoke chat one about parcel delays";
const MSG_B = "Smoke chat two about refunds";

// @smoke — the subset `npm run e2e:smoke` runs (see package.json).
test("smoke: boot → chat SSE → 2-conversation replay → grid fills → judge → score", { tag: "@smoke" }, async ({
  page,
  request,
}) => {
  // Setup: a rubric for the judge step (bootstrap seeds none, mock/seed.py:3).
  const rubricRes = await request.post(`${MOCK}/eval/rubrics`, {
    data: { name: "Smoke rubric", prompt: "Score 0-1: is the reply helpful?" },
  });
  expect(rubricRes.status()).toBe(201);
  const rubric = await rubricRes.json();

  // --- Boot on mock: /me is always called (invariant) ---
  const meResponse = page.waitForResponse((r) => new URL(r.url()).pathname === "/me");
  await page.goto("/");
  expect((await meResponse).status()).toBe(200);
  // Sidebar renders (shell + recent list).
  await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
  await expect(page.getByText("agent1 · Recent")).toBeVisible();

  // --- Send a chat turn; SSE renders (tokens stream in BEFORE done) ---
  await page.getByPlaceholder("Message…").fill(MSG_A);
  await page.getByRole("button", { name: "Send" }).click();
  const streaming = page.getByTestId("streaming-turn");
  await expect(streaming).toBeVisible();
  // The streaming bubble only exists before the `done` event (ChatPage.tsx:472)
  // — non-empty content here proves tokens rendered mid-stream.
  await expect
    .poll(async () => (await streaming.innerText().catch(() => "")).trim().length, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  // done: bubble finalizes into the transcript, URL gains the conversation id.
  await page.waitForURL(/\/chat\/conv_/);
  await expect(streaming).toHaveCount(0, { timeout: 30_000 });
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByRole("button", { name: "Thumbs up" })).toBeVisible();
  // Sidebar picked up the new conversation (row ⋯ menu is uniquely labelled).
  await expect(page.getByRole("button", { name: `Actions for ${MSG_A}` })).toBeVisible();

  // --- Seed a second conversation for the 2-conversation replay (via API) ---
  const chatB = await request.post(`${MOCK}/agenttrees/agent1/chat`, {
    data: { message: MSG_B, stream: false },
    timeout: 60_000,
  });
  expect(chatB.ok()).toBeTruthy();

  // --- Evaluations stepper: pick 2 conversations → configure 1 config → queue ---
  // Results tab, Studio (formerly its own "Evaluations" nav entry — UX
  // polish 2026-08-10, Studio merge).
  await page.getByRole("link", { name: "Studio" }).click();
  await page.getByRole("tab", { name: "Results" }).click();
  await page.getByRole("button", { name: "New evaluation" }).click();
  await page.getByRole("checkbox", { name: `Select ${MSG_A}` }).check();
  await page.getByRole("checkbox", { name: `Select ${MSG_B}` }).check();
  await expect(page.getByTestId("picker-summary")).toHaveText("2 conversations · 0 turns");
  await page.getByRole("button", { name: "Configure ▸" }).click();

  // One config: change the model axis (RunConfigPanel).
  const config = page.getByTestId("config-0");
  await config.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("option", { name: "Claude Haiku 4.5" }).click();
  await page.getByRole("button", { name: "Queue" }).click();

  // --- Grid appears and FILLS (live via /tasks/stream, EvaluationPage.tsx) ---
  await page.waitForURL(/\/evaluations\/eval_/);
  await expect(page.getByTestId("comparison-grid")).toBeVisible();
  // 2 rows (one assistant turn per conversation) × (baseline + 1 config).
  await expect(page.locator('[data-testid^="cell-"][data-status="done"]')).toHaveCount(4, {
    timeout: 120_000,
  });
  await expect(page.getByTestId("cell-0-1")).not.toBeEmpty();
  await expect(page.getByText("done", { exact: true })).toBeVisible();

  // --- Judge the evaluation (UI mini-form) → score appears ---
  await page.getByRole("button", { name: "⚖ Judge this evaluation" }).click();
  const judgeForm = page.getByTestId("judge-form");
  await judgeForm.getByRole("combobox", { name: "Judge model" }).click();
  await page.getByRole("option", { name: "Claude Sonnet 5" }).click();
  await judgeForm.getByRole("combobox", { name: "Rubric" }).click();
  await page.getByRole("option", { name: `Smoke rubric v${rubric.version}` }).click();
  await judgeForm.getByRole("button", { name: "Judge", exact: true }).click();

  // Score chips stream into the grid (feature-spec.md:64); summary header too.
  await expect(page.locator('[data-testid^="score-chip-"]').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.getByTestId("evaluation-summary")).toBeVisible();
});
