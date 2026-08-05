import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { http, HttpResponse } from "msw";
import { renderApp } from "../test/render";
import { server } from "../test/msw/server";
import { authTokenRequests, BASE, MOCK_JWT } from "../test/msw/handlers";
import { getAuthToken } from "../api/auth";
import { LoginPage } from "./LoginPage";

// P2-T07 login screen (unsketched — minimal centered card per the task):
// email + password → POST /auth/token (feature-spec.md:18), token stored for
// the active target, redirect to the VALIDATED return_to (lib/returnTo.ts) —
// the mechanism P2-SHARE deep links round-trip through.

function LocationProbe() {
  const loc = useLocation();
  return (
    <div data-testid="loc">
      {loc.pathname}
      {loc.search}
    </div>
  );
}

const renderLogin = (route: string) =>
  renderApp(
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<LocationProbe />} />
    </Routes>,
    { route },
  );

async function signIn(email = "admin@demo", password = "demo") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/Email/), email);
  await user.type(screen.getByLabelText(/^Password/), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("LoginPage (P2-T07)", () => {
  it("posts credentials, stores the token, and redirects to return_to incl. a ?turn= deep link", async () => {
    renderLogin("/login?return_to=%2Fchat%2Fc1%3Fturn%3Dt2");
    await signIn();

    await waitFor(() =>
      expect(screen.getByTestId("loc")).toHaveTextContent("/chat/c1?turn=t2"),
    );
    expect(authTokenRequests).toEqual([{ email: "admin@demo", password: "demo" }]);
    // Stored for the ACTIVE target (mock in dev) — attached by the client
    // from here on.
    expect(getAuthToken("mock")).toBe(MOCK_JWT);
  });

  it("falls back to / when return_to is absent or not same-origin-relative", async () => {
    renderLogin("/login?return_to=http%3A%2F%2Fevil.example%2Fchat");
    await signIn();
    await waitFor(() => expect(screen.getByTestId("loc")).toHaveTextContent("/"));
    expect(screen.getByTestId("loc").textContent).toBe("/");
  });

  it("bad credentials show the backend's error and store nothing", async () => {
    renderLogin("/login");
    await signIn("admin@demo", "wrong");

    await screen.findByText("Invalid email or password.");
    expect(getAuthToken("mock")).toBeNull();
    // Still on the login page — no navigation happened.
    expect(screen.queryByTestId("loc")).not.toBeInTheDocument();
  });

  it("a network failure surfaces as an inline error state", async () => {
    server.use(http.post(`${BASE}/auth/token`, () => HttpResponse.error()));
    renderLogin("/login");
    await signIn();
    await screen.findByText("Sign-in failed", { exact: false });
    expect(getAuthToken("mock")).toBeNull();
  });
});
