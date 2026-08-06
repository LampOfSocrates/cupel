import { expect, test } from "./helpers/api";
import { seedChat, seedTurnFork, awaitTask } from "./helpers/seed";

// E2E checklist journey 1 (feature-spec.md:206):
// "Shell: sidebar collapse, presets route to Runs, conversation list
//  loads/searches, fork nesting expands"
// Endpoint tags (feature-spec.md:225-226, sketch 07):
//   GET /me · GET /agenttrees · GET /tasks/stream (badge)
//   GET /agenttrees/{tree}/conversations (?search, ?forks_of)

const UNIQUE = "Zephyr courier routing question"; // <48 chars → title verbatim

// Mantine's CopyButton writes via navigator.clipboard, which headless Chromium
// refuses without the permission — the "Link copied" confirmation is the thing
// under test, so grant it rather than assert around it.
test.use({ permissions: ["clipboard-write"] });

test("shell: boot → nav + presets route to Runs → search → fork nesting expands", async ({
  page,
  request,
  api,
}) => {
  // A conversation of our own with a fork, so the nesting step never depends
  // on which seeded conversation happens to be on page 1.
  const chat = await seedChat(request, UNIQUE);
  const fork = await seedTurnFork(request, chat, ["ep_agent1_prod"]);
  await awaitTask(request, fork.results[0].task_id);

  await test.step("boot: /me, tree list, recent conversations and the task stream", async () => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
    await expect(page.getByText("agent1 · Recent")).toBeVisible();
    await api.expectCalled("GET /me"); // skein-phases.md:160 invariant
    await api.expectCalled("GET /agenttrees");
    await api.expectCalled("GET /agenttrees/{tree}/conversations");
    await api.expectCalled("GET /tasks/stream"); // one app-wide SSE (P1-T08)
  });

  await test.step("sidebar collapse: desktop keeps the fixed column", async () => {
    // The collapse control is the phone burger — Mantine renders the navbar as
    // a full-width overlay below the breakpoint. mobile.spec.ts owns that walk
    // (P2-MOBILE-SHELL); here we assert the desktop side of the same state.
    await expect(page.getByTestId("app-navbar")).toHaveAttribute("data-collapsed", "false");
    await expect(page.getByRole("button", { name: "Toggle navigation" })).toHaveCount(0);
  });

  await test.step("presets route to Runs (Tune → version axis, Evaluate → judge open)", async () => {
    await page.getByRole("link", { name: "Tune", exact: true }).click();
    await expect(page).toHaveURL(/\/runs$/);
    // A preset lands straight in the stepper, not the run list (P1-T15).
    await expect(page.getByRole("button", { name: "Configure ▸" })).toBeVisible();

    await page.getByRole("link", { name: "Evaluate", exact: true }).click();
    await expect(page).toHaveURL(/\/runs$/);
    await page.getByRole("checkbox", { name: `Select ${UNIQUE}` }).check();
    await page.getByRole("button", { name: "Configure ▸" }).click();
    // Evaluate arrives with the judge section already expanded.
    const config = page.getByTestId("config-0");
    await expect(config.getByLabel("Rubric")).toBeVisible();
    await expect(config.getByLabel("Judge model")).toBeVisible();
    await api.expectCalled("GET /eval/rubrics");
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  await test.step("conversation list searches (?search= reaches the backend)", async () => {
    api.clear();
    const search = page.getByPlaceholder("Search");
    await search.fill("Zephyr");
    // Debounced (250ms) — waiting on the RESULT, never on a timer.
    await expect(page.getByRole("button", { name: `Actions for ${UNIQUE}` })).toBeVisible();
    await expect
      .poll(() => api.last("GET /agenttrees/{tree}/conversations")?.query ?? "")
      .toContain("search=Zephyr");

    await search.fill("no-such-conversation-anywhere");
    await expect(page.getByText("No matches")).toBeVisible();
    await search.fill("");
  });

  await test.step("fork nesting expands (?forks_of= lists them, lineage badge on each)", async () => {
    api.clear();
    const expander = page.getByTestId(`forks-${chat.conversationId}`);
    await expect(expander).toHaveText(/1 forks/);
    await expander.click();
    await api.expectCalled("GET /agenttrees/{tree}/conversations");
    expect(api.last("GET /agenttrees/{tree}/conversations")?.query).toContain(
      `forks_of=${chat.conversationId}`,
    );
    // The fork row carries its lineage badge ("prod"), sketch 07.
    await expect(page.getByTestId("app-navbar").getByText("prod").first()).toBeVisible();
  });

  await test.step("conversation ⋯ menu: rename, copy link, delete", async () => {
    await page.getByRole("button", { name: `Actions for ${UNIQUE}` }).click();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    // P2-SHARE: copy-link joins rename/delete; the menu is held open so the
    // confirmation is visible.
    await page.getByRole("menuitem", { name: "Copy link" }).click();
    await expect(page.getByRole("menuitem", { name: "Link copied" })).toBeVisible();
  });
});
