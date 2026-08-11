import { API_ORIGIN, expect, test } from "./helpers/api";
import { awaitTask, seedChat, seedReplay, signInApi } from "./helpers/seed";
import { signIn } from "./helpers/auth";
import { filmed } from "./helpers/hud";

// E2E checklist journey 11 (feature-spec.md:212):
// "Tree disable: admin disables tree 2 → hidden for non-admin, chat against it
//  409s, its queued tasks cancel, old conversations read-only; re-enable
//  restores"
// Endpoint tags (feature-spec.md:245):
//   GET /agenttrees (incl. disabled, for admins) · PATCH /admin/agenttrees/{id}
//
// AUTH_MODE=on: "hidden for non-admin" needs a real non-admin. restricted@demo
// is seeded WITHOUT agent2, so the spec grants it view first (and restores it
// afterwards) — otherwise the tree is invisible for the wrong reason.

test.skip(process.env.AUTH_E2E !== "1", "auth-on journey — run via npm run e2e:auth");

const RESTRICTED_SEEDED = { agent1: ["view", "evaluate"] };

async function setTreeEnabled(
  request: import("@playwright/test").APIRequestContext,
  token: string,
  tree: string,
  enabled: boolean,
) {
  const res = await request.patch(`${API_ORIGIN}/admin/agenttrees/${tree}`, {
    data: { enabled },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

// Both trees enabled and restricted@demo back to its seeded rights, whatever
// happened above — a half-disabled tree would poison every later spec.
test.afterEach(async ({ request }) => {
  const token = await signInApi(request, "admin@demo");
  await setTreeEnabled(request, token, "agent1", true);
  await setTreeEnabled(request, token, "agent2", true);
  await request.put(`${API_ORIGIN}/admin/users/u_restricted/permissions`, {
    data: { permissions: RESTRICTED_SEEDED },
    headers: { Authorization: `Bearer ${token}` },
  });
});

test(
  "tree disable: agent2 goes read-only — hidden, 409s, queued work cancelled — then restores",
  { tag: "@auth-on" },
  async ({ page, request, api }) => {
    const step = filmed(page, "Journey 11", 5);
    const admin = await signInApi(request, "admin@demo");
    const adminAuth = { Authorization: `Bearer ${admin}` };

    // A non-admin who CAN see agent2, so "hidden" means disabled, not unpermitted.
    await request.put(`${API_ORIGIN}/admin/users/u_restricted/permissions`, {
      data: { permissions: { ...RESTRICTED_SEEDED, agent2: ["view"] } },
      headers: adminAuth,
    });
    const restricted = await signInApi(request, "restricted@demo");
    const restrictedAuth = { Authorization: `Bearer ${restricted}` };

    // Existing agent2 history, plus work still in flight when the tree goes down.
    const history = await seedChat(request, "Ops history: nightly job failed", {
      tree: "agent2",
      token: admin,
    });
    await seedChat(request, "And the rollout stalled at 40%", {
      tree: "agent2",
      conversationId: history.conversationId,
      token: admin,
    });
    let inFlight: { task_id: string; evaluation_id: string };

    await step("an admin disables the tree from Settings", async () => {
      await page.goto("/");
      await page.waitForURL(/\/login/);
      await signIn(page, "admin@demo");
      // Wait for the booted session: a goto here would race the post-login
      // boot and land on a page with no /me yet.
      await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
      await page.goto("/settings");
      await expect(page.getByText("Agent trees", { exact: true })).toBeVisible();
      await expect(page.getByLabel("agent2 enabled")).toBeChecked();

      // The toggle asks first — history stays, new work stops.
      page.once("dialog", (dialog) => {
        expect(dialog.message()).toContain("history stays readable");
        void dialog.accept();
      });
      api.clear();
      // Queue work IMMEDIATELY before the toggle so the batch is genuinely
      // still running when the tree goes down — 40 columns × 2 turns at the
      // e2e step delay is seconds of work, the toggle is milliseconds away.
      inFlight = await seedReplay(
        request,
        [{ conversation_id: history.conversationId }],
        Array.from({ length: 40 }, (_, i) => ({ model: "deepseek-v3", temperature: i / 100 })),
        { tree: "agent2", token: admin },
      );
      // force: Mantine's Switch paints a track over its own input.
      await page.getByLabel("agent2 enabled").uncheck({ force: true });
      await api.expectCalled("PATCH /admin/agenttrees/{tree}");
      await expect(page.getByLabel("agent2 enabled")).not.toBeChecked();
      await expect(page.getByText("disabled", { exact: true })).toBeVisible();
    });

    await step("its queued work is cancelled", async () => {
      const task = await awaitTask(request, inFlight.task_id, admin);
      expect(task.status).toBe("cancelled");
    });

    await step("new work 409s with tree_disabled; history still reads", async () => {
      const chat = await request.post(`${API_ORIGIN}/agenttrees/agent2/chat`, {
        data: { message: "should be refused", stream: false },
        headers: adminAuth,
      });
      expect(chat.status()).toBe(409);
      expect((await chat.json()).code).toBe("tree_disabled");

      const replay = await request.post(`${API_ORIGIN}/agenttrees/agent2/replay`, {
        data: {
          selection: [{ conversation_id: history.conversationId }],
          configs: [{ model: "deepseek-v3" }],
        },
        headers: adminAuth,
      });
      expect(replay.status()).toBe(409);

      // READ-ONLY, not gone: the transcript and its trace are still there…
      const read = await request.get(
        `${API_ORIGIN}/agenttrees/agent2/conversations/${history.conversationId}`,
        { headers: adminAuth },
      );
      expect(read.status()).toBe(200);
      // … while every write against it is refused.
      const rename = await request.patch(
        `${API_ORIGIN}/agenttrees/agent2/conversations/${history.conversationId}`,
        { data: { title: "nope" }, headers: adminAuth },
      );
      expect(rename.status()).toBe(409);
    });

    // The five writes whose 409 the contract did not declare until v0.4.0
    // stage F7. They always behaved this way; only openapi.yaml was silent,
    // so an adopter reading the contract would have built a client that
    // treated any of these as an unexpected failure.
    await step("the rest of the blocked write set 409s too, as now declared", async () => {
      const agentId = (
        await (await request.get(`${API_ORIGIN}/agenttrees/agent2/agents`, { headers: adminAuth }))
          .json()
      )[0].id;
      const blocked = [
        request.post(`${API_ORIGIN}/agenttrees/agent2/agents`, {
          data: { name: "New node" },
          headers: adminAuth,
        }),
        request.post(
          `${API_ORIGIN}/agenttrees/agent2/agents/${agentId}/instructions/versions`,
          { data: { content: "nope" }, headers: adminAuth },
        ),
        request.post(`${API_ORIGIN}/agenttrees/agent2/agents/${agentId}/snapshots`, {
          data: { content: "nope" },
          headers: adminAuth,
        }),
        request.put(`${API_ORIGIN}/agenttrees/agent2/agents/${agentId}/last-selection`, {
          data: { items: [] },
          headers: adminAuth,
        }),
        request.delete(
          `${API_ORIGIN}/agenttrees/agent2/conversations/${history.conversationId}`,
          { headers: adminAuth },
        ),
      ];
      for (const response of await Promise.all(blocked)) {
        expect(response.status(), response.url()).toBe(409);
        const body = await response.json();
        expect(body.code).toBe("tree_disabled");
        // Every error body is traceable, and the header agrees with it —
        // src/api/client.ts reads the header first.
        expect(body.request_id).toBe(response.headers()["x-request-id"]);
      }
    });

    await step("hidden for the non-admin, still listed for the admin", async () => {
      const forRestricted = await request.get(`${API_ORIGIN}/agenttrees`, {
        headers: restrictedAuth,
      });
      expect((await forRestricted.json()).map((t: { id: string }) => t.id)).toEqual(["agent1"]);
      const forAdmin = await request.get(`${API_ORIGIN}/agenttrees`, { headers: adminAuth });
      const agent2 = (await forAdmin.json()).find((t: { id: string }) => t.id === "agent2");
      expect(agent2.enabled).toBe(false);
    });

    await step("re-enable restores everything", async () => {
      await page.getByLabel("agent2 enabled").check({ force: true }); // no confirm to enable
      await expect(page.getByLabel("agent2 enabled")).toBeChecked();
      const forRestricted = await request.get(`${API_ORIGIN}/agenttrees`, {
        headers: restrictedAuth,
      });
      expect((await forRestricted.json()).map((t: { id: string }) => t.id)).toEqual([
        "agent1",
        "agent2",
      ]);
      const chat = await request.post(`${API_ORIGIN}/agenttrees/agent2/chat`, {
        data: { message: "working again", stream: false },
        headers: adminAuth,
        timeout: 60_000,
      });
      expect(chat.ok()).toBeTruthy();
    });
  },
);

test(
  "tree disable: the ACTIVE tree shows the read-only banner in Chat",
  { tag: "@auth-on" },
  async ({ page, request }) => {
    // The app has one active tree from config (agent1) and no tree switcher
    // yet, so the banner is only reachable by disabling that tree.
    const admin = await signInApi(request, "admin@demo");
    const chat = await seedChat(request, "Banner journey: where is my order?", {
      token: admin,
    });

    await page.goto("/");
    await page.waitForURL(/\/login/);
    await signIn(page, "admin@demo");
    await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
    await page.goto(`/chat/${chat.conversationId}`);
    await expect(page.getByTestId("read-only-banner")).toHaveCount(0);

    await setTreeEnabled(request, admin, "agent1", false);
    await page.reload(); // the flag arrives on the boot fetch
    await expect(page.getByTestId("read-only-banner")).toContainText("history is read-only");
    // History is still fully readable behind the banner.
    await expect(page.getByTestId("transcript")).toContainText("Banner journey");

    await setTreeEnabled(request, admin, "agent1", true);
    await page.reload();
    await expect(page.getByTestId("read-only-banner")).toHaveCount(0);
  },
);
