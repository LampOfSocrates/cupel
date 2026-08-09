import { Children, type ReactNode } from "react";
import { Group, Text, UnstyledButton } from "@mantine/core";

// Node card shared by the agent tree view and the trace call
// tree — "reusing the trace view's node components (same colors/shapes; no
// timings — this is structure, not execution)" (feature-spec.md:24);
// "(Agent tree view: reuse 08's node components, structure-only — no separate
// sketch.)" (cupel-phases.md:40). Palette lifted from sketches/clean/08-trace.svg:
// agent #EEEDFE/#534AB7, tool #E1F5EE/#0F6E56, llm #FAECE7/#993C1D, connectors
// #B4B2A9.

export type TreeNodeKind = "agent" | "tool" | "llm";

const KIND_STYLE: Record<TreeNodeKind, { bg: string; border: string; title: string; meta: string }> = {
  agent: { bg: "#EEEDFE", border: "#534AB7", title: "#3C3489", meta: "#534AB7" },
  tool: { bg: "#E1F5EE", border: "#0F6E56", title: "#085041", meta: "#0F6E56" },
  llm: { bg: "#FAECE7", border: "#993C1D", title: "#712B13", meta: "#993C1D" },
};

const CONNECTOR = "#B4B2A9";

interface TreeNodeProps {
  label: string;
  /** Small subline under the label (trace: "0.4s·900→60"; agents unused). */
  meta?: string;
  kind?: TreeNodeKind;
  /** Disabled/unpermitted styling (feature-spec.md:25). */
  dimmed?: boolean;
  /** Trace call-tree selection highlight (synced with the waterfall). */
  selected?: boolean;
  /** "Errors mark the span red in both views" (feature-spec.md:145). */
  error?: boolean;
  /** Badge row inside the card (agent view: version + tools + enabled state). */
  badges?: ReactNode;
  /** Rendered outside the clickable card (agent view: ⋯ menu). */
  actions?: ReactNode;
  onClick?: () => void;
}

export function TreeNode({
  label,
  meta,
  kind = "agent",
  dimmed = false,
  selected = false,
  error = false,
  badges,
  actions,
  onClick,
}: TreeNodeProps) {
  const style = KIND_STYLE[kind];
  return (
    <Group gap={4} wrap="nowrap" align="flex-start" style={{ display: "inline-flex" }}>
      <UnstyledButton
        onClick={onClick}
        aria-label={`Open ${label}`}
        data-selected={selected || undefined}
        data-error={error || undefined}
        px={10}
        py={6}
        style={{
          background: style.bg,
          border: error
            ? "2px solid var(--mantine-color-red-7)"
            : `1px solid ${style.border}`,
          borderRadius: 8,
          opacity: dimmed ? 0.5 : 1,
          outline: selected ? "2px solid var(--mantine-color-blue-5)" : undefined,
          outlineOffset: selected ? 1 : undefined,
        }}
      >
        <Text size="sm" fw={600} c={style.title}>
          {label}
        </Text>
        {meta && (
          <Text size="xs" style={{ color: style.meta }}>
            {meta}
          </Text>
        )}
        {badges && (
          <Group gap={4} mt={4}>
            {badges}
          </Group>
        )}
      </UnstyledButton>
      {actions}
    </Group>
  );
}

// Indented children container with elbow connector lines (the sketch's
// #B4B2A9 right-angle connectors, drawn with borders — no graph lib).
export function TreeBranch({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginLeft: 18, borderLeft: `1px solid ${CONNECTOR}` }}>
      {Children.map(children, (child) =>
        child == null ? child : (
          <div style={{ display: "flex", alignItems: "flex-start", paddingTop: 8 }}>
            <div
              style={{
                width: 14,
                borderTop: `1px solid ${CONNECTOR}`,
                marginTop: 16,
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>{child}</div>
          </div>
        ),
      )}
    </div>
  );
}
