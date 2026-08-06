import { API_ORIGIN, expect, test } from "./helpers/api";
import { seedChat } from "./helpers/seed";

// E2E checklist journey 8 (feature-spec.md:213):
// "Trace: ⌁ opens tree + waterfall, span drawer lazy-loads payload, totals
//  match seed"
// Endpoint tags (feature-spec.md:244, sketch 08):
//   GET /agenttrees/{tree}/turns/{id}/trace · GET /spans/{id}/payload

const CONV = "Trace journey: why was I charged twice?";

test("trace: ⌁ → call tree + waterfall → span drawer lazy-loads its payload", async ({
  page,
  request,
  api,
}) => {
  const chat = await seedChat(request, CONV);

  // The totals the header must match, straight from the contract response.
  // The mock's generation is deterministic (mock/util.py det_hash), so these
  // are the same numbers on every run of this seeded input.
  const traceRes = await request.get(
    `${API_ORIGIN}/agenttrees/agent1/turns/${chat.turnId}/trace`,
  );
  expect(traceRes.ok()).toBeTruthy();
  const { totals, spans } = await traceRes.json();
  expect(spans.length).toBeGreaterThan(0);

  await test.step("⌁ on a turn opens its trace", async () => {
    await page.goto(`/chat/${chat.conversationId}`);
    await page.getByTestId("transcript").getByRole("button", { name: "Open trace" }).click();
    await page.waitForURL(/\/trace\//);
    await api.expectCalled("GET /agenttrees/{tree}/turns/{turn}/trace");
  });

  await test.step("totals in the header match the seeded trace exactly", async () => {
    // "Trace · <turn> · 4.9s · 6410→1240 tok · $0.0110" (sketch 08).
    const header = page.getByRole("heading", { level: 4 });
    await expect(header).toContainText(`Trace · ${chat.turnId}`);
    await expect(header).toContainText(`${totals.tokens_in}→${totals.tokens_out} tok`);
    await expect(header).toContainText(`$${totals.cost.toFixed(4)}`);
    await expect(page.getByTestId("envelope-chip")).toBeVisible();
  });

  await test.step("call tree and waterfall both render every span", async () => {
    await expect(page.getByTestId("call-tree")).toBeVisible();
    await expect(page.getByTestId("waterfall")).toBeVisible();
    await expect(page.locator('[data-testid^="wf-bar-"]')).toHaveCount(spans.length);
  });

  await test.step("the span payload is LAZY — fetched only when a span is opened", async () => {
    api.expectNotCalled("GET /spans/{id}/payload");
    await page.getByTestId("call-tree").getByRole("button").last().click();
    await expect(page.getByTestId("span-drawer")).toBeVisible();
    await api.expectCalled("GET /spans/{id}/payload");
    // The LLM leaf carries model + exact tokens + cost (mock/engine.py emits
    // agent → tool → llm).
    await expect(page.getByTestId("span-stats")).toContainText("$");
    await expect(page.getByTestId("span-model")).toBeVisible();
  });

  await test.step("the waterfall selects the same spans", async () => {
    await page.keyboard.press("Escape");
    const bar = page.getByTestId("wf-bar-0");
    await bar.click();
    await expect(bar).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("span-drawer")).toBeVisible();
  });
});
