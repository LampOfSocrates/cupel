import { API_ORIGIN, expect, test } from "./helpers/api";
import { signIn, storedToken } from "./helpers/auth";
import { filmed } from "./helpers/hud";

// E2E checklist journey 12 (feature-spec.md:213):
// "Auth: suite runs twice — AUTH_MODE=off (dev user), and AUTH_MODE=on (login
//  with seeded creds, 401 redirect, admin permission matrix edit takes effect)"
// Endpoint tags (feature-spec.md:220): POST /auth/token · GET /me
//
// The off-mode half of that line is the rest of the suite: journeys 1-9 and 13
// run with no token at all. This file is the on-mode half — login, the session
// row, admin-only surfaces, logout, and the 401 redirect. The permission-matrix
// edit lives in j10-permissions.spec.ts; the tree toggles in j11.
//
// The frontend never reads AUTH_MODE: this rig flips it purely on the mock's
// env ("one env var … the same UI code either way").

test.skip(process.env.AUTH_E2E !== "1", "auth-on journey — run via npm run e2e:auth");

test(
  "auth-on: 401 at boot → login → admin session → a chat under the token → logout",
  { tag: "@auth-on" },
  async ({ page, request, api }) => {
    const step = filmed(page, "Journey 12", 6);
    await step("no token: /me 401s and the app lands on login", async () => {
      await page.goto("/");
      await page.waitForURL(/\/login/);
      await expect(page.getByText("Sign in to continue")).toBeVisible();
      await api.expectCalled("GET /me");
    });

    await step("sign in with the seeded admin", async () => {
      api.clear();
      await signIn(page, "admin@demo");
      await api.expectCalled("POST /auth/token");
      await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
      await expect(page.getByText("agent1 · Recent")).toBeVisible();
      // Session row: the /me user, and a Sign out because a token exists.
      await expect(page.getByText("Admin", { exact: true })).toBeVisible();
      expect(await storedToken(page)).toBeTruthy();
    });

    await step("the admin sees both trees", async () => {
      const token = await storedToken(page);
      const trees = await request.get(`${API_ORIGIN}/agenttrees`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect((await trees.json()).map((t: { id: string }) => t.id)).toEqual([
        "agent1",
        "agent2",
      ]);
    });

    await step("admin-only surfaces render, role-driven not mode-driven", async () => {
      await page.goto("/settings");
      await expect(page.getByText("Members", { exact: true })).toBeVisible();
      await expect(page.getByText("Agent trees", { exact: true })).toBeVisible();
      // Studio (cases/sets/rubrics + results) is open to everyone; only its
      // Inspector tab is `inspect`-role-gated (UX polish 2026-08-10, Studio
      // merge — Eval workbench + Inspector are tabs there now).
      await page.getByRole("link", { name: "Studio", exact: true }).click();
      await page.waitForURL(/\/studio$/);
      await page.getByRole("tab", { name: "Inspector" }).click();
      await expect(page.getByRole("columnheader", { name: "User" })).toBeVisible();
    });

    await step("a core journey still works with the token attached", async () => {
      api.clear();
      await page.getByRole("button", { name: "+ New chat" }).click();
      await page.getByPlaceholder("Message…").fill("Auth journey: still streaming?");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByTestId("streaming-turn")).toBeVisible();
      await page.waitForURL(/\/chat\/conv_/);
      await expect(page.getByTestId("streaming-turn")).toHaveCount(0, { timeout: 30_000 });
      await api.expectCalled("POST /agenttrees/{tree}/chat");
    });

    await step("sign out discards the token and returns to login", async () => {
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.waitForURL(/\/login/);
      await expect(page.getByText("Sign in to continue")).toBeVisible();
      expect(await storedToken(page)).toBeNull();
    });
  },
);

// A turn deep link received by a logged-out user. The frontend has
// no idea which auth mode the backend runs: the boot /me simply 401s here, the
// central handler routes to /login?return_to=<path incl. query>, and login
// navigates back to exactly that URL. In off-mode (j02-chat.spec.ts, and the
// deployed demo) nothing 401s and the same link opens straight to the turn.
test(
  "auth-on: a turn deep link survives the login redirect and lands on the turn",
  { tag: "@auth-on" },
  async ({ page, request }) => {
    await page.goto("/");
    await page.waitForURL(/\/login/);
    await signIn(page, "admin@demo");
    await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
    const adminToken = await storedToken(page);
    const chat = await request.post(`${API_ORIGIN}/agenttrees/agent1/chat`, {
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
  },
);
