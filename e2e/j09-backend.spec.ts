import { expect, test } from "./helpers/api";

// E2E checklist journey 9 (feature-spec.md:214):
// "Backend switcher: swap target, healthz reflects, non-prod banner shows"
// Endpoint tags (feature-spec.md:247, sketch 09): GET {base}/healthz
//
// Targets come from agentic.config.ts — THE one config artifact — and the
// choice is device-local (feature-spec.md:161), which is why the last step
// reloads to prove it stuck.

test("backend switcher: mock → custom URL → a dead target and back, with healthz + banners", async ({
  page,
  api,
}) => {
  await test.step("the mock target is active and announces itself in the chrome", async () => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Backend", { exact: true })).toBeVisible();
    // Non-prod chrome banner (feature-spec.md:161), configured per target.
    await expect(page.getByTestId("env-banner")).toContainText("MOCK BACKEND");
    await expect(page.getByRole("radio", { name: "Mock" })).toBeChecked();
    await expect(page.getByLabel("Base URL")).toHaveValue("http://localhost:4010");
  });

  await test.step("healthz reflects the live backend, and Re-check re-probes", async () => {
    await expect(page.getByTestId("health-result")).toContainText("ok");
    await api.expectCalled("GET /healthz");
    api.clear();
    await page.getByRole("button", { name: "Re-check" }).click();
    await api.expectCalled("GET /healthz");
    await expect(page.getByTestId("health-result")).toContainText("ok");
  });

  await test.step("a custom base URL is a target of its own", async () => {
    await page.getByRole("radio", { name: "Custom" }).check();
    // Selected but not yet usable — nothing to connect to.
    await expect(page.getByTestId("health-result")).toContainText("enter a base URL");
    await page.getByLabel("Base URL").fill("http://localhost:4010");
    await page.getByLabel("Base URL").blur();
    // Configured banner text ("MOCK BACKEND") vs the id-based fallback for a
    // target that declares none ("<label> backend").
    await expect(page.getByTestId("env-banner")).toContainText("Custom backend");
    await expect(page.getByTestId("health-result")).toContainText("ok", { timeout: 30_000 });
  });

  await test.step("swapping to a dead target strands the app — with a way back", async () => {
    // click, not check: the boot against the dead target replaces the whole
    // app (including this radio) before check() could verify it.
    await page.getByRole("radio", { name: "Local" }).click();
    // P2-T17's recovery path: boot fails against the new target, the error
    // names it, and the build's default target is one click away.
    const alert = page.getByText("Backend unreachable");
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("is the Local backend at http://localhost:8000 running?")).toBeVisible();
    await page.getByRole("button", { name: "Switch back to Mock" }).click();
    await expect(page.getByTestId("env-banner")).toContainText("MOCK BACKEND");
    await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
  });

  await test.step("the choice is device-local and survives a reload", async () => {
    await page.goto("/settings");
    await page.reload();
    await expect(page.getByRole("radio", { name: "Mock" })).toBeChecked();
    await expect(page.getByTestId("env-banner")).toContainText("MOCK BACKEND");
    await expect(page.getByText("Target is device-local")).toBeVisible();
  });
});
