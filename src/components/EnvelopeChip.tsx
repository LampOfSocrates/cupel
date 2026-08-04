import { Badge } from "@mantine/core";
import type { ContextEnvelope } from "../api/types";

// P1-T11a — reusable context-envelope display. "Every turn captures an
// envelope at generation: {system_date, timezone, region, locale, ...}.
// Stored on the turn, shown in trace header and Inspector metadata"
// (feature-spec.md:76). This is that display piece: consumed by the ChatPage
// turn-meta tooltip now, the T16 trace header and grid cells later.
// Null envelope = legacy/imported turn (openapi.yaml:1321-1323) — rendered as
// an explicit "no context recorded" state, never silently "now"
// (feature-spec.md:78).

export function envelopeSummary(envelope: ContextEnvelope | null | undefined): string {
  if (!envelope) return "no context recorded";
  return `${envelope.system_date} · ${envelope.timezone} · ${envelope.region} · ${envelope.locale}`;
}

export function EnvelopeChip({ envelope }: { envelope: ContextEnvelope | null | undefined }) {
  return (
    <Badge
      variant="light"
      color="gray"
      radius="sm"
      tt="none"
      fw={400}
      fs={envelope ? undefined : "italic"}
      data-testid="envelope-chip"
    >
      {envelopeSummary(envelope)}
    </Badge>
  );
}
