import { API_ORIGIN, expect, test } from "./helpers/api";
import { seedChat } from "./helpers/seed";
import { filmed } from "./helpers/hud";

// E2E checklist journey 4 (feature-spec.md:205):
// "Forks: 🔀 a turn against 2 endpoints → 2 new conversations with lineage →
//  Open in Chat → continue"
// Endpoint tags (feature-spec.md:224-227, sketch 01/04):
//   GET /agenttrees/{tree}/endpoints (the multi-select's data)
//   POST /agenttrees/{tree}/replay/turn · POST /agenttrees/{tree}/chat
//
// dod.spec.ts forks to 2 endpoints and checks the comparison grid; this
// journey carries it through to "a fork is a real conversation you continue".

const MSG = "Fork journey: escalate my complaint";

test("forks: re-fire one turn at 2 endpoints → open a fork in Chat → continue it", async ({
  page,
  request,
  api,
}) => {
  const step = filmed(page, "Journey 4", 6);
  const chat = await seedChat(request, MSG);
  await page.goto(`/chat/${chat.conversationId}`);
  await expect(page.getByTestId("transcript")).toContainText(MSG);
  // The transcript is its OWN collection now (item 7 stage F2): opening a
  // conversation fetches the resource and a page of its turns, never one
  // response carrying every turn ever written into it.
  await api.expectCalled("GET /agenttrees/{tree}/conversations/{id}");
  await api.expectCalled("GET /agenttrees/{tree}/conversations/{id}/turns");

  await step("⑂ a turn against prod + staging", async () => {
    await page.getByRole("button", { name: "Fork turn" }).click();
    await api.expectCalled("GET /agenttrees/{tree}/endpoints");
    await page.getByRole("combobox", { name: "Endpoints" }).click();
    await page.getByRole("option", { name: "prod" }).click();
    await page.getByRole("option", { name: "staging" }).click();
    await page.keyboard.press("Escape"); // close the dropdown, keep the modal
    await page.getByRole("button", { name: "Fork ⑂" }).click();
    await api.expectCalled("POST /agenttrees/{tree}/replay/turn");
  });

  await step("2 new conversations come back, one per endpoint", async () => {
    const results = page.getByTestId("fork-results");
    await expect(results).toBeVisible();
    await expect(results.getByText("Open in Chat ↗")).toHaveCount(2);
  });

  await step("Open in Chat: the fork is a real conversation with lineage", async () => {
    await page.getByTestId("fork-results").getByText("Open in Chat ↗").first().click();
    await page.waitForURL(/\/chat\/conv_/);
    const lineage = page.getByTestId("lineage-banner");
    await expect(lineage).toBeVisible();
    await expect(lineage).toContainText("fork of");
    await expect(lineage).toContainText(chat.turnId);
  });

  await step("continue the fork: it takes new turns like any conversation", async () => {
    api.clear();
    await page.getByPlaceholder("Message…").fill("Fork journey: and then what happened?");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByTestId("streaming-turn")).toHaveCount(0, { timeout: 30_000 });
    await api.expectCalled("POST /agenttrees/{tree}/chat");
    await expect(page.getByTestId("transcript")).toContainText("and then what happened?");
    // Still a fork after continuing — lineage is permanent, not a draft state.
    await expect(page.getByTestId("lineage-banner")).toBeVisible();
  });

  await step("Compare siblings: both endpoints' forks side by side", async () => {
    await page.getByText("Compare siblings").click();
    await page.waitForURL(/\/forks\//);
    await expect(page.getByTestId("sibling-grid")).toBeVisible();
    await expect(page.getByTestId("sibling-baseline")).toBeVisible();
    await expect(page.locator('[data-testid^="sibling-conv_"]')).toHaveCount(2);
  });

  await step("both forks are conversations of their own, with lineage", async () => {
    // The nesting UI is journey 1's; here the claim is the data one — two NEW
    // conversations, each stamped with the endpoint it was fired at.
    const res = await request.get(
      `${API_ORIGIN}/agenttrees/agent1/conversations?forks_of=${chat.conversationId}`,
    );
    const { items } = await res.json();
    expect(items).toHaveLength(2);
    expect(items.map((c: { lineage: { endpoint_id: string } }) => c.lineage.endpoint_id).sort()).toEqual([
      "ep_agent1_prod",
      "ep_agent1_staging",
    ]);
    for (const fork of items) {
      expect(fork.lineage.parent_conversation_id).toBe(chat.conversationId);
      expect(fork.lineage.fork_turn_id).toBe(chat.turnId);
    }
  });

  await step("delete the parent: the forks outlive it and it reads as a tombstone", async () => {
    // Soft delete, made VISIBLE (item 7 stage F6). The claim is the live one:
    // deleting a parent cascades to nothing, and the fork's banner says
    // "parent deleted" because the parent ANSWERS with deleted true — not
    // because a 404 was guessed at.
    const gone = await request.delete(
      `${API_ORIGIN}/agenttrees/agent1/conversations/${chat.conversationId}`,
    );
    expect(gone.status()).toBe(204);
    const tomb = await request.get(
      `${API_ORIGIN}/agenttrees/agent1/conversations/${chat.conversationId}`,
    );
    expect(tomb.status()).toBe(200);
    expect((await tomb.json()).deleted).toBe(true);
    const forks = await request.get(
      `${API_ORIGIN}/agenttrees/agent1/conversations?forks_of=${chat.conversationId}`,
    );
    expect((await forks.json()).items).toHaveLength(2);

    await page.reload();
    await expect(page.getByText("parent deleted")).toBeVisible();
  });
});
