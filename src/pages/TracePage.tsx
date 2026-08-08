import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import {
  Alert,
  Badge,
  Code,
  Drawer,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { api } from "../api/client";
import type { Span, SpanPayload, Trace } from "../api/types";
import { EnvelopeChip, TreeBranch, TreeNode, type TreeNodeKind } from "../components";
import { useApp } from "../AppContext";

// P1-T16 — Trace view (sketch 08). Spec:
// - feature-spec.md:146-148: "Trace view, two synced layers: Call tree: nodes
//   colored by type (agent / tool / LLM), each badged `time · tokens in→out`.
//   Header shows turn totals (wall time, total tokens in/out, cost).
//   Waterfall: one row per span, bars positioned on the turn's timeline —
//   sequence, duration, and parallel branches visible at a glance."
// - feature-spec.md:149: "Span drawer (tap node or bar): full prompt/response
//   for LLM spans, args/result for tool spans, model, exact token counts,
//   cost, status/error. Errors mark the span red in both views."
// - feature-spec.md:150: "Traces stream: spans appear live while the turn is
//   generating (same SSE channel as tasks)."
// - openapi.yaml:696-721 GET .../turns/{turnId}/trace (flat span list with
//   parent links + totals + envelope "Shown in the trace header", :1700);
//   openapi.yaml:723-744 GET /spans/{spanId}/payload, lazy-loaded on drawer
//   open; spanId = Span.payload_ref (openapi.yaml:1690).
//
// Entry (feature-spec.md:145): "⌁ trace icon on every turn — in Chat, results
// grid cells, and drill-in. Works on originals, forks, and replays alike" —
// all of which land on this one route (/trace/{turnId}; tree from context,
// same as every other page).
//
// LIVE HEURISTIC (documented design choice): the page subscribes a scoped
// /tasks/stream iff the fetched trace contains a span with status "running" —
// the simplest honest rule: a turn opened mid-generation has its still-open
// spans in the GET response (the mock persists each span before streaming it,
// engine.py:182-184), and a finished turn has none. Span frames whose turn_id
// matches merge in place (replace by id, else append); when the last running
// span closes, the page refetches once for authoritative server totals and
// unsubscribes ("stop on done/terminal or unmount").

const BAR_COLOR: Record<TreeNodeKind, string> = {
  agent: "#534AB7", // sketch 08 waterfall bar fills
  tool: "#0F6E56",
  llm: "#993C1D",
};
const ERROR_COLOR = "var(--mantine-color-red-7)";

const ms = (iso: string) => new Date(iso).getTime();

function fmtDuration(millis: number): string {
  return `${(millis / 1000).toFixed(1)}s`;
}

// Badge "time · tokens in→out" (feature-spec.md:147); tool spans without
// token counts show time alone, like the sketch's "0.6s".
function spanMeta(span: Span): string {
  const dur =
    span.end == null
      ? "running…"
      : fmtDuration(Math.max(0, ms(span.end) - ms(span.start)));
  return span.tokens_in != null || span.tokens_out != null
    ? `${dur} · ${span.tokens_in ?? 0}→${span.tokens_out ?? 0}`
    : dur;
}

export function TracePage() {
  const { tree } = useApp();
  const { turnId = "" } = useParams();

  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTrace(await api.trace(tree, turnId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tree, turnId]);

  useEffect(() => {
    setTrace(null);
    setError(null);
    setSelectedId(null);
    void load();
  }, [load]);

  const hasRunning = trace?.spans.some((s) => s.status === "running") ?? false;

  // Live span merge — see the LIVE HEURISTIC note above. The subscription key
  // is the boolean, so a frame that inserts ANOTHER running span does not
  // resubscribe; the flip to false aborts via cleanup.
  useEffect(() => {
    if (!hasRunning) return;
    const controller = new AbortController();
    // `stopped` mirrors RunDetailPage/QueueContext: the fetch abort alone
    // can't be relied on to interrupt an in-flight body read in every
    // transport (MSW's jsdom one doesn't), so merges are gated explicitly.
    let stopped = false;
    void (async () => {
      try {
        for await (const ev of api.taskStream({ signal: controller.signal })) {
          if (stopped) break;
          if (ev.event !== "span" || ev.data.turn_id !== turnId) continue;
          const span = ev.data.span;
          setTrace(
            (t) =>
              t && {
                ...t,
                spans: t.spans.some((s) => s.id === span.id)
                  ? t.spans.map((s) => (s.id === span.id ? span : s))
                  : [...t.spans, span],
              },
          );
        }
      } catch {
        // aborted on unmount/terminal, or stream dropped — the stored trace
        // stays renderable; a reload refetches.
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [hasRunning, turnId]);

  // Terminal transition (last running span closed) → one refetch for the
  // server's final totals (totals are server-computed, openapi.yaml:1701-1709
  // — the client never derives them).
  const prevRunning = useRef(false);
  useEffect(() => {
    if (prevRunning.current && !hasRunning) void load();
    prevRunning.current = hasRunning;
  }, [hasRunning, load]);

  const spans = useMemo(() => trace?.spans ?? [], [trace]);

  // Timeline domain: [min start, max end] across the trace; running spans
  // (end null) extend to the right edge.
  const { minStart, range } = useMemo(() => {
    if (spans.length === 0) return { minStart: 0, range: 1 };
    let min = Infinity;
    let max = -Infinity;
    for (const span of spans) {
      const start = ms(span.start);
      const end = span.end == null ? start : ms(span.end);
      if (start < min) min = start;
      if (end > max) max = end;
    }
    return { minStart: min, range: Math.max(1, max - min) };
  }, [spans]);

  // Nested call tree from parent links (openapi.yaml:717 "flat span list with
  // parent links"). Orphans (parent not in the list — possible mid-live)
  // render as roots rather than vanishing.
  const { roots, childrenOf } = useMemo(() => {
    const ids = new Set(spans.map((s) => s.id));
    const childrenOf = new Map<string, Span[]>();
    const roots: Span[] = [];
    for (const span of spans) {
      if (span.parent_id != null && ids.has(span.parent_id)) {
        const siblings = childrenOf.get(span.parent_id) ?? [];
        siblings.push(span);
        childrenOf.set(span.parent_id, siblings);
      } else {
        roots.push(span);
      }
    }
    return { roots, childrenOf };
  }, [spans]);

  if (error) {
    return (
      <Alert color="red" title="Could not load trace" m="md" maw={640}>
        {error}
      </Alert>
    );
  }
  if (!trace) {
    return <Loader size="sm" mx="auto" my="xl" display="block" />;
  }

  const selected = spans.find((s) => s.id === selectedId) ?? null;

  const renderNode = (span: Span) => {
    const children = childrenOf.get(span.id) ?? [];
    return (
      <div key={span.id}>
        <TreeNode
          label={span.name}
          meta={spanMeta(span)}
          kind={span.type}
          selected={span.id === selectedId}
          error={span.status === "error"}
          badges={
            span.status === "error" ? (
              <Badge size="xs" color="red" variant="filled">
                error
              </Badge>
            ) : span.status === "running" ? (
              <Badge size="xs" color="blue" variant="light">
                running
              </Badge>
            ) : undefined
          }
          onClick={() => setSelectedId(span.id)}
        />
        {children.length > 0 && <TreeBranch>{children.map(renderNode)}</TreeBranch>}
      </div>
    );
  };

  return (
    <Stack gap="sm" p="md">
      {/* Header — turn totals (feature-spec.md:147) + envelope
          (openapi.yaml:1700 "Shown in the trace header"). Density per
          sketches/clean/08-trace.svg: "Trace · turn 2 · 4.9s · 6,410→1,240
          tok · $0.011". */}
      <Group gap="xs" wrap="wrap">
        <Title order={4}>
          Trace · {trace.turn_id} · {fmtDuration(trace.totals.wall_time_ms)} ·{" "}
          {trace.totals.tokens_in}→{trace.totals.tokens_out} tok · $
          {trace.totals.cost.toFixed(4)}
        </Title>
        <EnvelopeChip envelope={trace.envelope} />
        {hasRunning && (
          <Badge size="sm" color="blue" variant="light" data-testid="trace-live">
            live
          </Badge>
        )}
      </Group>

      {spans.length === 0 ? (
        <Text c="dimmed" size="sm">
          No spans recorded for this turn.
        </Text>
      ) : (
        <>
          {/* Layer 1 — call tree. */}
          <div data-testid="call-tree">
            <Stack gap={8}>{roots.map(renderNode)}</Stack>
          </div>

          {/* Layer 2 — waterfall: one row per span in trace order, CSS bars on
              the shared timeline (no chart lib, like the T12b sparkline). */}
          <Text size="xs" c="dimmed">
            Waterfall
          </Text>
          <Paper withBorder p="sm" data-testid="waterfall">
            <style>
              {/* running bars pulse to signal in-flight (feature-spec.md:150) */}
              {"@keyframes cupel-span-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }"}
            </style>
            <Stack gap={6}>
              {spans.map((span, i) => {
                const left = ((ms(span.start) - minStart) / range) * 100;
                const running = span.end == null;
                const width = running
                  ? 100 - left
                  : ((ms(span.end!) - ms(span.start)) / range) * 100;
                const isSelected = span.id === selectedId;
                return (
                  <UnstyledButton
                    key={span.id}
                    onClick={() => setSelectedId(span.id)}
                    aria-label={`Select span ${span.name}`}
                    data-testid={`wf-bar-${i}`}
                    data-span-id={span.id}
                    data-selected={isSelected || undefined}
                    data-running={running || undefined}
                    data-error={span.status === "error" || undefined}
                    px={4}
                    py={1}
                    style={{
                      borderRadius: 4,
                      background: isSelected ? "var(--mantine-color-blue-0)" : undefined,
                    }}
                  >
                    <Group gap={8} wrap="nowrap">
                      <Text
                        size="xs"
                        c="dimmed"
                        w={110}
                        ta="right"
                        truncate
                        style={{ flexShrink: 0 }}
                      >
                        {span.name}
                      </Text>
                      <div style={{ flex: 1, position: "relative", height: 12 }}>
                        <div
                          style={{
                            position: "absolute",
                            left: `${left}%`,
                            width: `max(${width}%, 3px)`,
                            height: 10,
                            top: 1,
                            borderRadius: 3,
                            background:
                              span.status === "error"
                                ? ERROR_COLOR
                                : BAR_COLOR[span.type],
                            animation: running
                              ? "cupel-span-pulse 1.2s ease-in-out infinite"
                              : undefined,
                          }}
                        />
                      </div>
                      <Text size="xs" c="dimmed" w={64} style={{ flexShrink: 0 }}>
                        {running
                          ? "running…"
                          : fmtDuration(ms(span.end!) - ms(span.start))}
                      </Text>
                    </Group>
                  </UnstyledButton>
                );
              })}
            </Stack>
          </Paper>
        </>
      )}

      {selected && (
        <SpanDrawer span={selected} opened onClose={() => setSelectedId(null)} />
      )}
    </Stack>
  );
}

// Span drawer (feature-spec.md:149): payload lazy-loaded on open via GET
// /spans/{payload_ref}/payload (openapi.yaml:729-730 "lazy-loaded
// prompt/response bodies") — never prefetched with the trace.
function SpanDrawer({
  span,
  opened,
  onClose,
}: {
  span: Span;
  opened: boolean;
  onClose: () => void;
}) {
  const [payload, setPayload] = useState<SpanPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPayload(null);
    setError(null);
    let cancelled = false;
    api
      .spanPayload(span.payload_ref)
      .then((data) => {
        if (!cancelled) setPayload(data);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [span.payload_ref]);

  const duration =
    span.end == null ? "running…" : fmtDuration(ms(span.end) - ms(span.start));

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="md"
      title={`Span: ${span.name}`}
    >
      <Stack gap="xs" data-testid="span-drawer">
        {/* model, exact token counts, cost, status (feature-spec.md:149) */}
        <Group gap={6}>
          <Badge size="sm" variant="light">
            {span.type}
          </Badge>
          {span.model && (
            <Text size="xs" c="dimmed" data-testid="span-model">
              {span.model}
            </Text>
          )}
          <Text size="xs" c="dimmed" data-testid="span-stats">
            {span.tokens_in != null || span.tokens_out != null
              ? `${span.tokens_in ?? 0}→${span.tokens_out ?? 0} tok · `
              : ""}
            {span.cost != null ? `$${span.cost.toFixed(4)} · ` : ""}
            {duration}
          </Text>
        </Group>
        {/* "status/error prominent when error" — red in the drawer too. */}
        {span.status === "error" ? (
          <Alert color="red" title="Span failed" data-testid="span-error">
            {span.error ?? "error"}
          </Alert>
        ) : (
          <Text size="xs" c="dimmed">
            status: {span.status}
          </Text>
        )}
        {error && <Alert color="red">{error}</Alert>}
        {!payload && !error && <Loader size="xs" />}
        {payload && (
          <>
            {/* LLM spans: full prompt/response. Rendered as PLAIN monospace
                text (pre-wrap), never through the markdown pipeline — the
                payload is the model's raw I/O, shown verbatim. */}
            {payload.prompt != null && (
              <PayloadSection label="PROMPT" text={payload.prompt} />
            )}
            {payload.response != null && (
              <PayloadSection label="RESPONSE" text={payload.response} />
            )}
            {/* Tool spans: args/result as formatted JSON. */}
            {payload.args != null && (
              <PayloadSection label="ARGS" text={JSON.stringify(payload.args, null, 2)} />
            )}
            {payload.result != null && (
              <PayloadSection
                label="RESULT"
                text={JSON.stringify(payload.result, null, 2)}
              />
            )}
          </>
        )}
      </Stack>
    </Drawer>
  );
}

function PayloadSection({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <Text size="xs" c="dimmed" fw={600}>
        {label}
      </Text>
      <Code block style={{ whiteSpace: "pre-wrap" }}>
        {text}
      </Code>
    </div>
  );
}
