import { expect, test } from "@playwright/test";

// P2-T07 — THE auth e2e, against the real mock with AUTH_MODE=on. Run via
// `npm run e2e:auth` (scripts/e2e-auth.mjs sets AUTH_E2E=1; the playwright
// config then boots the mock webServer with AUTH_MODE=on). Under the plain
// `npm run e2e:smoke` (off-mode, the deployed demo's configuration) this
// spec SKIPS itself, so the smoke run is untouched.
//
// Walk (task spec): boot → redirected to login → login admin@demo → sidebar
// loads → logout → login restricted@demo → agent2 tree absent + agent1
// visible. The frontend never reads the mode — this rig flips it purely on
// the mock's env (skein-phases.md:76 "one env var ... the same UI code
// either way").

const MOCK = "http://localhost:4010";

test.skip(process.env.AUTH_E2E !== "1", "auth-on e2e — run via npm run e2e:auth");

async function signIn(page: import("@playwright/test").Page, email: string) {
  // Role-based: Mantine's `required` suffixes labels with "*", and the
  // PasswordInput's visibility toggle also answers getByLabel("Password").
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill("demo");
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("auth-on: login redirect → admin session → logout → restricted permission filtering", async ({
  page,
  request,
}) => {
  // --- Boot without a token: /me 401s → the app lands on the login screen ---
  await page.goto("/");
  await page.waitForURL(/\/login/);
  await expect(page.getByText("Sign in to continue")).toBeVisible();

  // --- Login admin@demo (seeded, mock/auth.py) → app boots, sidebar loads ---
  await signIn(page, "admin@demo");
  await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
  await expect(page.getByText("agent1 · Recent")).toBeVisible();
  // Session row: /me user + Sign out (a token exists for the active target).
  await expect(page.getByText("Admin", { exact: true })).toBeVisible();

  // The stored JWT (skein.auth.token.<targetId>; active target = mock) sees
  // BOTH trees — admin has view on agent1 + agent2.
  const adminToken = await page.evaluate(() =>
    localStorage.getItem("skein.auth.token.mock"),
  );
  expect(adminToken).toBeTruthy();
  const adminTrees = await request.get(`${MOCK}/agenttrees`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect((await adminTrees.json()).map((t: { id: string }) => t.id)).toEqual([
    "agent1",
    "agent2",
  ]);

  // --- Logout: token discarded, back to the login screen ---
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/);
  await expect(page.getByText("Sign in to continue")).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("skein.auth.token.mock")),
  ).toBeNull();

  // --- Login restricted@demo: agent1 visible, agent2 absent ---
  await signIn(page, "restricted@demo");
  await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
  // The app's tree (permission-filtered GET /agenttrees) is agent1.
  await expect(page.getByText("agent1 · Recent")).toBeVisible();
  await expect(page.getByText("Restricted", { exact: true })).toBeVisible();

  const restrictedToken = await page.evaluate(() =>
    localStorage.getItem("skein.auth.token.mock"),
  );
  const restrictedTrees = await request.get(`${MOCK}/agenttrees`, {
    headers: { Authorization: `Bearer ${restrictedToken}` },
  });
  // agent2 filtered out of the listing ("unpermitted trees never render",
  // feature-spec.md:32) …
  expect((await restrictedTrees.json()).map((t: { id: string }) => t.id)).toEqual([
    "agent1",
  ]);
  // … and 404s when addressed directly (openapi.yaml:1948 NotFound —
  // indistinguishable from absent).
  const agent2 = await request.get(`${MOCK}/agenttrees/agent2/agents`, {
    headers: { Authorization: `Bearer ${restrictedToken}` },
  });
  expect(agent2.status()).toBe(404);
  const agent1 = await request.get(`${MOCK}/agenttrees/agent1/agents`, {
    headers: { Authorization: `Bearer ${restrictedToken}` },
  });
  expect(agent1.status()).toBe(200);
});
