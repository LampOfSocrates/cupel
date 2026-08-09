import { API_ORIGIN, expect, test } from "./helpers/api";
import { signInApi } from "./helpers/seed";
import { signIn } from "./helpers/auth";
import { filmed } from "./helpers/hud";

// E2E checklist journey 10 (feature-spec.md:211):
// "Permissions: second seeded tree hidden for restricted test user"
// plus the half of journey 12 that is really about permissions:
// "admin permission matrix edit takes effect" (feature-spec.md:213).
// Endpoint tags (feature-spec.md:244):
//   GET/PUT /admin/users · GET/PUT /admin/users/{id}/permissions
//
// AUTH_MODE=on only — the matrix is meaningless without real users. Run via
// `npm run e2e:auth` (or `npm run e2e`, which runs both modes).

test.skip(process.env.AUTH_E2E !== "1", "auth-on journey — run via npm run e2e:auth");

test(
  "permissions: agent2 is invisible to the restricted user, and a matrix edit takes effect",
  { tag: "@auth-on" },
  async ({ page, request, api }) => {
    const step = filmed(page, "Journey 10", 5);
    await step("restricted@demo sees agent1 only — agent2 never renders", async () => {
      await page.goto("/");
      await page.waitForURL(/\/login/);
      await signIn(page, "restricted@demo");
      await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
      await expect(page.getByText("agent1 · Recent")).toBeVisible();
      await api.expectCalled("GET /agenttrees");

      const token = await signInApi(request, "restricted@demo");
      const trees = await request.get(`${API_ORIGIN}/agenttrees`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect((await trees.json()).map((t: { id: string }) => t.id)).toEqual(["agent1"]);
      // Addressed directly it 404s — indistinguishable from absent
      // (openapi.yaml:1948 "Resource not found (or tree not permitted)").
      const denied = await request.get(`${API_ORIGIN}/agenttrees/agent2/agents`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(denied.status()).toBe(404);
    });

    await step("no admin role → no Members section, and the API refuses too", async () => {
      await page.goto("/settings");
      await expect(page.getByText("Backend", { exact: true })).toBeVisible();
      await expect(page.getByText("Members", { exact: true })).toHaveCount(0);
      const token = await signInApi(request, "restricted@demo");
      const forbidden = await request.get(`${API_ORIGIN}/admin/users`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(forbidden.status()).toBe(403);
      expect((await forbidden.json()).code).toBe("forbidden");
    });

    await step("as admin, the Members matrix shows the seeded rights", async () => {
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.waitForURL(/\/login/);
      await signIn(page, "admin@demo");
      // Wait for the booted admin session before navigating, or the goto races
      // the post-login boot and lands with no /me yet.
      await expect(page.getByText("Admin", { exact: true })).toBeVisible();
      api.clear();
      await page.goto("/settings");
      await expect(page.getByText("Members", { exact: true })).toBeVisible();
      await api.expectCalled("GET /admin/users");
      await expect(page.getByLabel("restricted@demo agent1 view")).toBeChecked();
      await expect(page.getByLabel("restricted@demo agent1 tune")).not.toBeChecked();
    });

    await step("granting `tune` takes effect on the user's next request", async () => {
      api.clear();
      await page.getByLabel("restricted@demo agent1 tune").check();
      await api.expectCalled("PUT /admin/users/{user}/permissions");
      await expect(page.getByLabel("restricted@demo agent1 tune")).toBeChecked();

      const token = await signInApi(request, "restricted@demo");
      const me = await request.get(`${API_ORIGIN}/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect((await me.json()).permissions.agent1).toContain("tune");
    });

    await step("revoking it takes effect the same way (state restored)", async () => {
      await page.getByLabel("restricted@demo agent1 tune").uncheck();
      await api.expectCalled("PUT /admin/users/{user}/permissions", 2);
      await expect(page.getByLabel("restricted@demo agent1 tune")).not.toBeChecked();

      const token = await signInApi(request, "restricted@demo");
      const me = await request.get(`${API_ORIGIN}/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect((await me.json()).permissions.agent1).not.toContain("tune");
    });
  },
);
