import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  Alert,
  Badge,
  Button,
  Group,
  Kbd,
  Loader,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { api } from "../api/client";
import { useAsync } from "../hooks/useAsync";
import { useApp } from "../AppContext";
import { CollectModal } from "../components/CollectModal";
import { EnvelopeChip } from "../components/EnvelopeChip";
import { ScoreChip } from "../components/ScoreChip";
import { relativeTime } from "../lib/relativeTime";
import { Markdown } from "../lib/markdown";
import { product } from "../lib/product";
import type { CasebookItemCreate } from "../api/types";

// Inspector (UNSKETCHED — derived from the app's existing dense visual
// language per cupel-phases.md:95: the Settings → Members table and the runs
// grid are the references. Paper blocks, size-xs controls, one dense Table).
//
// cupel-phases.md:78: "Inspect every conversation in the system as a super
// user — filter by user, tree, date, or score in a dense keyboard-driven table
// with an inline transcript reader — using the Inspector (unsketched; requires
// the `inspect` role, audit-logged)".
//
// Data: GET /admin/conversations (openapi.yaml:298-348) for the table — the
// contract's own six filters plus page/page_size — and the ordinary
// GET /agenttrees/{tree}/conversations/{id} for the inline reader, because the
// admin rows are a dense INDEX and carry no transcript.
//
// Visibility is ROLE-driven, never mode-driven: the route and the nav entry
// render only when /me.roles includes `inspect` (App.tsx / Sidebar.tsx). This
// page additionally shows the 403 the server returns if a backend disagrees —
// it never inspects the backend's auth mode.
//
// KEYBOARD MAP (feature-spec.md:289 "keyboard nav j/k/a"):
//   j — next conversation row (loads it in the reader)
//   k — previous conversation row
//   a — ⊞ collect the focused turn into a casebook
// Keys are ignored while typing in a filter field or while a modal is open.
//
// Filters live in the URL (feature-spec.md:289 "filters as URL params"), so an
// inspection is a shareable link — the same reasoning as the share deep links.
//
// NOT virtualized (the dev prompt's "virtualized" wish): the contract caps
// page_size at 100 (openapi.yaml:340), so a page is at most 100 rows and
// pagination — not virtualization — is the contract's own answer to volume.
// Adding a windowing dependency for 100 rows would be gold-plating.

const PAGE_SIZE = 25;

const FILTER_KEYS = ["user_id", "tree", "date_from", "date_to", "score_min", "score_max"] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Record<FilterKey, string>;

const EMPTY: Filters = {
  user_id: "",
  tree: "",
  date_from: "",
  date_to: "",
  score_min: "",
  score_max: "",
};

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

export function InspectorPage() {
  const { trees } = useApp();
  const [params, setParams] = useSearchParams();

  // The URL is the source of truth for filters; `draft` is the unsubmitted
  // form buffer so typing does not refetch on every keystroke.
  const applied = useMemo(() => {
    const next = { ...EMPTY };
    for (const key of FILTER_KEYS) next[key] = params.get(key) ?? "";
    return next;
  }, [params]);
  const page = Math.max(1, Number(params.get("page") ?? "1") || 1);
  const [draft, setDraft] = useState<Filters>(applied);
  useEffect(() => setDraft(applied), [applied]);

  const [pickedId, setPickedId] = useState<string | null>(null);
  const { data: pageData, error } = useAsync(
    () =>
      api.adminConversations({
        user_id: applied.user_id || undefined,
        tree: applied.tree || undefined,
        date_from: applied.date_from || undefined,
        date_to: applied.date_to || undefined,
        score_min: applied.score_min === "" ? undefined : Number(applied.score_min),
        score_max: applied.score_max === "" ? undefined : Number(applied.score_max),
        page,
        page_size: PAGE_SIZE,
      }),
    [applied, page],
  );

  const commit = (next: Filters, nextPage = 1) => {
    const search = new URLSearchParams();
    for (const key of FILTER_KEYS) if (next[key]) search.set(key, next[key]);
    if (nextPage > 1) search.set("page", String(nextPage));
    setParams(search);
  };

  const rows = pageData?.items ?? [];
  // Derived, not stored: a new page (or one the picked row fell out of) opens
  // on its first row.
  const selectedId =
    pickedId && rows.some((r) => r.id === pickedId) ? pickedId : (rows[0]?.id ?? null);
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const selectedIndex = rows.findIndex((r) => r.id === selectedId);
  const totalPages = pageData ? Math.max(1, Math.ceil(pageData.total / PAGE_SIZE)) : 1;

  // ------------------------------------------------------- inline reader
  const [focusedTurnId, setFocusedTurnId] = useState<string | null>(null);
  const { data: transcript, error: readerError } = useAsync(
    selected ? () => api.conversation(selected.tree_id, selected.id) : null,
    [selected],
  );

  // Open on the newest answer; the reader's keyboard nav moves it from there.
  useEffect(() => {
    const turns = transcript?.turns ?? [];
    const lastAssistant = [...turns].reverse().find((t) => t.role === "assistant");
    setFocusedTurnId(lastAssistant?.id ?? turns[turns.length - 1]?.id ?? null);
  }, [transcript]);

  // ------------------------------------------------------- ⊞ collect + keys
  const [collectTarget, setCollectTarget] = useState<CasebookItemCreate | null>(null);
  const collect = useCallback(
    (turnId: string | null) => {
      if (!selected || !turnId) return;
      setCollectTarget({
        tree: selected.tree_id,
        conversation_id: selected.id,
        turn_id: turnId,
      });
    },
    [selected],
  );

  // Effect event: the window listener is subscribed ONCE, but each keypress
  // must see the current rows/selection/focus — re-subscribing per render
  // would be churn, and a ref written during render is a render-phase side
  // effect (react-hooks/refs). Everything it reads lives in this component,
  // so an effect event fits; nothing crosses a component boundary.
  const onKeyPress = useEffectEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (collectTarget !== null) return;
    if (e.key === "j" || e.key === "k") {
      if (rows.length === 0) return;
      e.preventDefault();
      const delta = e.key === "j" ? 1 : -1;
      const next = Math.min(Math.max(selectedIndex + delta, 0), rows.length - 1);
      setPickedId(rows[next].id);
    } else if (e.key === "a") {
      e.preventDefault();
      collect(focusedTurnId);
    }
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onKeyPress(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const treeOptions = [
    { value: "", label: `All ${product.tree.many}` },
    ...trees.map((t) => ({ value: t.id, label: t.name })),
  ];

  return (
    <Stack gap="sm" p="md">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={4}>Inspector</Title>
          <Text size="xs" c="dimmed">
            Every conversation in the system, across users. Filter, read the transcript inline,
            and press <Kbd>a</Kbd> to collect a turn into a casebook. Every query here is
            audit-logged server-side.
          </Text>
        </div>
        <Text size="xs" c="dimmed">
          <Kbd>j</Kbd> / <Kbd>k</Kbd> move · <Kbd>a</Kbd> collect
        </Text>
      </Group>

      <Paper withBorder p="xs">
        <Group gap="xs" align="flex-end" wrap="wrap">
          <TextInput
            size="xs"
            label="User"
            placeholder="user id"
            style={{ width: 150 }}
            value={draft.user_id}
            onChange={(e) => setDraft({ ...draft, user_id: e.currentTarget.value })}
            onKeyDown={(e) => e.key === "Enter" && commit(draft)}
          />
          <Select
            size="xs"
            label={product.tree.One}
            style={{ width: 150 }}
            data={treeOptions}
            value={draft.tree}
            allowDeselect={false}
            onChange={(value) => commit({ ...draft, tree: value ?? "" })}
          />
          <TextInput
            size="xs"
            type="date"
            label="From"
            style={{ width: 140 }}
            value={draft.date_from}
            onChange={(e) => commit({ ...draft, date_from: e.currentTarget.value })}
          />
          <TextInput
            size="xs"
            type="date"
            label="To"
            style={{ width: 140 }}
            value={draft.date_to}
            onChange={(e) => commit({ ...draft, date_to: e.currentTarget.value })}
          />
          <TextInput
            size="xs"
            label="Score ≥"
            placeholder="0"
            style={{ width: 90 }}
            value={draft.score_min}
            onChange={(e) => setDraft({ ...draft, score_min: e.currentTarget.value })}
            onKeyDown={(e) => e.key === "Enter" && commit(draft)}
          />
          <TextInput
            size="xs"
            label="Score ≤"
            placeholder="1"
            style={{ width: 90 }}
            value={draft.score_max}
            onChange={(e) => setDraft({ ...draft, score_max: e.currentTarget.value })}
            onKeyDown={(e) => e.key === "Enter" && commit(draft)}
          />
          <Button size="xs" onClick={() => commit(draft)}>
            Apply
          </Button>
          <Button size="xs" variant="default" onClick={() => commit(EMPTY)}>
            Clear
          </Button>
        </Group>
      </Paper>

      {error && (
        <Alert color="red" title="Inspector unavailable" data-testid="inspector-error">
          {error.message}
        </Alert>
      )}

      {!pageData && !error && <Loader size="sm" />}

      {pageData && rows.length === 0 && (
        <Paper withBorder p="lg" data-testid="inspector-empty">
          <Stack gap={4} align="center">
            <Text fw={600}>No conversations match these filters</Text>
            <Text size="xs" c="dimmed" ta="center" maw={520}>
              The Inspector reads every conversation in the system, whoever owns it. Widen the
              filters, or seed some traffic from Settings → Backend, then triage worst-first by
              setting a score ceiling.
            </Text>
          </Stack>
        </Paper>
      )}

      {pageData && rows.length > 0 && (
        <Paper withBorder>
          <ScrollArea.Autosize mah={320}>
            <Table stickyHeader highlightOnHover withRowBorders={false} verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>User</Table.Th>
                  <Table.Th>{product.tree.One}</Table.Th>
                  <Table.Th>Conversation</Table.Th>
                  <Table.Th>Origin</Table.Th>
                  <Table.Th>Activity</Table.Th>
                  <Table.Th>Score</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr
                    key={row.id}
                    data-testid="inspector-row"
                    data-selected={row.id === selectedId ? "true" : undefined}
                    bg={row.id === selectedId ? "var(--mantine-color-default-hover)" : undefined}
                    style={{ cursor: "pointer" }}
                    onClick={() => setPickedId(row.id)}
                  >
                    <Table.Td>
                      <Text size="xs" title={row.user_email ?? undefined}>
                        {row.user_id}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {row.tree_id}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Text size="xs" truncate maw={340} title={row.title}>
                          {row.title}
                        </Text>
                        {row.lineage && (
                          <Badge size="xs" variant="light">
                            fork
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {row.origin}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {relativeTime(row.last_activity_at)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {typeof row.latest_score === "number" ? (
                        <ScoreChip score={row.latest_score} />
                      ) : (
                        <Text size="xs" c="dimmed">
                          —
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
          <Group justify="space-between" p="xs">
            <Text size="xs" c="dimmed" data-testid="inspector-count">
              {pageData.total} conversation{pageData.total === 1 ? "" : "s"} · page {page} of{" "}
              {totalPages}
            </Text>
            <Group gap={6}>
              <Button
                size="compact-xs"
                variant="default"
                disabled={page <= 1}
                onClick={() => commit(applied, page - 1)}
              >
                Previous
              </Button>
              <Button
                size="compact-xs"
                variant="default"
                disabled={page >= totalPages}
                onClick={() => commit(applied, page + 1)}
              >
                Next
              </Button>
            </Group>
          </Group>
        </Paper>
      )}

      {/* Inline transcript reader — read the conversation without leaving the
          page (cupel-phases.md:78 "an inline transcript reader"). */}
      {selected && (
        <Paper withBorder p="xs" data-testid="inspector-reader">
          <Group justify="space-between" wrap="nowrap" mb={4}>
            <Group gap={6} wrap="nowrap">
              <Text size="sm" fw={600} truncate maw={420}>
                {selected.title}
              </Text>
              <Text size="xs" c="dimmed">
                {selected.user_id} · {selected.tree_id}
              </Text>
            </Group>
            <Group gap={6}>
              <Button
                size="compact-xs"
                variant="light"
                data-testid="reader-collect"
                disabled={!focusedTurnId}
                onClick={() => collect(focusedTurnId)}
              >
                ⊞ Collect (a)
              </Button>
              <Button
                size="compact-xs"
                variant="default"
                component={Link}
                to={`/chat/${selected.id}${focusedTurnId ? `?turn=${focusedTurnId}` : ""}`}
              >
                Open in Chat
              </Button>
            </Group>
          </Group>
          {readerError && <Alert color="red">{readerError.message}</Alert>}
          {!transcript && !readerError && <Loader size="xs" />}
          {transcript && (
            <ScrollArea.Autosize mah={340}>
              <Stack gap={4}>
                {(transcript.turns ?? []).map((turn) => (
                  <UnstyledButton
                    key={turn.id}
                    data-testid="reader-turn"
                    data-focused={turn.id === focusedTurnId ? "true" : undefined}
                    onClick={() => setFocusedTurnId(turn.id)}
                    style={{
                      width: "100%",
                      borderLeft:
                        turn.id === focusedTurnId
                          ? "2px solid var(--mantine-color-blue-6)"
                          : "2px solid transparent",
                      paddingLeft: 8,
                    }}
                  >
                    <Group gap={6} wrap="nowrap" align="baseline">
                      <Text size="xs" c="dimmed" w={72} style={{ flexShrink: 0 }}>
                        {turn.author}
                      </Text>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {turn.role === "assistant" ? (
                          <Markdown content={turn.content} />
                        ) : (
                          <Text size="sm">{turn.content}</Text>
                        )}
                      </div>
                      {turn.envelope && <EnvelopeChip envelope={turn.envelope} />}
                    </Group>
                  </UnstyledButton>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Paper>
      )}

      <CollectModal
        opened={collectTarget !== null}
        target={collectTarget}
        onClose={() => setCollectTarget(null)}
      />
    </Stack>
  );
}
