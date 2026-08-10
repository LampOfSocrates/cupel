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
  it("takes the family's doors out of the sidebar", async () => {
    await boot({ eval: "hide", evaluations: "hide" });
    await screen.findByRole("link", { name: "Chat" });
    // The whole Evaluate group goes when both of its children hid.
    expect(screen.queryByText("Evaluate")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Evaluations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Eval" })).not.toBeInTheDocument();
    // Everything unanswered is still `mine`, so it stays.
    // The queue entry carries the pending badge, so it is matched by prefix.
    expect(screen.getByRole("link", { name: /^Queue/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agents" })).toBeInTheDocument();
  });

  it("keeps a group whose other child is still visible", async () => {
    await boot({ eval: "hide" });
    expect(await screen.findByRole("link", { name: "Evaluations" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Eval" })).not.toBeInTheDocument();
  });

  // A hidden family's screen must not render — its requests would go nowhere.
  it("takes the route with it: a hand-typed path lands on the front door", async () => {
    await boot({ eval: "hide" }, "/eval");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/chat"));
  });

  it("moves the front door when chat itself is hidden", async () => {
    await boot({ chat: "hide" }, "/");
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/evaluations"));
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
