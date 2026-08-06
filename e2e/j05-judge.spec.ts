import { expect, test } from "./helpers/api";
import { seedChat, seedRubric } from "./helpers/seed";
import { filmed } from "./helpers/hud";

// E2E checklist journey 5 (feature-spec.md:210):
// "Judge: enable judge → scores stream in → judgment drawer shows reasoning +
//  history; retroactive 'Score this run'"
// Endpoint tags (feature-spec.md:232-234, sketch 04):
//   GET /eval/rubrics · POST /agenttrees/{tree}/replay (judge in the config)
//   POST /eval/judge (retroactive) · GET /eval/judgments · GET /eval/runs/{id}/summary

const CONV = "Judge journey: is my warranty valid?";

test("judge: run with the judge on → scores stream in → drawer reasoning + append-only history", async ({
  page,
  request,
  api,
}) => {
  const step = filmed(page, "Journey 5", 4);
  const rubric = await seedRubric(request, "Journey rubric");
  const chat = await seedChat(request, CONV);
  await seedChat(request, "It broke after fourteen months", {
    conversationId: chat.conversationId,
  });

  await step("configure a run with the judge enabled up front", async () => {
    await page.goto("/runs");
    await page.getByRole("button", { name: "New run" }).click();
    await page.getByRole("checkbox", { name: `Select ${CONV}` }).check();
    await page.getByRole("button", { name: "Configure ▸" }).click();

    const config = page.getByTestId("config-0");
    await config.getByRole("combobox", { name: "Model", exact: true }).click();
    await page.getByRole("option", { name: "Claude Haiku 4.5" }).click();
    // Judge is collapsed by default (feature-spec.md:46-48) — turning it on
    // reveals the two fields JudgeConfig requires.
    await config.getByRole("switch", { name: "⚖ Judge" }).check();
    await api.expectCalled("GET /eval/rubrics");
    await config.getByRole("combobox", { name: "Judge model" }).click();
    await page.getByRole("option", { name: "Claude Sonnet 5" }).click();
    await config.getByRole("combobox", { name: "Rubric" }).click();
    await page.getByRole("option", { name: `Journey rubric v${rubric.version}` }).click();
  });

  await step("queue: cells and SCORES both stream into the grid", async () => {
    api.clear();
    await page.getByRole("button", { name: "Queue" }).click();
    await api.expectCalled("POST /agenttrees/{tree}/replay");
    await page.waitForURL(/\/runs\/run_/);
    await expect(page.getByTestId("comparison-grid")).toBeVisible();
    // 2 rows × (baseline + 1 config).
    await expect(page.locator('[data-testid^="cell-"][data-status="done"]')).toHaveCount(4, {
      timeout: 120_000,
    });
    // No second click needed: the judge ran because it was part of the config.
    await expect(page.locator('[data-testid^="score-chip-"]').first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByTestId("run-summary")).toBeVisible();
    await api.expectCalled("GET /eval/runs/{run}/summary");
  });

  await step("judgment drawer: reasoning and append-only history", async () => {
    api.clear();
    await page.locator('[data-testid^="score-chip-"]').first().click();
    await api.expectCalled("GET /eval/judgments");
    await expect(page.getByTestId("judgment-history-heading")).toContainText("append-only");
    const entries = page.getByTestId("judgment-entry");
    await expect(entries.first()).toBeVisible();
    expect((await entries.first().innerText()).trim().length).toBeGreaterThan(20);
    await page.keyboard.press("Escape");
  });

  await step('retroactive "Judge this run" appends, never overwrites', async () => {
    api.clear();
    await page.getByRole("button", { name: "⚖ Judge this run" }).click();
    const judgeForm = page.getByTestId("judge-form");
    await judgeForm.getByRole("combobox", { name: "Judge model" }).click();
    await page.getByRole("option", { name: "DeepSeek V3" }).click();
    await judgeForm.getByRole("combobox", { name: "Rubric" }).click();
    await page.getByRole("option", { name: `Journey rubric v${rubric.version}` }).click();
    await judgeForm.getByRole("button", { name: "Judge", exact: true }).click();
    await api.expectCalled("POST /eval/judge");

    // The same cell now carries TWO judgments — the invariant the drawer
    // advertises ("judgments are append-only", skein-phases.md:160).
    await expect(async () => {
      await page.locator('[data-testid^="score-chip-"]').first().click();
      await expect(page.getByTestId("judgment-entry")).toHaveCount(2, { timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    await page.keyboard.press("Escape");
  });
});
