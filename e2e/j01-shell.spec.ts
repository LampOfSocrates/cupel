import { expect, test } from "./helpers/api";
import { seedChat, seedTurnFork, awaitTask } from "./helpers/seed";
import { filmed } from "./helpers/hud";

// E2E checklist journey 1 (feature-spec.md:202):
// "Shell: sidebar collapse, conversation list loads/searches, fork nesting
//  expands"
// Endpoint tags (feature-spec.md:221-222, sketch 07):
//   GET /me · GET /agenttrees · GET /tasks/stream (badge)
//   GET /agenttrees/{tree}/conversations (?search, ?forks_of)

const UNIQUE = "Zephyr courier routing question"; // <48 chars → title verbatim
// Said in a LATER turn, so it is in the transcript and NOT in the title —
// which is the whole difference between searching titles and searching turns.
const BURIED_WORD = "quokka";

// Mantine's CopyButton writes via navigator.clipboard, which headless Chromium
// refuses without the permission — the "Link copied" confirmation is the thing
// under test, so grant it rather than assert around it.
test.use({ permissions: ["clipboard-write"] });

test("shell: boot → sidebar → search → fork nesting expands", async ({
  page,
  request,
  api,
}) => {
  const step = filmed(page, "Journey 1", 6);
  // A conversation of our own with a fork, so the nesting step never depends
  // on which seeded conversation happens to be on page 1.
  const chat = await seedChat(request, UNIQUE);
  await seedChat(request, `A follow-up about ${BURIED_WORD} deliveries`, {
    conversationId: chat.conversationId,
  });
  const fork = await seedTurnFork(request, chat, ["ep_agent1_prod"]);
  await awaitTask(request, fork.results[0].task_id);

  await step("boot: /me, tree list, recent conversations and the task stream", async () => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
    await expect(page.getByText("agent1 · Recent")).toBeVisible();
    await api.expectCalled("GET /me"); // invariant
    await api.expectCalled("GET /agenttrees");
    await api.expectCalled("GET /agenttrees/{tree}/conversations");
    await api.expectCalled("GET /tasks/stream"); // one app-wide SSE
  });

  await step("sidebar collapse: desktop keeps the fixed column", async () => {
    // The collapse control is the phone burger — Mantine renders the navbar as
    // a full-width overlay below the breakpoint. mobile.spec.ts owns that
    // walk; here we assert the desktop side of the same state.
    await expect(page.getByTestId("app-navbar")).toHaveAttribute("data-collapsed", "false");
    await expect(page.getByRole("button", { name: "Toggle navigation" })).toHaveCount(0);
  });

  await step("conversation list searches (?search= reaches the backend)", async () => {
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

  // The parameter's SEMANTICS, not just that it reaches the backend
  // (openapi.yaml listConversations ?search=). Each of these was undefined
  // until item 7 stage F8, and the two implementations in this repo had
  // already drifted apart on the second one.
  await step("search is a literal, untokenised substring of the title OR a turn", async () => {
    const search = page.getByPlaceholder("Search");
    const row = page.getByRole("button", { name: `Actions for ${UNIQUE}` });

    // TURN CONTENT: the title is the FIRST message verbatim, so a word that
    // appears only in a later turn is findable only if turns are searched.
    await search.fill(BURIED_WORD);
    await expect(row).toBeVisible();

    // ONE SUBSTRING, not tokens — the same words, reordered, match nothing.
    await search.fill("routing courier");
    await expect(page.getByText("No matches")).toBeVisible();

    // LITERAL — a SQL LIKE wildcard is a character, not syntax. Before this
    // was defined, "%" returned the entire collection.
    await search.fill("%");
    await expect(page.getByText("No matches")).toBeVisible();

    // TRIMMED, and whitespace-only means "no filter", not "match nothing".
    await search.fill(`  ${UNIQUE}  `);
    await expect(row).toBeVisible();
    await search.fill("   ");
    await expect(row).toBeVisible();
    await search.fill("");
  });

  await step("fork nesting expands (?forks_of= lists them, lineage badge on each)", async () => {
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

  await step("conversation ⋯ menu: rename, copy link, delete", async () => {
    await page.getByRole("button", { name: `Actions for ${UNIQUE}` }).click();
    await expect(page.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
    // Copy-link joins rename/delete; the menu is held open so the
    // confirmation is visible.
    await page.getByRole("menuitem", { name: "Copy link" }).click();
    await expect(page.getByRole("menuitem", { name: "Link copied" })).toBeVisible();
  });
});
