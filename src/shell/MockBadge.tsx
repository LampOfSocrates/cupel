import { Badge, Tooltip } from "@mantine/core";
import { mockedFamilies, type Family } from "../lib/families";

// "served by mock" — the one thing a generated app must never leave implicit.
// A folder where half the screens are the adopter's backend and half are the
// bundled demo one is only honest if the app says which is which
// (docs/plan-adopter-onboarding.md: "without it the adopter cannot tell which
// half of the screen is real").
//
// It is per SCREEN, not a global notice: the Shell renders it only on pages
// the mock is answering (lib/families mockedFamilyOfRoute), and the tooltip
// names every mocked family so "what else is fake?" is one hover away. An app
// with no `families` block never renders it at all.
export function MockBadge({ family }: { family: Family }) {
  return (
    <Tooltip
      label={`Served by the bundled mock: ${mockedFamilies().join(", ")}. Everything else talks to your backend.`}
      multiline
      w={260}
    >
      <Badge
        data-testid="mock-badge"
        size="xs"
        variant="light"
        color="orange"
        style={{ cursor: "help" }}
      >
        {family} · served by mock
      </Badge>
    </Tooltip>
  );
}
