import { expect, test } from "@playwright/test";

// P2-MOBILE-SHELL — the user-reported bug, walked at phone size: "in portrait
// mode new chat doesn't open the chat" / "I only see the sidebar, it doesn't
// collapse when I do a new chat". Below the navbar breakpoint Mantine renders
// the sidebar as a full-width overlay, so the route change was invisible.
// Off-mode (no AUTH_MODE) so it runs in the plain `npm run e2e:smoke` suite.
test.use({ viewport: { width: 390, height: 844 } });

test("portrait: burger opens the sidebar, New chat closes it and shows the chat", async ({
  page,
}) => {
  await page.goto("/");

  const navbar = page.getByTestId("app-navbar");
  const composer = page.getByPlaceholder("Message…");
  const newChat = page.getByRole("button", { name: "+ New chat" });

  // Boot lands on the CHAT, not on the sidebar (the reported symptom).
  await expect(composer).toBeVisible();
  await expect(navbar).toHaveAttribute("data-collapsed", "true");
  // The non-prod banner survives the mobile header (P2-T17).
  await expect(page.getByTestId("env-banner")).toBeVisible();

  // Burger opens the overlay; the sidebar is now what covers the screen.
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await expect(navbar).toHaveAttribute("data-collapsed", "false");
  await expect(newChat).toBeVisible();

  // THE BUG: tapping New chat used to change the route behind the overlay.
  await newChat.click();
  await expect(navbar).toHaveAttribute("data-collapsed", "true");
  await expect(page).toHaveURL(/\/chat$/);

  // The composer is reachable, not covered and not clipped: click() fails if
  // the overlay still intercepts pointer events, fill() if it is off-screen.
  await composer.click();
  await composer.fill("portrait works");
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
});
