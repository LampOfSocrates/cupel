import { expect, test } from "@playwright/test";

// The Phase-1 Definition of done, walked end-to-end
// (cupel-phases.md:64-65): "app boots on mock with seeded data → simulate
// (drip) fills sidebar/queue live → full loop works: chat → fork a turn to 2
// endpoints → compare → judge → read reasoning → edit agent → Test in Runs →
// see trace with costs." Scripted as a regression asset; each DoD step is a
// test.step so failures name the broken step. ("Test in Runs" is now
// "Test as evaluation" in the UI — #3; cupel-phases.md is corrected in #5.)
//
// The "simulate" step is represented by one generator-style write (the drip
// loop is this, repeated): an external machine-origin POST /chat through the
// public API only (cupel-phases.md:160 invariant) — the open app must show its
// task in the queue LIVE via the app-wide /tasks/stream, no reload.

const MOCK = "http://localhost:4010";
const DOD_MSG = "DoD walk parcel stuck in transit"; // <48 chars = title verbatim

test("Phase-1 DoD: boot → simulate → chat → fork ×2 → compare → judge → reasoning → edit → Test as evaluation → trace with costs", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);

  // Rubric up front: EvaluationPage fetches GET /eval/rubrics once on mount,
  // so it must exist before any evaluation page loads.
  const rubricRes = await request.post(`${MOCK}/eval/rubrics`, {
    data: { name: "DoD rubric", prompt: "Score 0-1: grounded and helpful?" },
  });
  expect(rubricRes.status()).toBe(201);
  const rubric = await rubricRes.json();

  await test.step("boot on mock with seeded data (/me called, sidebar + seeded agents)", async () => {
    const meResponse = page.waitForResponse((r) => new URL(r.url()).pathname === "/me");
    await page.goto("/");
    expect((await meResponse).status()).toBe(200);
    await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
    // Seeded structure (mock/seed.py): Customer Support tree with Concierge root.
    await page.getByRole("link", { name: "Agents" }).click();
    await expect(page.getByRole("button", { name: "Open Concierge" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open Refunds" })).toBeVisible();
  });

  await test.step("simulate: generator-style API write fills the queue live", async () => {
    await page.getByRole("link", { name: "Queue" }).click();
    await expect(page.getByText("SSE live")).toBeVisible();
    const rows = page.locator('[data-testid^="task-"]');
    const before = await rows.count();
    // What drip does per tick: a machine-origin chat via the public API.
    const res = await request.post(`${MOCK}/agenttrees/agent1/chat`, {
      data: {
        message: "Simulated drip conversation",
        stream: false,
        origin: "machine",
        channel: "generator",
        author: "gen-persona-1",
      },
      timeout: 60_000,
    });
    expect(res.ok()).toBeTruthy();
    // The open Queue page gains the task with NO reload (app-wide stream).
    await expect(rows).toHaveCount(before + 1, { timeout: 30_000 });
  });

  let conversationUrl = "";
  await test.step("chat: send a message, reply streams to done", async () => {
    await page.getByRole("button", { name: "+ New chat" }).click();
    await page.getByPlaceholder("Message…").fill(DOD_MSG);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("streaming-turn")).toBeVisible();
    await page.waitForURL(/\/chat\/conv_/);
    await expect(page.getByTestId("streaming-turn")).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.getByTestId("transcript").getByRole("button", { name: "Fork turn" }),
    ).toBeVisible();
    conversationUrl = page.url();
  });

  await test.step("fork the turn to 2 endpoints", async () => {
    await page.getByRole("button", { name: "Fork turn" }).click();
    await page.getByRole("combobox", { name: "Endpoints" }).click();
    await page.getByRole("option", { name: "prod" }).click();
    await page.getByRole("option", { name: "staging" }).click();
    await page.keyboard.press("Escape"); // close the combobox, keep the modal
    await page.getByRole("button", { name: "Fork ⑂" }).click();
    const results = page.getByTestId("fork-results");
    await expect(results).toBeVisible();
    await expect(results.getByText("Open in Chat ↗")).toHaveCount(2);
  });

  await test.step("compare: fork pivot grid — column per endpoint, cells fill", async () => {
    await page.getByText("View evaluation").click();
    await page.waitForURL(/\/evaluations\/run_/);
    const grid = page.getByTestId("comparison-grid");
    await expect(grid).toBeVisible();
    await expect(grid.getByText("prod")).toBeVisible();
    await expect(grid.getByText("staging")).toBeVisible();
    // 1 source row × (baseline + prod + staging).
    await expect(page.locator('[data-testid^="cell-"][data-status="done"]')).toHaveCount(3, {
      timeout: 120_000,
    });
  });

  await test.step("judge the evaluation (rubric via API, UI mini-form)", async () => {
    await page.getByRole("button", { name: "⚖ Judge this evaluation" }).click();
    const judgeForm = page.getByTestId("judge-form");
    await judgeForm.getByRole("combobox", { name: "Judge model" }).click();
    await page.getByRole("option", { name: "Claude Sonnet 5" }).click();
    await judgeForm.getByRole("combobox", { name: "Rubric" }).click();
    await page.getByRole("option", { name: `DoD rubric v${rubric.version}` }).click();
    await judgeForm.getByRole("button", { name: "Judge", exact: true }).click();
    await expect(page.locator('[data-testid^="score-chip-"]').first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByTestId("run-summary")).toBeVisible();
  });

  await test.step("read the judge's reasoning (judgment drawer)", async () => {
    await page.locator('[data-testid^="score-chip-"]').first().click();
    await expect(page.getByTestId("judgment-history-heading")).toContainText("append-only");
    const entry = page.getByTestId("judgment-entry").first();
    await expect(entry).toBeVisible();
    expect((await entry.innerText()).trim().length).toBeGreaterThan(20); // reasoning text present
    await page.keyboard.press("Escape"); // close drawer
  });

  let savedVersion = 0;
  await test.step("edit the agent: save = new version, never overwrite", async () => {
    await page.getByRole("link", { name: "Agents" }).click();
    await page.getByRole("button", { name: "Open Concierge" }).click();
    await page.waitForURL(/\/agents\/.+\/editor/);
    const instructions = page.getByLabel("Instructions");
    await expect(instructions).not.toBeEmpty(); // seeded live version loaded
    const saveButton = page.getByRole("button", { name: /^Save as v\d+$/ });
    savedVersion = Number((await saveButton.innerText()).match(/v(\d+)$/)![1]);
    await instructions.fill(
      (await instructions.inputValue()) + "\n- DoD walk edit: be extra concise.",
    );
    await saveButton.click();
    // New version appended to the rail and live.
    const row = page.getByTestId(`version-${savedVersion}`);
    await expect(row).toBeVisible();
    await expect(row.getByText("live")).toBeVisible();
  });

  await test.step("Test as evaluation: snapshot draft → pick → queue → grid fills", async () => {
    // Edit again so the button snapshots an untested DRAFT (feature-spec.md:86).
    const instructions = page.getByLabel("Instructions");
    await instructions.fill(
      (await instructions.inputValue()) + "\n- Draft under test via Test as evaluation.",
    );
    await page.getByRole("button", { name: "Test as evaluation" }).click();
    await page.waitForURL(/\/evaluations$/);
    // First-time testing: empty last-selection lands on Pick (openapi.yaml:311).
    await page.getByRole("checkbox", { name: `Select ${DOD_MSG}` }).check();
    await page.getByRole("button", { name: "Configure ▸" }).click();
    // Config prefilled with the snapshot ("v#-draft (hash)" badge).
    await expect(page.getByTestId("snapshot-badge")).toBeVisible();
    await page.getByRole("button", { name: "Queue" }).click();
    await page.waitForURL(/\/evaluations\/run_/);
    // 1 row × (baseline + snapshot config).
    await expect(page.locator('[data-testid^="cell-"][data-status="done"]')).toHaveCount(2, {
      timeout: 120_000,
    });
  });

  await test.step("open a trace and see costs", async () => {
    await page.locator('[aria-label^="Open trace for turn"]').first().click();
    await page.waitForURL(/\/trace\//);
    // Header totals: "Trace · turn · 1.2s · 120→80 tok · $0.0007".
    await expect(page.getByRole("heading", { name: /Trace · .+tok · \$\d/ })).toBeVisible();
    await expect(page.getByTestId("call-tree")).toBeVisible();
    await expect(page.getByTestId("waterfall")).toBeVisible();
    expect(await page.locator('[data-testid^="wf-bar-"]').count()).toBeGreaterThan(0);
    // Span drawer: the LLM leaf is the last call-tree node (mock/engine.py:
    // agent → tool → llm; the llm span's NAME is the model id) — it carries
    // model + exact tokens + cost.
    await page.getByTestId("call-tree").getByRole("button").last().click();
    await expect(page.getByTestId("span-drawer")).toBeVisible();
    await expect(page.getByTestId("span-stats")).toContainText("$");
  });

  // The forked conversations remain real, continuable chats (cupel-phases.md:20).
  await test.step("fork is a real conversation (lineage banner in Chat)", async () => {
    await page.goto(conversationUrl);
    // By id, not by label: "⑂ 2 forks" repeats across the seeded dataset.
    const conversationId = new URL(conversationUrl).pathname.split("/").pop()!;
    await expect(page.getByTestId(`forks-${conversationId}`)).toHaveText(/2 forks/);
  });
});
