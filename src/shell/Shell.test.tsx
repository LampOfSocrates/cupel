import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { renderApp } from "../test/render";
import { ChatPage } from "../pages/ChatPage";
import { Shell } from "./Shell";

// P2-MOBILE-SHELL — the reported bug: on a phone in portrait the sidebar is a
// FULL-WIDTH overlay (Mantine sets --app-shell-navbar-width:100% below the
// breakpoint), so "New chat" navigated correctly but the user only ever saw
// the sidebar. Shell now collapses that overlay on every navigation.
//
// jsdom evaluates no media queries, so the width is driven through the one
// mechanism the implementation reads — window.matchMedia (useMediaQuery) —
// following the stub already in src/test/setup.ts, which answers `false` to
// everything (i.e. desktop) for every other test file.
const realMatchMedia = window.matchMedia;
function setViewportWidth(px: number) {
  window.matchMedia = ((query: string) => {
    const max = /max-width:\s*([\d.]+)em/.exec(query);
    return {
      matches: max ? px <= Number.parseFloat(max[1]) * 16 : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    };
  }) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

const renderShell = (route = "/chat") =>
  renderApp(
    <Routes>
      <Route element={<Shell />}>
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:conversationId" element={<ChatPage />} />
      </Route>
    </Routes>,
    { route, queue: true },
  );

const navbar = () => screen.getByTestId("app-navbar");

describe("Shell — phone portrait", () => {
  it("boots with the overlay closed and toggles it from the burger", async () => {
    setViewportWidth(390);
    const user = userEvent.setup();
    renderShell();

    // The chat, not the sidebar, is what a phone user lands on.
    expect(navbar()).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByPlaceholderText("Message…")).toBeInTheDocument();

    const burger = screen.getByRole("button", { name: "Toggle navigation" });
    expect(burger).toHaveAttribute("aria-expanded", "false");
    await user.click(burger);
    expect(navbar()).toHaveAttribute("data-collapsed", "false");
    expect(burger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes the overlay when New chat is tapped — the reported bug", async () => {
    setViewportWidth(390);
    const user = userEvent.setup();
    // From /chat, "+ New chat" keeps the PATHNAME — the close effect keys on
    // the location key, so this still closes.
    renderShell();

    await user.click(screen.getByRole("button", { name: "Toggle navigation" }));
    expect(navbar()).toHaveAttribute("data-collapsed", "false");

    await user.click(screen.getByRole("button", { name: "+ New chat" }));
    await waitFor(() => expect(navbar()).toHaveAttribute("data-collapsed", "true"));
    // …and the destination is what the user now sees.
    expect(screen.getByPlaceholderText("Message…")).toBeVisible();
    expect(screen.getByRole("heading", { name: "New chat" })).toBeVisible();
  });

  it("closes the overlay when a conversation is tapped", async () => {
    setViewportWidth(390);
    const user = userEvent.setup();
    renderShell();

    await user.click(screen.getByRole("button", { name: "Toggle navigation" }));
    await screen.findByText("Refund escalation");
    await user.click(screen.getByText("Refund escalation"));

    await waitFor(() => expect(navbar()).toHaveAttribute("data-collapsed", "true"));
    expect(await screen.findByText("Approved refunds land in 3-5 days.")).toBeVisible();
  });
});

describe("Shell — desktop", () => {
  it("has no burger and never collapses the navbar on navigation", async () => {
    setViewportWidth(1440);
    const user = userEvent.setup();
    renderShell();

    expect(screen.queryByRole("button", { name: "Toggle navigation" })).not.toBeInTheDocument();
    expect(navbar()).toHaveAttribute("data-collapsed", "false");

    await user.click(screen.getByRole("button", { name: "+ New chat" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "New chat" })).toBeInTheDocument(),
    );
    // Same fixed column as before this task: still there, still not collapsed.
    expect(navbar()).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByRole("link", { name: "Chat" })).toBeVisible();
  });
});
