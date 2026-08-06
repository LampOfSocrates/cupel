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

  // --- P2-T07b/07c: the admin holds the admin role, so Settings carries the
  // Members matrix and the Agent trees toggles ("Admin UI (visible when /me
  // grants admin)", feature-spec.md:19) ---
  await page.goto("/settings");
  await expect(page.getByText("Members", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent trees", { exact: true })).toBeVisible();
  // The matrix is live against the real mock: restricted@demo's seeded row is
  // agent1 view+evaluate, no tune (mock/auth.py SEED_USERS).
  await expect(page.getByLabel("restricted@demo agent1 view")).toBeChecked();
  await expect(page.getByLabel("restricted@demo agent1 tune")).not.toBeChecked();
  // Tree toggles list every tree the admin can see, enabled by default.
  await expect(page.getByLabel("agent1 enabled")).toBeChecked();
  await expect(page.getByLabel("agent2 enabled")).toBeChecked();

  // --- P2-T12a: the admin also holds the INSPECT role, so the Inspector nav
  // entry renders and the cross-user table loads ("Requires the inspect role",
  // openapi.yaml:308). Casebooks is open to everyone. ---
  await expect(page.getByRole("link", { name: "Inspector" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Casebooks" })).toBeVisible();
  await page.getByRole("link", { name: "Inspector" }).click();
  await page.waitForURL(/\/inspector/);
  await expect(page.getByRole("columnheader", { name: "User" })).toBeVisible();

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

  // --- restricted@demo has no admin role: same Settings page, no admin
  // sections (role-driven, not mode-driven) — and the server refuses anyway ---
  await page.goto("/settings");
  await expect(page.getByText("Backend", { exact: true })).toBeVisible();
  await expect(page.getByText("Members", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Agent trees", { exact: true })).toHaveCount(0);
  const forbidden = await request.get(`${MOCK}/admin/users`, {
    headers: { Authorization: `Bearer ${restrictedToken}` },
  });
  expect(forbidden.status()).toBe(403);
  expect((await forbidden.json()).code).toBe("forbidden");

  // --- P2-T12a: restricted@demo has no `inspect` role either, so the
  // Inspector nav entry is absent (role-driven, never mode-driven) while
  // Casebooks stays available — and the endpoint 403s regardless ---
  await expect(page.getByRole("link", { name: "Casebooks" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Inspector" })).toHaveCount(0);
  const noInspect = await request.get(`${MOCK}/admin/conversations`, {
    headers: { Authorization: `Bearer ${restrictedToken}` },
  });
  expect(noInspect.status()).toBe(403);
  expect((await noInspect.json()).code).toBe("forbidden");
});

// P2-SHARE — a turn deep link received by a logged-out user. The frontend has
// no idea which auth mode the backend runs: the boot /me simply 401s here, the
// central handler routes to /login?return_to=<path incl. query>, and login
// navigates back to exactly that URL. In off-mode (the smoke run, and the
// deployed demo) nothing 401s and the same link opens straight to the turn.
test("auth-on: a turn deep link survives the login redirect and lands on the turn", async ({
  page,
  request,
}) => {
  // Create the shareable conversation through the API as admin (seeded users,
  // mock/auth.py) — the link is what a sender would have copied.
  await page.goto("/");
  await page.waitForURL(/\/login/);
  await signIn(page, "admin@demo");
  await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
  const adminToken = await page.evaluate(() =>
    localStorage.getItem("skein.auth.token.mock"),
  );
  const chat = await request.post(`${MOCK}/agenttrees/agent1/chat`, {
    data: { message: "Shared turn deep link", stream: false },
    headers: { Authorization: `Bearer ${adminToken}` },
    timeout: 60_000,
  });
  expect(chat.ok()).toBeTruthy();
  const { conversation_id: conversationId, turn } = await chat.json();
  const deepLink = `/chat/${conversationId}?turn=${turn.id}`;

  // --- Receiver is logged out: the deep link bounces through login ---
  await page.evaluate(() => localStorage.clear());
  await page.goto(deepLink);
  await page.waitForURL(/\/login/);
  // the whole path INCLUDING ?turn= is carried as one encoded return_to
  expect(new URL(page.url()).searchParams.get("return_to")).toBe(deepLink);
  await expect(page.getByText("Sign in to continue")).toBeVisible();

  // --- After signing in they land on that conversation, on that turn ---
  await signIn(page, "admin@demo");
  await page.waitForURL((url) => url.pathname + url.search === deepLink);
  const target = page.getByTestId("transcript").locator('[data-share-target="true"]');
  await expect(target).toHaveCount(1);
  // It is the ASSISTANT bubble that was linked: only those carry the action
  // row (and therefore the 🔗 that produced this link in the first place).
  await expect(target.getByRole("button", { name: "Copy link to turn" })).toBeVisible();
});
