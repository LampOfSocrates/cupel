import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { setActiveTarget } from "../api/target";
import { EnvBanner } from "./EnvBanner";

// P2-T17 — banner config lives on the target (agentic.config.ts
// BackendTarget.banner); "Non-prod targets show a colored banner in the app
// chrome so nobody mistakes mock data for real" (feature-spec.md:161).
describe("EnvBanner", () => {
  it("renders the mock target's configured banner (the test/dev default)", () => {
    render(<EnvBanner />);
    const banner = screen.getByTestId("env-banner");
    expect(banner).toHaveTextContent("MOCK BACKEND");
    expect(banner).toHaveStyle({ background: "#e8590c" });
  });

  it("staging renders its configured label and color", () => {
    setActiveTarget("staging");
    render(<EnvBanner />);
    const banner = screen.getByTestId("env-banner");
    expect(banner).toHaveTextContent("STAGING BACKEND");
    expect(banner).toHaveStyle({ background: "#1971c2" });
  });

  it("targets WITHOUT banner config fall back to the id rule: '<label> backend'", () => {
    setActiveTarget("local"); // local declares no banner in agentic.config.ts
    render(<EnvBanner />);
    expect(screen.getByTestId("env-banner")).toHaveTextContent("Local backend");
  });

  it("is absent for prod (banner: false in the config)", () => {
    setActiveTarget("prod");
    render(<EnvBanner />);
    expect(screen.queryByTestId("env-banner")).not.toBeInTheDocument();
  });
});
