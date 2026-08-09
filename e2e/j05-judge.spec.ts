import { API_ORIGIN, expect, test } from "./helpers/api";
import { awaitTask, seedChat, seedReplay, seedRubric } from "./helpers/seed";
import { filmed } from "./helpers/hud";

// E2E checklist journey 5 (feature-spec.md:206):
// "Judge: enable judge → scores stream in → judgment drawer shows reasoning +
//  history; retroactive 'Judge this evaluation'"
// Endpoint tags (feature-spec.md:228-230, sketch 04):
//   GET /eval/rubrics · POST /agenttrees/{tree}/replay (judge in the config)
//   POST /eval/judge (retroactive) · GET /eval/judgments · GET /eval/evaluations/{id}/summary

const CONV = "Judge journey: is my warranty valid?";

test("judge: evaluation with the judge on → scores stream in → drawer reasoning + append-only history", async ({
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

  await step("configure an evaluation with the judge enabled up front", async () => {
    await page.goto("/evaluations");
    await page.getByRole("button", { name: "New evaluation" }).click();
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
    await page.waitForURL(/\/evaluations\/eval_/);
    await expect(page.getByTestId("comparison-grid")).toBeVisible();
    // 2 rows × (baseline + 1 config).
    await expect(page.locator('[data-testid^="cell-"][data-status="done"]')).toHaveCount(4, {
      timeout: 120_000,
    });
    // No second click needed: the judge ran because it was part of the config.
    await expect(page.locator('[data-testid^="score-chip-"]').first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByTestId("evaluation-summary")).toBeVisible();
    await api.expectCalled("GET /eval/evaluations/{evaluation}/summary");
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

  await step('retroactive "Judge this evaluation" appends, never overwrites', async () => {
    api.clear();
    await page.getByRole("button", { name: "⚖ Judge this evaluation" }).click();
    const judgeForm = page.getByTestId("judge-form");
    await judgeForm.getByRole("combobox", { name: "Judge model" }).click();
    await page.getByRole("option", { name: "DeepSeek V3" }).click();
    await judgeForm.getByRole("combobox", { name: "Rubric" }).click();
    await page.getByRole("option", { name: `Journey rubric v${rubric.version}` }).click();
    await judgeForm.getByRole("button", { name: "Judge", exact: true }).click();
    await api.expectCalled("POST /eval/judge");

    // The same cell now carries TWO judgments — the invariant the drawer
    // advertises ("judgments are append-only", cupel-phases.md:160).
    await expect(async () => {
      await page.locator('[data-testid^="score-chip-"]').first().click();
      await expect(page.getByTestId("judgment-entry")).toHaveCount(2, { timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    await page.keyboard.press("Escape");
  });
});

// UX phase — the reload path. The old auto-judge fired only when an OPEN page
// watched a live non-terminal → done transition, so an evaluation that finished
// before anyone opened its link was never judged (no scores, no explanation). The
// rule is now "done + judge configured + not already judged", which makes the same
// page load idempotent: this journey proves both halves — it judges an evaluation
// it never watched finish, and a reload does NOT append a second judging pass.
test("judge: an evaluation that finished before its page was opened is judged, once", async ({
  page,
  request,
  api,
}) => {
  const step = filmed(page, "Journey 5b", 3);
  const rubric = await seedRubric(request, "Reload rubric");
  const chat = await seedChat(request, "Reload journey: is my parcel late?");

  // Queued OUTSIDE the browser and awaited to completion — nobody is watching
  // the evaluation page while it finishes, which is exactly the case that used
  // to produce a permanently unjudged evaluation.
  const replay = await seedReplay(
    request,
    [{ conversation_id: chat.conversationId }],
    [{ model: "claude-haiku-4-5", judge: { judge_model: "claude-haiku-4-5", rubric_id: rubric.id } }],
  );
  await awaitTask(request, replay.task_id);

  const judgmentCount = async () => {
    const res = await request.get(`${API_ORIGIN}/eval/judgments?evaluation_id=${replay.evaluation_id}&page_size=200`);
    expect(res.ok(), await res.text()).toBeTruthy();
    return ((await res.json()) as unknown[]).length;
  };
  expect(await judgmentCount(), "the evaluation is unjudged until the page opens").toBe(0);

  let judged = 0;
  await step("open the finished evaluation's link — the judge fires anyway", async () => {
    await page.goto(`/evaluations/${replay.evaluation_id}`);
    await expect(page.getByTestId("comparison-grid")).toBeVisible();
    // The idempotency probe, then the judging pass it did not veto.
    await api.expectCalled("GET /eval/judgments");
    await api.expectCalled("POST /eval/judge");
    await expect(page.locator('[data-testid^="score-chip-"]').first()).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByTestId("evaluation-summary")).toBeVisible();
    await expect(page.getByTestId("judging-badge")).toBeHidden({ timeout: 120_000 });
    judged = await judgmentCount();
    expect(judged).toBeGreaterThan(0);
  });

  await step("reload: scores are still there and NO second pass is appended", async () => {
    api.clear();
    await page.reload();
    await expect(page.locator('[data-testid^="score-chip-"]').first()).toBeVisible({
      timeout: 120_000,
    });
    // The probe runs again and this time finds judgments → no POST.
    await api.expectCalled("GET /eval/judgments");
    api.expectNotCalled("POST /eval/judge");
    expect(await judgmentCount(), "judging is append-only — a reload must not duplicate").toBe(
      judged,
    );
  });

  await step("navigating away and back is idempotent too", async () => {
    api.clear();
    await page.getByRole("link", { name: "Evaluations" }).first().click();
    await page.waitForURL(/\/evaluations$/);
    await page.goto(`/evaluations/${replay.evaluation_id}`);
    await expect(page.locator('[data-testid^="score-chip-"]').first()).toBeVisible({
      timeout: 120_000,
    });
    await api.expectCalled("GET /eval/judgments");
    api.expectNotCalled("POST /eval/judge");
    expect(await judgmentCount()).toBe(judged);
  });
});
