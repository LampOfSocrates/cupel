import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { setActiveTarget } from "../api/target";
import { EnvBanner } from "./EnvBanner";

// P2-CONFIG — "Non-prod targets show a colored banner in the app chrome so
// nobody mistakes mock data for real" (feature-spec.md:161).
describe("EnvBanner", () => {
  it("renders the target label for the mock target (the test/dev default)", () => {
    render(<EnvBanner />);
    expect(screen.getByTestId("env-banner")).toHaveTextContent("Mock backend");
  });

  it("is absent when the active target is prod", () => {
    setActiveTarget("prod");
    render(<EnvBanner />);
    expect(screen.queryByTestId("env-banner")).not.toBeInTheDocument();
  });
});
