import { expect, test } from "./helpers/api";
import { seedChat } from "./helpers/seed";
import { filmed } from "./helpers/hud";

// E2E checklist journey 7 (feature-spec.md:212):
// "Editor: edit draft → Test in Runs (snapshot) → back → save v16 → run
//  relabels" — the button is "Test as evaluation" since #3.
// Endpoint tags (feature-spec.md:236-237, sketch 06):
//   GET/PUT /agenttrees/{tree}/agents/{id}/instructions
//   POST …/agents/{id}/snapshots · GET/PUT …/agents/{id}/last-selection
//
// Order note: the draft lives in component state, so navigating to Evaluations
// and back discards it — "save v16" therefore happens in the same visit that took
// the snapshot (which is also what makes the save PROMOTE that snapshot, so
// the new version is labelled "from snapshot …"). The hand-off follows. Every
// element of the checklist line is walked; only the order differs.
// (Unsaved-draft persistence is a UX-phase item, not a contract one.)

const CONV = "Editor journey: change my delivery slot";

test("editor: draft → snapshot → save a new version (relabelled) → Test as evaluation", async ({
  page,
  request,
  api,
}) => {
  const step = filmed(page, "Journey 7", 7);
  await seedChat(request, CONV);

  await page.goto("/agents");
  await page.getByRole("button", { name: "Open Refunds" }).click();
  await page.waitForURL(/\/agents\/.+\/editor/);
  await api.expectCalled("GET /agenttrees/{tree}/agents/{agent}/instructions");

  const instructions = page.getByLabel("Instructions");
  await expect(instructions).not.toBeEmpty(); // the live version loaded
  const saveButton = page.getByRole("button", { name: /^Save as v\d+$/ });
  const nextVersion = Number((await saveButton.innerText()).match(/v(\d+)$/)![1]);
  const liveVersion = nextVersion - 1;

  await step("edit the draft: dirty state, nothing written yet", async () => {
    await instructions.fill(
      `${await instructions.inputValue()}\n- Editor journey: confirm the slot in writing.`,
    );
    const draftRow = page.getByTestId("version-draft");
    await expect(draftRow).toContainText("unsaved changes");
    api.expectNotCalled("PUT /agenttrees/{tree}/agents/{agent}/instructions");
  });

  await step("Snapshot draft: the text is frozen immutably", async () => {
    await page.getByRole("button", { name: "Snapshot draft" }).click();
    await api.expectCalled("POST /agenttrees/{tree}/agents/{agent}/snapshots");
    // snapshot ids are 4 chars (mock/main.py:852) → data-testid="snapshot-a3f1"
    await expect(page.locator('[data-testid^="snapshot-"]').first()).toContainText("-draft (");
  });

  await step("diff the draft against the live version", async () => {
    // Mantine's SegmentedControl parks the radio input off-screen; the label
    // is the control a user actually clicks.
    await page.getByText("Diff", { exact: true }).click();
    await expect(page.getByTestId("diff-add").first()).toContainText("confirm the slot");
    await page.getByText("Edit", { exact: true }).click();
  });

  await step(`Save as v${nextVersion}: append-only, and labelled from its snapshot`, async () => {
    await saveButton.click();
    await api.expectCalled("PUT /agenttrees/{tree}/agents/{agent}/instructions");
    const row = page.getByTestId(`version-${nextVersion}`);
    await expect(row).toBeVisible();
    await expect(row.getByText("live")).toBeVisible();
    // THE relabel: the evaluation's snapshot is now identifiable as this version.
    await expect(row).toContainText("from snapshot");
    // Nothing was overwritten — the previous live version is still there, and
    // is no longer live.
    const previous = page.getByTestId(`version-${liveVersion}`);
    await expect(previous).toBeVisible();
    await expect(previous.getByText("live")).toHaveCount(0);
  });

  await step("Test as evaluation: the DRAFT is snapshotted into the config", async () => {
    await instructions.fill(
      `${await instructions.inputValue()}\n- Editor journey: untested draft under test.`,
    );
    api.clear();
    await page.getByRole("button", { name: "Test as evaluation" }).click();
    await api.expectCalled("POST /agenttrees/{tree}/agents/{agent}/snapshots");
    await page.waitForURL(/\/evaluations$/);
    // First time for THIS agent → empty last-selection lands on Pick. The
    // Refunds agent (not Concierge) precisely so that stays true whatever else
    // the suite has already tested — dod.spec.ts leaves Concierge with a
    // remembered selection.
    await api.expectCalled("GET /agenttrees/{tree}/agents/{agent}/last-selection");
    await page.getByRole("checkbox", { name: `Select ${CONV}` }).check();
    await page.getByRole("button", { name: "Configure ▸" }).click();
    await expect(page.getByTestId("snapshot-badge")).toBeVisible();
    await expect(page.getByTestId("snapshot-badge")).toContainText("draft");
  });

  await step("queue it: the evaluation fills against the snapshotted text", async () => {
    await page.getByRole("button", { name: "Queue" }).click();
    await api.expectCalled("PUT /agenttrees/{tree}/agents/{agent}/last-selection");
    await api.expectCalled("POST /agenttrees/{tree}/replay");
    await page.waitForURL(/\/evaluations\/run_/);
    await expect(page.locator('[data-testid^="cell-"][data-status="done"]')).toHaveCount(2, {
      timeout: 120_000,
    });
  });

  await step("repeating the test is two taps (last-selection remembered)", async () => {
    await page.goto("/agents");
    await page.getByRole("button", { name: "Open Refunds" }).click();
    await page.getByRole("button", { name: "Test as evaluation" }).click();
    await page.waitForURL(/\/evaluations$/);
    // Remembered selection → straight to Configure, no re-picking.
    await expect(page.getByTestId("snapshot-badge")).toBeVisible();
  });
});
