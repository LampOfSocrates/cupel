import { API_ORIGIN, expect, test } from "./helpers/api";
import { awaitTask, seedChat, seedReplay } from "./helpers/seed";
import { filmed } from "./helpers/hud";

// E2E checklist journey 6 (feature-spec.md:207):
// "Queue: parent/child progress via SSE, cancel cascades, injected failure →
//  retry-failed succeeds"
// Endpoint tags (feature-spec.md:241, sketch 05):
//   GET /tasks · GET /tasks/stream (SSE) · DELETE /tasks/{id}
//   POST /tasks/{id}/retry-failed
//
// The injected failure is deterministic: playwright.config.ts sets
// MOCK_FAIL_MARKER, and mock/config.py fail_marker() fails the FIRST attempt at
// any batch child whose payload mentions it — so the retry succeeds and the
// spec can assert exact counts. Only this spec puts the marker in a prompt.

const FAIL_MARKER = "CUPEL-E2E-INJECTED-FAILURE";
const FAIL_CONV = `${FAIL_MARKER} retry me`; // <48 chars → title verbatim

test("queue: parent/child progress → cancel cascades → injected failure → retry-failed", async ({
  page,
  request,
  api,
}) => {
  const step = filmed(page, "Journey 6", 3);
  await step("a big batch shows live parent + child progress", async () => {
    // Enough work that the batch is genuinely in flight while we watch it —
    // the deterministic seed dataset (global-setup) supplies the conversations.
    const list = await request.get(`${API_ORIGIN}/agenttrees/agent1/conversations`);
    const selection = (await list.json()).items
      .slice(0, 12)
      .map((c: { id: string }) => ({ conversation_id: c.id }));
    expect(selection.length).toBeGreaterThan(8);
    const big = await seedReplay(
      request,
      selection,
      ["claude-haiku-4-5", "deepseek-v3", "gemini-flash", "claude-sonnet-5"].map((model) => ({
        model,
      })),
    );

    await page.goto("/queue");
    await expect(page.getByText("SSE live")).toBeVisible();
    const row = page.getByTestId(`task-${big.task_id}`);
    await expect(row).toBeVisible();
    await expect(row.getByRole("progressbar")).toBeVisible();
    // "3/48 · 2m14s" — the stage counter moves without a reload (the one
    // app-wide /tasks/stream).
    await expect(row).toContainText(/\d+\/\d+/);
    await api.expectCalled("GET /tasks/stream");

    await test.step("cancel cascades to the children", async () => {
      await row.getByRole("button", { name: "Toggle children of Replay" }).click();
      await api.expectCalled("GET /tasks");
      await expect(page.getByTestId(`children-${big.task_id}`)).toBeVisible();

      await row.getByRole("button", { name: "Cancel Replay" }).click();
      await api.expectCalled("DELETE /tasks/{id}");
      await expect(row).toContainText("cancelled");

      // The cascade is the point: no child is left running behind a cancelled
      // parent (feature-spec.md:106 "cancel (parent cancels children)").
      await expect
        .poll(async () => {
          const res = await request.get(`${API_ORIGIN}/tasks?parent_id=${big.task_id}`);
          const children = await res.json();
          return children.filter(
            (c: { status: string }) => c.status === "queued" || c.status === "running",
          ).length;
        })
        .toBe(0);
    });
  });

  const chat = await seedChat(request, FAIL_CONV);
  const failEvaluation = await seedReplay(request, [{ conversation_id: chat.conversationId }], [
    { model: "deepseek-v3" },
  ]);
  const failRow = page.getByTestId(`task-${failEvaluation.task_id}`);

  await step("an injected failure fails one child, not the batch", async () => {
    await awaitTask(request, failEvaluation.task_id);
    await page.goto("/queue");
    await failRow.getByRole("button", { name: "Toggle children of Replay" }).click();
    await expect(page.getByTestId(`children-${failEvaluation.task_id}`)).toContainText("failed");
    // Partial failure, not a dead batch (feature-spec.md:106).
    await expect(failRow).toContainText("done");
  });

  await step("retry-failed re-runs just the failure, and it succeeds", async () => {
    api.clear();
    await failRow.getByRole("button", { name: "Retry failed" }).click();
    await api.expectCalled("POST /tasks/{id}/retry-failed");
    // The child that failed once now completes, so nothing is left to retry.
    await expect(page.getByTestId(`children-${failEvaluation.task_id}`)).not.toContainText("failed", {
      timeout: 60_000,
    });
    await expect(failRow.getByRole("button", { name: "Retry failed" })).toHaveCount(0);
  });
});
