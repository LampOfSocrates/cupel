import type { Page } from "@playwright/test";

// Shared by the AUTH_MODE=on journeys (10-12).

/** Sign in on the login screen with a seeded user (mock/auth.py SEED_USERS).
 * Role-based selectors: Mantine's `required` suffixes labels with "*", and the
 * PasswordInput's visibility toggle also answers getByLabel("Password"). */
export async function signIn(page: Page, email: string, password = "demo"): Promise<void> {
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("textbox", { name: "Password" }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The JWT the app stored for the active target (cupel.auth.token.<targetId>). */
export function storedToken(page: Page, targetId = "mock"): Promise<string | null> {
  return page.evaluate((id) => localStorage.getItem(`cupel.auth.token.${id}`), targetId);
}
