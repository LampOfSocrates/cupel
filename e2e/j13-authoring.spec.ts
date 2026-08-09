import { expect, test } from "./helpers/api";
import { seedChat } from "./helpers/seed";
import { filmed } from "./helpers/hud";

// E2E checklist journey 13 — the last numbered journey in the Phase-2 test
// deliverable list (cupel-phases.md:98) is the "authoring/PR loop", which is
// PRO TIER and excluded from the free build (TASKS.md: ~~P2-T20 repo/PR~~ →
// P4-REPO). NOT APPLICABLE as written.
//
// Its free-tier equivalent — the authoring loop this build actually ships — is
// the eval workbench plus Inspector → casebook → eval set → replay:
// notice something in real traffic, turn it into cases, and make it
// a regression suite. Endpoint tags (feature-spec.md:235, 241-242, sketch 10):
//   POST/PUT /eval/rubrics · POST/PUT /eval/cases · POST/PUT /eval/sets
//   POST /eval/cases/import · POST /eval/judge
//   GET /admin/conversations · POST /casebooks · POST /casebooks/{id}/items
//   POST /casebooks/{id}/to-eval-set · POST /casebooks/{id}/replay

const CSV = [
  "prompt,answer,expected",
  '"Where is my order?","It shipped Tuesday.","Give the tracking link."',
  '"Can I return this?","Yes, within 30 days.","State the 30-day window."',
  '"Do you price match?","We do.","Name the competitors covered."',
].join("\n");

test("eval workbench: rubric → case → judge → spreadsheet import → set membership", async ({
  page,
  api,
}) => {
  const step = filmed(page, "Journey 13", 5);
  await page.goto("/eval");
  await expect(page.getByRole("heading", { name: "Eval workbench" })).toBeVisible();

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
    await api.expectCalled("PUT /eval/rubrics/{rubric}");
    await expect(page.getByTestId("rubric-notice")).toBeVisible();
  });

  await step("cases: hand-craft one with a reference answer", async () => {
    await page.getByRole("tab", { name: "Cases" }).click();
    await page.getByRole("button", { name: "+ New case" }).click();
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

  await step("import a spreadsheet into a brand-new set", async () => {
    await page.getByRole("button", { name: "⇪ Import" }).click();
    // Scoped to the modal: the case editor behind it has same-named fields.
    const modal = page.getByRole("dialog");
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
    await modal.getByRole("radio", { name: "New set" }).check();
    await modal.getByLabel("New set name").fill("Imported policy cases");
    await modal.getByRole("button", { name: "Import", exact: true }).click();
    await api.expectCalled("POST /eval/cases/import");
    // Per-row report, inline for a small file (openapi.yaml:1385-1389).
    await expect(modal.getByTestId("import-report")).toContainText("3");
    await modal.getByRole("button", { name: "Close" }).click();
  });

  await step("sets: the imported set exists and membership versions append", async () => {
    await page.getByRole("tab", { name: "Sets" }).click();
    await api.expectCalled("GET /eval/sets");
    const row = page.locator('[data-testid^="set-row-"]', { hasText: "Imported policy cases" });
    await expect(row).toBeVisible();
    await row.click();
    await page.locator('[data-testid^="toggle-"]').first().click();
    await page.getByRole("button", { name: "Save membership as new version" }).click();
    await api.expectCalled("PUT /eval/sets/{set}");
    await expect(page.getByTestId("set-notice")).toBeVisible();
  });
});

test("inspector → casebook → eval set + replay suite", async ({ page, request, api }) => {
  const step = filmed(page, "Journey 13", 4);
  // Real traffic to notice: a machine-origin conversation, exactly what the
  // generator drips in (mock/generator.py).
  const noticed = await seedChat(request, "Inspector journey: refund denied", {
    origin: "machine",
  });

  await step("Inspector lists conversations across users", async () => {
    await page.goto("/");
    await page.getByRole("link", { name: "Inspector" }).click();
    await page.waitForURL(/\/inspector/);
    await api.expectCalled("GET /admin/conversations");
    await expect(page.getByRole("columnheader", { name: "User" })).toBeVisible();
    await expect(page.getByTestId("inspector-count")).toContainText("conversations");
  });

  await step("read a conversation and collect a turn into a new casebook", async () => {
    await page
      .getByTestId("inspector-row")
      .filter({ hasText: "Inspector journey" })
      .first()
      .click();
    await expect(page.getByTestId("inspector-reader")).toBeVisible();
    await page.getByTestId("reader-collect").click();
    await page.getByLabel("New casebook name").fill("Journey casebook");
    await page.getByRole("button", { name: "Create + add" }).click();
    await api.expectCalled("POST /casebooks");
    await api.expectCalled("POST /casebooks/{casebook}/items");
    await expect(page.getByTestId("collect-done")).toBeVisible();
  });

  await step("the casebook becomes an eval set", async () => {
    await page.goto("/casebooks");
    await api.expectCalled("GET /casebooks");
    await page.getByTestId("casebook-row").filter({ hasText: "Journey casebook" }).click();
    await expect(page.getByTestId("casebook-item")).toHaveCount(1);
    await page.getByLabel("Eval set name").fill("Journey regression set");
    await page.getByRole("button", { name: "Create eval set" }).click();
    await api.expectCalled("POST /casebooks/{casebook}/to-eval-set");
    await expect(page.getByTestId("casebook-set-created")).toBeVisible();
  });

  await step("and a replay suite: the same turns re-fired as an evaluation", async () => {
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    await api.expectCalled("POST /casebooks/{casebook}/replay");
    const accepted = page.getByTestId("casebook-replay-accepted");
    await expect(accepted).toBeVisible();
    await accepted.getByRole("link").last().click();
    await page.waitForURL(/\/evaluations\/run_/);
    await expect(page.locator('[data-testid^="cell-"][data-status="done"]')).toHaveCount(2, {
      timeout: 120_000,
    });
    expect(noticed.conversationId).toBeTruthy();
  });
});
