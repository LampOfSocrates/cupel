import { expect, test } from "./helpers/api";
import { seedChat } from "./helpers/seed";
import { filmed } from "./helpers/hud";

// E2E checklist journey 13 — the last numbered journey in the Phase-2 test
// deliverable list is the "authoring/PR loop", and repo/PR integration is not
// built yet (it is the Agents-as-Code item on TASKS.md, ordinary roadmap work
// — there is no paid tier). NOT APPLICABLE as written.
//
// The authoring loop this build actually ships is
// the eval workbench plus Inspector → eval benchmark → replay: notice
// something in real traffic, collect it, and make it a regression suite.
// Since Casebook and EvalBenchmark (named EvalSet before the later
// benchmark-flavored rename) merged there is one noun for that, so the middle
// hop is gone: no casebook to convert, just a benchmark whose items start as
// live turn references.
// Endpoint tags (feature-spec.md:231, 241-242, sketch 10):
//   POST /eval/rubrics · POST /eval/rubrics/{id}/versions
//   POST /eval/cases · POST /eval/cases/{id}/versions
//   POST /eval/benchmarks · POST /eval/benchmarks/{id}/versions
//   POST /eval/cases/import · POST /eval/judge
//   GET /admin/conversations · POST /eval/benchmarks/{id}/items
//   POST /eval/benchmarks/{id}/replay · POST /eval/benchmarks/{id}/freeze

const CSV = [
  "prompt,answer,expected",
  '"Where is my order?","It shipped Tuesday.","Give the tracking link."',
  '"Can I return this?","Yes, within 30 days.","State the 30-day window."',
  '"Do you price match?","We do.","Name the competitors covered."',
].join("\n");

test("eval workbench: rubric → case → judge → spreadsheet import → benchmark membership", async ({
  page,
  api,
}) => {
  const step = filmed(page, "Journey 13", 5);
  // /eval redirects into /studio (UX polish 2026-08-10, Studio merge) —
  // goto'ing the old path exercises that redirect still resolves.
  await page.goto("/eval");
  await expect(page.getByRole("heading", { name: "Studio" })).toBeVisible();

  await step("rubrics: create one, then save a second version of it", async () => {
    await page.getByRole("tab", { name: "Rubrics" }).click();
    // A rubric IS its scoring prompt — both fields are required to create one.
    await page.getByLabel("Rubric prompt").fill("Score 0-1: is the reply helpful?");
    await page.getByLabel("New rubric name").fill("Workbench rubric");
    await page.getByRole("button", { name: "Create rubric" }).click();
    await api.expectCalled("POST /eval/rubrics");
    const row = page.locator('[data-testid^="rubric-row-"]', { hasText: "Workbench rubric" });
    await expect(row).toBeVisible();

    await row.click();
    await page.getByLabel("Rubric prompt").fill("Score 0-1: does the reply state the policy?");
    await page.getByRole("button", { name: "Save as new version" }).click();
    // Append-only: a rubric edit is a NEW version, never an overwrite.
    await api.expectCalled("POST /eval/rubrics/{rubric}/versions");
    await expect(page.getByTestId("rubric-notice")).toBeVisible();
  });

  await step("cases: hand-craft one with a reference answer", async () => {
    await page.getByRole("tab", { name: "Cases" }).click();
    await page.getByRole("button", { name: "+ New case" }).click();
    await page.getByLabel("Target tree").fill("agent1");
    await page.getByLabel("Input (prompt)").fill("Do you price match a competitor?");
    await page.getByLabel("Output (candidate response)").fill("We match most competitors.");
    await page.getByLabel("Reference (expected answer)").fill("Name the competitors covered.");
    await page.getByRole("button", { name: "Create case" }).click();
    await api.expectCalled("POST /eval/cases");
    await expect(page.locator('[data-testid^="case-row-"]').first()).toBeVisible();
  });

  await step("judge the case against the rubric; history is append-only", async () => {
    await page.getByRole("combobox", { name: "Rubric" }).click();
    await page.getByRole("option", { name: /Workbench rubric/ }).click();
    await page.getByRole("combobox", { name: "Judge model" }).click();
    await page.getByRole("option", { name: "Claude Sonnet 5" }).click();
    await page.getByRole("button", { name: "Judge case" }).click();
    await api.expectCalled("POST /eval/judge");
    await expect(page.getByText("Judging queued")).toBeVisible();
    await expect(page.getByText("Judgment history (append-only)")).toBeVisible();

    // Judging is a queued task; re-selecting the case refetches its trail.
    const caseRow = page.locator('[data-testid^="case-row-"]').first();
    await expect(async () => {
      await caseRow.click();
      await expect(page.getByText("No judgments yet for this case.")).toHaveCount(0, {
        timeout: 3_000,
      });
    }).toPass({ timeout: 60_000 });
    await api.expectCalled("GET /eval/judgments");
  });

  await step("import a spreadsheet into a brand-new benchmark", async () => {
    await page.getByRole("button", { name: "⇪ Import" }).click();
    // Scoped to the modal: the case editor behind it has same-named fields.
    const modal = page.getByRole("dialog");
    await modal.getByLabel("Target tree").fill("agent1");
    // Mantine's FileInput is a button over a hidden input — go through the
    // file chooser the way a user does.
    const chooser = page.waitForEvent("filechooser");
    await modal.getByLabel("Spreadsheet").click();
    await (await chooser).setFiles({
      name: "refund-cases.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(CSV),
    });
    // The header row is parsed in the browser, so the column mapping arrives
    // pre-filled and is a pick, not typing.
    await expect(modal.getByRole("combobox", { name: "Input (prompt)" })).toHaveValue("prompt");
    await expect(modal.getByRole("combobox", { name: "Output (candidate)" })).toHaveValue(
      "answer",
    );
    await expect(modal.getByRole("combobox", { name: "Reference (expected)" })).toHaveValue(
      "expected",
    );
    await modal.getByRole("radio", { name: "New benchmark" }).check();
    await modal.getByLabel("New benchmark name").fill("Imported policy cases");
    await modal.getByRole("button", { name: "Import", exact: true }).click();
    await api.expectCalled("POST /eval/cases/import");
    // Per-row report, inline for a small file.
    await expect(modal.getByTestId("import-report")).toContainText("3");
    await modal.getByRole("button", { name: "Close" }).click();
  });

  await step("benchmarks: the imported benchmark exists and membership versions append", async () => {
    await page.getByRole("tab", { name: "Benchmarks" }).click();
    await api.expectCalled("GET /eval/benchmarks");
    const row = page.locator('[data-testid^="benchmark-row-"]', {
      hasText: "Imported policy cases",
    });
    await expect(row).toBeVisible();
    await row.click();
    await page.locator('[data-testid^="toggle-"]').first().click();
    await page.getByRole("button", { name: "Save membership as new version" }).click();
    await api.expectCalled("POST /eval/benchmarks/{benchmark}/versions");
    await expect(page.getByTestId("benchmark-notice")).toBeVisible();
  });
});

test("inspector → eval benchmark + replay suite", async ({ page, request, api }) => {
  // Three steps, not four: "the casebook becomes an eval benchmark" was a step
  // about POST /casebooks/{id}/to-eval-set, and that endpoint no longer
  // exists — materializing is now freezing items in place, inside the
  // benchmark they are already in.
  const step = filmed(page, "Journey 13", 3);
  // Real traffic to notice: a machine-origin conversation, exactly what the
  // generator drips in (mock/generator.py).
  const noticed = await seedChat(request, "Inspector journey: refund denied", {
    origin: "machine",
  });

  await step("Inspector lists conversations across users", async () => {
    await page.goto("/");
    // Inspector is a Studio tab now (UX polish 2026-08-10, Studio merge) —
    // switching tabs is local state, so no URL change to wait on.
    await page.getByRole("link", { name: "Studio" }).click();
    await page.waitForURL(/\/studio$/);
    await page.getByRole("tab", { name: "Inspector" }).click();
    await api.expectCalled("GET /admin/conversations");
    await expect(page.getByRole("columnheader", { name: "User" })).toBeVisible();
    await expect(page.getByTestId("inspector-count")).toContainText("conversations");
  });

  await step("read a conversation and collect a turn into a new eval benchmark", async () => {
    await page
      .getByTestId("inspector-row")
      .filter({ hasText: "Inspector journey" })
      .first()
      .click();
    await expect(page.getByTestId("inspector-reader")).toBeVisible();
    await page.getByTestId("reader-collect").click();
    await page.getByLabel("New eval benchmark name").fill("Journey benchmark");
    await page.getByRole("button", { name: "Create + add" }).click();
    await api.expectCalled("POST /eval/benchmarks");
    await api.expectCalled("POST /eval/benchmarks/{benchmark}/items");
    // Versioned membership, surfaced: collecting appended a version.
    await expect(page.getByTestId("collect-done")).toContainText("v2");
  });

  await step(
    "the benchmark is a regression suite: replay its references, then freeze them",
    async () => {
      await page.goto("/studio");
      await page.getByRole("tab", { name: "Benchmarks" }).click();
      await api.expectCalled("GET /eval/benchmarks");
      await page
        .locator('[data-testid^="benchmark-row-"]', { hasText: "Journey benchmark" })
        .click();
      await expect(page.getByTestId("benchmark-item")).toHaveCount(1);

      await page.getByRole("button", { name: "Replay", exact: true }).click();
      await api.expectCalled("POST /eval/benchmarks/{benchmark}/replay");
      const accepted = page.getByTestId("benchmark-replay-accepted");
      await expect(accepted).toBeVisible();

      // Freezing is what "turn a casebook into an eval benchmark" became: the
      // same item, flipped in place, appending a membership version.
      await page.getByRole("button", { name: /Freeze 1 reference/ }).click();
      await api.expectCalled("POST /eval/benchmarks/{benchmark}/freeze");
      await expect(page.getByTestId("benchmark-notice")).toContainText("version");
      await expect(page.getByTestId("benchmark-item")).toContainText("frozen case");

      await accepted.getByRole("link").last().click();
      await page.waitForURL(/\/evaluations\/eval_/);
      await expect(page.locator('[data-testid^="cell-"][data-status="done"]')).toHaveCount(2, {
        timeout: 120_000,
      });
      expect(noticed.conversationId).toBeTruthy();
    },
  );
});
