import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { MantineProvider } from "@mantine/core";

// What the generator's `hide` and `mock` answers do to the running app
// (agentic.config.ts families): a hidden family loses its door AND its route,
// and a mocked one says so on every screen it answers.
//
// The modules read the config when they load and the setup file has already
// loaded them, so each case boots a FRESH module graph over a stubbed config —
// same reason as src/api/familyRouting.test.ts.
async function boot(families: Record<string, string>, entry = "/chat") {
  vi.resetModules();
  vi.doMock("../../agentic.config", async () => {
    const mod = await vi.importActual<typeof import("../../agentic.config")>(
      "../../agentic.config",
    );
    return {
      ...mod,
      agenticConfig: { ...mod.agenticConfig, families, mockTarget: "mock" },
    };
  });
  const { App } = await import("../App");
  render(
    <MantineProvider env="test">
      <MemoryRouter initialEntries={[entry]}>
        <App />
        <LocationProbe />
      </MemoryRouter>
    </MantineProvider>,
  );
  // Booted = the shell is up (sidebar rendered).
  await screen.findByTestId("app-navbar");
}

afterEach(() => {
  vi.doUnmock("../../agentic.config");
});

describe("hide", () => {
  it("takes the Studio door out of the sidebar when BOTH families it merges hide", async () => {
    await boot({ eval: "hide", evaluations: "hide" });
    await screen.findByRole("link", { name: "Chat" });
    expect(screen.queryByRole("link", { name: "Studio" })).not.toBeInTheDocument();
    // Everything unanswered is still `mine`, so it stays.
    // The queue entry carries the pending badge, so it is matched by prefix.
    expect(screen.getByRole("link", { name: /^Queue/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agents" })).toBeInTheDocument();
  });

  it("keeps the Studio door open when only one of its two families hides — but drops that half's tabs", async () => {
    await boot({ eval: "hide" }, "/studio");
    expect(await screen.findByRole("link", { name: "Studio" })).toBeInTheDocument();
    // Cases/Sets/Rubrics share the "eval" family and are gone...
    expect(screen.queryByRole("tab", { name: "Cases" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Sets" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Rubrics" })).not.toBeInTheDocument();
    // ...Results ("evaluations") stays, and is what the page lands on since
    // Cases is no longer the default tab.
    expect(await screen.findByRole("tab", { name: "Results" })).toBeInTheDocument();
  });

  // A hidden family's screen must not render — its requests would go nowhere.
  // /eval is a redirect into /studio now (App.tsx), so hitting it lands
  // wherever /studio's OWN visibility says: still there if evaluations
  // survives (Studio has something to show), the front door only once
  // BOTH families — and so the route itself — are gone.
  it("a hand-typed /eval lands on Studio if evaluations still answers", async () => {
    await boot({ eval: "hide" }, "/eval");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/studio"));
  });

  it("a hand-typed /eval lands on the front door once BOTH families hide", async () => {
    await boot({ eval: "hide", evaluations: "hide" }, "/eval");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/chat"));
  });

  it("moves the front door when chat itself is hidden", async () => {
    await boot({ chat: "hide" }, "/");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/studio"));
    expect(screen.queryByRole("button", { name: "+ New chat" })).not.toBeInTheDocument();
    // No chat means no recent-conversation list under it either.
    expect(screen.queryByText(/· Recent/)).not.toBeInTheDocument();
  });
});

describe("the served-by-mock badge", () => {
  it("names the family on a screen the bundled mock answers", async () => {
    await boot({ tasks: "mock" }, "/queue");
    const badge = await screen.findByTestId("mock-badge");
    expect(badge).toHaveTextContent("tasks · served by mock");
  });

  it("stays off the screens the adopter's own backend answers", async () => {
    await boot({ tasks: "mock" }, "/chat");
    await screen.findByRole("link", { name: "Chat" });
    expect(screen.queryByTestId("mock-badge")).not.toBeInTheDocument();
  });

  it("never renders when no family is mocked", async () => {
    await boot({}, "/queue");
    await screen.findByRole("link", { name: /^Queue/ });
    expect(screen.queryByTestId("mock-badge")).not.toBeInTheDocument();
  });
});

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}
