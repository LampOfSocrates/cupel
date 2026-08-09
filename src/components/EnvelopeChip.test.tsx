import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { EnvelopeChip, envelopeSummary } from "./EnvelopeChip";

// Envelope display contract: "{system_date, timezone, region,
// locale, user_profile_ref?}" (feature-spec.md:76); null is permitted only on
// legacy/imported turns (openapi.yaml:1321-1323) and must render an explicit
// state, never a fabricated envelope (feature-spec.md:78).

const envelope = {
  system_date: "2026-08-02",
  timezone: "Europe/London",
  region: "GB",
  locale: "en-GB",
};

function renderChip(env: typeof envelope | null) {
  return render(
    <MantineProvider env="test">
      <EnvelopeChip envelope={env} />
    </MantineProvider>,
  );
}

describe("EnvelopeChip", () => {
  it("renders all four required envelope fields (openapi.yaml:1264)", () => {
    renderChip(envelope);
    const chip = screen.getByTestId("envelope-chip");
    expect(chip).toHaveTextContent("2026-08-02");
    expect(chip).toHaveTextContent("Europe/London");
    expect(chip).toHaveTextContent("GB");
    expect(chip).toHaveTextContent("en-GB");
  });

  it("renders the explicit no-context state for a null envelope", () => {
    renderChip(null);
    expect(screen.getByTestId("envelope-chip")).toHaveTextContent("no context recorded");
  });

  it("envelopeSummary joins fields with · and handles null", () => {
    expect(envelopeSummary(envelope)).toBe("2026-08-02 · Europe/London · GB · en-GB");
    expect(envelopeSummary(null)).toBe("no context recorded");
    expect(envelopeSummary(undefined)).toBe("no context recorded");
  });
});
