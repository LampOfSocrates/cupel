import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import {
  Alert,
  Anchor,
  Badge,
  Group,
  Loader,
  MultiSelect,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { agenticConfig } from "../../../agentic.config";
import { api } from "../../api/client";
import { getSseEnabled } from "../../api/backendPrefs";
import type { Attachment, Endpoint, Run, RunCell, Turn } from "../../api/types";
import { useApp } from "../../AppContext";
import { Markdown } from "../../lib/markdown";
import { Composer } from "./Composer";
import {
  MAX_COMPARE_COLUMNS,
  resolveCompareSet,
  setsForTree,
  validateCompareSets,
} from "./compareSets";
import { createDraftStore, type DraftStore } from "./draftStore";
import type { ChatSettings } from "./types";

// A/B compare in chat, within one backend (docs/plan-ab-compare.md §2a, §3).
//
// The send is "re-fire, but for a new message instead of an existing turn":
// POST /chat writes the shared user turn and generates the FIRST column, then
// POST /agenttrees/{tree}/replay/turn fans that turn out to the picked
// endpoints — "one request, N conversations, ONE run_id" (plan §2a). Because
// the result IS a run, the comparison grid, the judge, the summary, the queue,
// cancel and retry-failed all work unchanged (plan §2a), and every fan-out
// column is a real forked conversation you can open and continue (plan §3).
//
// Column 0 is the run's own `baseline` column: the reply the current
// configuration produced. It is also the anchor the fan-out needs — nothing in
// the contract re-fires a turn that does not exist yet — so it is a column, not
// an extra hidden cost, and the cost warning counts it.
//
// WHAT VARIES PER COLUMN: the endpoint, and only the endpoint.
// ReplayTurnRequest carries `endpoints[]` (one column each) but a SINGLE
// `config` shared by all of them (openapi.yaml ReplayTurnRequest), so
// per-column instruction version / model is not expressible under contract
// v0.3.0. Runs (POST /replay with configs[]) is where those axes live today.
// The same limit is what compareSets.ts refuses a preset for, rather than
// running it as an endpoints-only comparison.

export { MAX_COMPARE_COLUMNS } from "./compareSets";

const TERMINAL = new Set<Run["status"]>(["done", "failed", "cancelled"]);
const REFETCH_DEBOUNCE_MS = 300;

/**
 * The chat-header toggle. Plan §3 "Dev-only gating — free, no new concept":
 * A/B is a tuning activity, so this is gated on `tune` for the ACTIVE tree
 * from the boot /me — no new role, no dependence on how the backend
 * authenticates, and a read-only viewer simply never sees it.
 */
export function CompareToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const { me, tree } = useApp();
  if (!(me.permissions[tree] ?? []).includes("tune")) return null;
  return (
    <Switch
      size="xs"
      label="Compare"
      checked={enabled}
      onChange={(e) => onChange(e.currentTarget.checked)}
      data-testid="compare-toggle"
    />
  );
}

export function CompareView({
  conversationId,
  chatSettings,
  onConversation,
}: {
  conversationId: string | null;
  chatSettings: ChatSettings;
  /** The conversation the shared turn landed in (new or existing). */
  onConversation: (conversationId: string) => void;
}) {
  const { tree } = useApp();
  const navigate = useNavigate();

  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [presetId, setPresetId] = useState<string | null>(null);
  // The shared user turn, rendered above the columns (plan §3).
  const [prompt, setPrompt] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Turn | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Same external store the single-column transcript uses: a token re-renders
  // one column, not the page (docs/review-2026-08-05.md A8).
  const [draft] = useState(createDraftStore);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .endpoints(tree)
      .then((data) => {
        if (cancelled) return;
        setEndpoints(data);
        // Arrive configured: the usual A/B is "everything the tree deploys to",
        // trimmed to the column cap. Ad-hoc selection still overrides it.
        setSelected((prev) =>
          prev.length > 0
            ? prev
            : data.slice(0, MAX_COMPARE_COLUMNS - 1).map((e) => e.id),
        );
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [tree]);

  const loadRun = useCallback(async () => {
    if (!runId) return;
    try {
      setRun(await api.run(tree, runId));
    } catch {
      // Non-critical: the columns keep their last state and the
      // "See the comparison" link still opens the grid.
    }
  }, [tree, runId]);

  useEffect(() => {
    void loadRun();
  }, [loadRun]);

  // Live fill on the contract's own channel — "Cells fill incrementally as
  // child tasks finish; live fill arrives via GET /tasks/stream"
  // (openapi.yaml:678-680), debounced-refetched exactly as EvaluationPage does.
  const runTaskId = run?.task_id;
  const runTerminal = run != null && TERMINAL.has(run.status);
  useEffect(() => {
    if (!runTaskId || runTerminal) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      try {
        for await (const ev of api.taskStream({ signal: controller.signal })) {
          const mine =
            (ev.event === "task" &&
              (ev.data.id === runTaskId || ev.data.parent_id === runTaskId)) ||
            (ev.event === "progress" && ev.data.task_id === runTaskId);
          if (mine && timer === null) {
            timer = setTimeout(() => {
              timer = null;
              void loadRun();
            }, REFETCH_DEBOUNCE_MS);
          }
        }
      } catch {
        // Aborted, or the stream dropped — the grid link is the fallback.
      }
    })();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [runTaskId, runTerminal, loadRun]);

  const send = async (text: string, uploaded: Attachment[]) => {
    setError(null);
    setPrompt(text);
    setBaseline(null);
    setRun(null);
    setRunId(null);
    draft.reset();
    setStreaming(true);
    const abort = new AbortController();
    abortRef.current = abort;
    const attachmentIds = uploaded.map((a) => a.id);
    let convId = conversationId;
    let anchor: Turn | null = null;
    try {
      const result = await api.chat(
        tree,
        {
          message: text,
          conversation_id: convId ?? undefined,
          stream: getSseEnabled(),
          ...(attachmentIds.length > 0 ? { attachments: attachmentIds } : {}),
          ...chatSettings,
        },
        { signal: abort.signal },
      );
      if (result.kind === "json") {
        convId = result.response.conversation_id;
        anchor = result.response.turn;
        setBaseline(anchor);
      } else {
        for await (const ev of result.events) {
          switch (ev.event) {
            case "task":
              convId = ev.data.conversation_id;
              setTaskId(ev.data.task_id);
              break;
            case "token":
              draft.append(ev.data.delta);
              break;
            case "done":
              anchor = ev.data.turn;
              setBaseline(anchor);
              break;
            case "error":
              setError(ev.data.message);
              break;
          }
        }
      }
      setStreaming(false);
      setTaskId(null);
      if (convId) onConversation(convId);
      // A cancelled or failed baseline has nothing to re-fire from.
      if (!anchor || !convId || selected.length === 0) return;
      const accepted = await api.replayTurn(tree, {
        conversation_id: convId,
        turn_id: anchor.id,
        endpoints: selected,
      });
      setRunId(accepted.run_id);
    } catch (e) {
      if (!abort.signal.aborted) {
        setError(e instanceof Error ? e.message : String(e));
      }
      setStreaming(false);
      setTaskId(null);
    }
  };

  const stop = () => {
    if (taskId) void api.cancelTask(taskId);
  };

  // The saved comparisons, from the one config artifact. Sets that cannot run
  // exactly as written are not offered — `issues` says which and why.
  const { sets: presets, issues: presetIssues } = useMemo(
    () => validateCompareSets(agenticConfig.compareSets),
    [],
  );
  // A preset names endpoints by id or name; resolution is per-tree, so a set
  // this tree does not deploy to is shown greyed rather than hidden — silently
  // dropping it looks like the config never had it.
  const presetOptions = useMemo(
    () =>
      setsForTree(presets, tree).map((set) => ({
        set,
        ...resolveCompareSet(set, endpoints),
      })),
    [presets, tree, endpoints],
  );

  const applyPreset = (id: string | null) => {
    setPresetId(id);
    const chosen = presetOptions.find((o) => o.set.id === id);
    if (chosen) setSelected(chosen.endpointIds);
  };

  const columnCount = 1 + selected.length;
  const cells = run?.rows[0]?.cells ?? [];
  const nameOf = (id: string) => endpoints.find((e) => e.id === id)?.name ?? id;
  const atCap = selected.length >= MAX_COMPARE_COLUMNS - 1;

  return (
    <>
      {presetOptions.length > 0 && (
        // Plan §3: "a team's usual A/B is one click and not a five-field form
        // each time" — the config supplies the presets, the picker below still
        // takes an ad-hoc selection.
        <Select
          size="xs"
          label="Saved comparison"
          placeholder="Pick a saved comparison"
          clearable
          value={presetId}
          onChange={applyPreset}
          data={presetOptions.map(({ set, unresolved }) => ({
            value: set.id,
            label:
              unresolved.length > 0
                ? `${set.label} — not deployed here: ${unresolved.join(", ")}`
                : set.label,
            disabled: unresolved.length > 0,
          }))}
          data-testid="compare-preset"
        />
      )}
      {presetIssues.length > 0 && (
        <Alert
          color="red"
          py={6}
          title="Unusable compare presets"
          data-testid="compare-preset-issues"
        >
          <Stack gap={2}>
            {presetIssues.map((issue) => (
              <Text size="xs" key={issue.id}>
                <b>{issue.id}</b> {issue.reason}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
      <MultiSelect
        size="xs"
        label="Compare against"
        placeholder={selected.length > 0 ? undefined : "Endpoints"}
        data={endpoints.map((e) => ({ value: e.id, label: e.name }))}
        value={selected}
        // A hand edit is no longer the preset — keep the label honest.
        onChange={(value) => {
          setSelected(value);
          setPresetId(null);
        }}
        // Column 0 is the baseline reply, so the cap leaves N-1 endpoints.
        maxValues={MAX_COMPARE_COLUMNS - 1}
        data-testid="compare-endpoints"
      />
      {atCap && (
        <Text size="xs" c="dimmed" data-testid="compare-cap-hint">
          {MAX_COMPARE_COLUMNS} columns is the readable maximum here —{" "}
          <Anchor size="xs" onClick={() => navigate("/evaluations")}>
            use Evaluations
          </Anchor>{" "}
          to compare more.
        </Text>
      )}
      {/* Plan §5.2: "Sending one message to three variants is three
          generations, three bills. Say so in the UI BEFORE the send." */}
      <Alert color="yellow" py={6} data-testid="compare-cost-warning">
        Compare sends this message to {columnCount} variants — {columnCount}{" "}
        generations, {columnCount} bills.
      </Alert>
      {error && (
        <Alert color="red" title="Compare failed">
          {error}
        </Alert>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        <Stack gap="sm" data-testid="compare-transcript">
          {prompt === null ? (
            <Text c="dimmed" ta="center" mt="xl">
              Send a message to compare {columnCount} variants side by side.
            </Text>
          ) : (
            <Paper p="sm" radius="md" bg="blue.0" data-testid="compare-prompt">
              <Markdown content={prompt} />
            </Paper>
          )}
          {prompt !== null && (
            <SimpleGrid cols={columnCount} spacing="xs" data-testid="compare-columns">
              <Column label="current" testId="compare-column-baseline">
                {baseline ? (
                  <Markdown content={baseline.content} />
                ) : (
                  <DraftText draft={draft} />
                )}
              </Column>
              {selected.map((id, i) => (
                <Column key={id} label={nameOf(id)} testId={`compare-column-${id}`}>
                  <FanOutCell
                    cell={cells[i + 1]}
                    started={runId !== null}
                    onOpen={(convId) => navigate(`/chat/${convId}`)}
                  />
                </Column>
              ))}
            </SimpleGrid>
          )}
          {runId && (
            // Plan §3: "the result IS a run: a 'See the comparison' link opens
            // the existing grid, and the judge works on it with no new code".
            <Group justify="flex-end">
              <Anchor
                size="xs"
                onClick={() => navigate(`/evaluations/${runId}`)}
                data-testid="compare-run-link"
              >
                See the comparison ↗
              </Anchor>
            </Group>
          )}
        </Stack>
      </div>
      {selected.length === 0 ? (
        <Text size="sm" c="dimmed" data-testid="compare-needs-variant">
          Pick at least one endpoint to compare against.
        </Text>
      ) : (
        <Composer
          streaming={streaming}
          canStop={taskId != null}
          onStop={stop}
          onSend={(text, attachments) => void send(text, attachments)}
          resetToken={0}
        />
      )}
    </>
  );
}

function Column({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Paper p="sm" radius="md" withBorder data-testid={testId}>
      <Badge size="xs" variant="light" mb={4}>
        {label}
      </Badge>
      {children}
    </Paper>
  );
}

// The baseline column's in-flight text. Subscribing HERE (not in the parent)
// keeps a token's cost to one column's re-render.
function DraftText({ draft }: { draft: DraftStore }) {
  const text = useSyncExternalStore(draft.subscribe, draft.get);
  return text === "" ? <Loader size="xs" type="dots" /> : <Markdown content={text} />;
}

function FanOutCell({
  cell,
  started,
  onOpen,
}: {
  cell: RunCell | undefined;
  started: boolean;
  onOpen: (conversationId: string) => void;
}) {
  if (!started || cell == null || cell.status === "pending" || cell.status === "running") {
    return (
      <Group gap={6} wrap="nowrap">
        <Loader size="xs" />
        <Text size="xs" c="dimmed">
          {started ? "generating…" : "waiting for the shared turn…"}
        </Text>
      </Group>
    );
  }
  if (cell.status === "failed") {
    return (
      <Text size="xs" c="red">
        {cell.error ?? "generation failed"}
      </Text>
    );
  }
  return (
    <>
      <Markdown content={cell.content ?? ""} />
      {cell.conversation_id && (
        <Group justify="flex-end" mt={4}>
          <Anchor size="xs" onClick={() => onOpen(cell.conversation_id!)}>
            Open in Chat ↗
          </Anchor>
        </Group>
      )}
    </>
  );
}
