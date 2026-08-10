import { expect, test } from "./helpers/api";
import { seedChat } from "./helpers/seed";
import { filmed } from "./helpers/hud";

// E2E checklist journey 3 (feature-spec.md:204):
// "Evaluations: select conversations + single turns → configure (endpoints
//  multi-select, version change highlighted) → queue → results fill
//  incrementally"
// Endpoint tags (feature-spec.md:225-228, sketches 02/03/04):
//   GET /agenttrees/{tree}/conversations · GET …/endpoints · GET …/instructions
//   GET /models · GET /eval/rubrics · POST /agenttrees/{tree}/replay
//   GET /agenttrees/{tree}/evaluations/{id}
// The endpoints MULTI-SELECT is the turn re-fire pivot only (openapi.yaml:1490,
// RunConfigPanel showEndpoints) — journey 4 drives it.

const CONV_A = "Evaluations journey A: parcel never arrived";
const CONV_B = "Evaluations journey B: duplicate charge";

test("evaluations: pick conversations + one turn → configure (changed fields) → queue → grid fills", async ({
  page,
  request,
  api,
}) => {
  const step = filmed(page, "Journey 3", 4);
  // Two conversations, two assistant turns each — enough rows that the grid is
  // observably partial when it first renders.
  const a = await seedChat(request, CONV_A);
  await seedChat(request, "And it was marked delivered", { conversationId: a.conversationId });
  const b = await seedChat(request, CONV_B);
  const b2 = await seedChat(request, "The second charge cleared today", {
    conversationId: b.conversationId,
  });

  await step("1 Select: a whole conversation plus a single turn of another", async () => {
    // Results tab, Studio (formerly the bare /evaluations route — UX
    // polish 2026-08-10, Studio merge).
    await page.goto("/studio?tab=results");
    await page.getByRole("button", { name: "New evaluation" }).click();
    await api.expectCalled("GET /agenttrees/{tree}/conversations");
    await page.getByRole("checkbox", { name: `Select ${CONV_A}` }).check();
    await page.getByRole("button", { name: `Toggle turns of ${CONV_B}` }).click();
    await page.getByRole("checkbox", { name: `Select turn ${b2.turnId}` }).check();
    await expect(page.getByTestId("picker-summary")).toHaveText("1 conversation · 1 turn");
  });

  await step("2 Configure: dropdown data loads; a version change is highlighted", async () => {
    await page.getByRole("button", { name: "Configure ▸" }).click();
    // Sketch 03's data sources. NOT endpoints: the endpoints multi-select
    // "only applies to turn re-fire" (openapi.yaml:1490), so the stepper never
    // fetches them — journey 4 asserts GET …/endpoints where it is used.
    await api.expectCalled("GET /models");
    await api.expectCalled("GET /agenttrees/{tree}/agents");
    await api.expectCalled("GET /eval/rubrics");

    const config = page.getByTestId("config-0");
    // "prefilled from the baseline so changing one axis = one field"
    // (feature-spec.md:45): every field starts equal to the baseline, and each
    // deviation — and only it — gets the highlight.
    const changed = config.locator("[data-changed]");
    await expect(changed).toHaveCount(0);

    await config.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: "Concierge" }).click();
    await api.expectCalled("GET /agenttrees/{tree}/agents/{agent}/instructions");
    await expect(changed).toHaveCount(1);

    await config.getByRole("combobox", { name: "Instruction version" }).click();
    await page.getByRole("option", { name: "v1", exact: true }).click();
    await expect(changed).toHaveCount(2);

    await config.getByRole("combobox", { name: "Model", exact: true }).click();
    await page.getByRole("option", { name: "Claude Haiku 4.5" }).click();
    await expect(changed).toHaveCount(3);

    // A second column so the grid is a real comparison.
    await page.getByRole("button", { name: "+ Add config" }).click();
    const second = page.getByTestId("config-1");
    await second.getByRole("combobox", { name: "Model", exact: true }).click();
    await page.getByRole("option", { name: "DeepSeek V3" }).click();
  });

  await step("Queue: the evaluation is accepted and the grid fills incrementally", async () => {
    api.clear();
    await page.getByRole("button", { name: "Queue" }).click();
    await api.expectCalled("POST /agenttrees/{tree}/replay");
    await page.waitForURL(/\/evaluations\/eval_/);
    await api.expectCalled("GET /agenttrees/{tree}/evaluations/{evaluation}");
    await expect(page.getByTestId("comparison-grid")).toBeVisible();

    // 3 rows (2 turns of A + 1 turn of B) × (baseline + 2 configs).
    const done = page.locator('[data-testid^="cell-"][data-status="done"]');
    const early = await done.count();
    await expect(done).toHaveCount(9, { timeout: 120_000 });
    // Only the baseline column is pre-filled, so an "everything at once"
    // render would have shown 9 here — the config columns arrived over the
    // app-wide task stream, live, with no reload.
    expect(early, "cells must arrive incrementally").toBeLessThan(9);
    await api.expectCalled("GET /tasks/stream");
    await expect(page.getByText("done", { exact: true })).toBeVisible();

    // The grid is polled while it fills, so those reads must be CONDITIONAL
    // (item 7 stage F3): after the first, every refetch carries the ETag the
    // previous one returned, and a grid that has not moved answers 304 with no
    // body. Asserted on the request side because that is the half the client
    // owns — the mock's 304 itself is pinned by test_mock.py.
    const reads = api.matching("GET /agenttrees/{tree}/evaluations/{evaluation}");
    expect(reads.length, "the filling grid is polled").toBeGreaterThan(1);
    expect(
      reads.some((r) => r.headers["if-none-match"]),
      "refetches must revalidate rather than re-download",
    ).toBe(true);
  });

  await step("the finished evaluation is listed and re-openable", async () => {
    const evaluationUrl = page.url();
    // The back control is a Mantine Anchor with an onClick and no href, so it
    // has no link role — matched by text (noted for the UX phase).
    await page.getByText("‹ Studio").click();
    // Lands back on Studio's Results tab — EvaluationsPage's own list-mode
    // heading, unchanged by the merge.
    await expect(page.getByRole("heading", { name: "Evaluations" })).toBeVisible();
    await page.goto(evaluationUrl);
    await expect(page.getByTestId("comparison-grid")).toBeVisible();
    await expect(page.locator('[data-testid^="cell-"][data-status="done"]')).toHaveCount(9);
  });
});
