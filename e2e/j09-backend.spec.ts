import { expect, test } from "./helpers/api";
import { filmed } from "./helpers/hud";

// E2E checklist journey 9 (feature-spec.md:210):
// "Backend switcher: swap target, healthz reflects, non-prod banner shows"
// Endpoint tags (feature-spec.md:243, sketch 09): GET {base}/healthz
//
// Targets come from agentic.config.ts — THE one config artifact — and the
// choice is device-local (feature-spec.md:157), which is why the last step
// reloads to prove it stuck.

test("backend switcher: mock → custom URL → a dead target and back, with healthz + banners", async ({
  page,
  api,
  request,
}) => {
  const step = filmed(page, "Journey 9", 6);

  await step("the mock target is active and announces itself in the chrome", async () => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByText("Backend", { exact: true })).toBeVisible();
    // Non-prod chrome banner (feature-spec.md:157), configured per target.
    await expect(page.getByTestId("env-banner")).toContainText("MOCK BACKEND");
    await expect(page.getByRole("radio", { name: "Mock" })).toBeChecked();
    await expect(page.getByLabel("Base URL")).toHaveValue("http://localhost:4010");
  });

  await step("healthz reflects the live backend, and Re-check re-probes", async () => {
    await expect(page.getByTestId("health-result")).toContainText("ok");
    await api.expectCalled("GET /healthz");
    api.clear();
    await page.getByRole("button", { name: "Re-check" }).click();
    await api.expectCalled("GET /healthz");
    await expect(page.getByTestId("health-result")).toContainText("ok");
  });

  await step("a custom base URL is a target of its own", async () => {
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

  await step("swapping to a dead target strands the app — with a way back", async () => {
    // click, not check: the boot against the dead target replaces the whole
    // app (including this radio) before check() could verify it.
    await page.getByRole("radio", { name: "Local" }).click();
    // The recovery path: boot fails against the new target, the error
    // names it, and the build's default target is one click away.
    const alert = page.getByText("Backend unreachable");
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("is the Local backend at http://localhost:8000 running?")).toBeVisible();
    await page.getByRole("button", { name: "Switch back to Mock" }).click();
    await expect(page.getByTestId("env-banner")).toContainText("MOCK BACKEND");
    await expect(page.getByRole("button", { name: "+ New chat" })).toBeVisible();
  });

  await step("the choice is device-local and survives a reload", async () => {
    await page.goto("/settings");
    await page.reload();
    await expect(page.getByRole("radio", { name: "Mock" })).toBeChecked();
    await expect(page.getByTestId("env-banner")).toContainText("MOCK BACKEND");
    await expect(page.getByText("Target is device-local")).toBeVisible();
  });

  // Not the switcher, but the same question a user asks it: "is this backend
  // answering, and what do I quote when it is not?" (openapi.yaml Error).
  await step("every answer is traceable, and an error says which field it rejected", async () => {
    const ok = await request.get("http://localhost:4010/agenttrees");
    expect(ok.status()).toBe(200);
    // On a SUCCESS too — a client logs the id beside a request that has not
    // failed yet, which is the only way to have it when the complaint is
    // "the answer was wrong" rather than "the answer was an error".
    expect(ok.headers()["x-request-id"]).toMatch(/^req_/);

    // A gateway's id survives instead of being replaced by an unrelated one.
    const traced = await request.get("http://localhost:4010/agenttrees", {
      headers: { "X-Request-Id": "gw-e2e-0451" },
    });
    expect(traced.headers()["x-request-id"]).toBe("gw-e2e-0451");

    const missing = await request.get("http://localhost:4010/agenttrees/nope/agents");
    expect(missing.status()).toBe(404);
    const notFound = await missing.json();
    expect(notFound.request_id).toBe(missing.headers()["x-request-id"]);
    expect(notFound.details).toBeUndefined(); // nothing to point at

    const invalid = await request.post("http://localhost:4010/agenttrees/agent1/chat", {
      data: { stream: false },
    });
    expect(invalid.status()).toBe(422);
    const rejected = await invalid.json();
    expect(rejected.code).toBe("invalid");
    expect(rejected.details[0].field).toBe("message");
    expect(rejected.request_id).toBe(invalid.headers()["x-request-id"]);
  });
});
