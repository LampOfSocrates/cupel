import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  NativeSelect,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { api } from "../api/client";
import type { InstructionHistory, InstructionSave, Snapshot } from "../api/types";
import { useApp } from "../AppContext";
import { diffLines } from "../lib/diff";
import { relativeTime } from "../lib/relativeTime";

// Instruction editor (P1-T10b, sketch 06): "Edit an agent's instructions
// safely: every save is a new version, with diff view and rollback, never an
// overwrite" (skein-phases.md:17); "save = new version, never overwrite. Diff
// view + rollback" (feature-spec.md:33).
//
// Flow decisions (documented per task brief):
// - Rollback: "Restore this version" copies that version's content into the
//   draft (dirty), review via diff, then Save — which is exactly "Rollback =
//   PUT the old version's content (creates a new version)" (openapi.yaml:
//   249-250). No direct-PUT shortcut: one save path, diff-before-save.
// - Dirty state: an "unsaved changes" badge on the draft rail entry. No
//   confirm-on-navigate: react-router's useBlocker needs a data router and
//   App.tsx uses declarative <Routes> (App.tsx:96-109); the indicator is the
//   Phase-1 affordance.
// - Snapshot promotion: "Snapshot draft" POSTs {content, base_version}
//   (openapi.yaml:1219-1227) and remembers the last snapshot of the current
//   draft; if the draft is unchanged since that snapshot, Save sends its
//   snapshot_id so the server promotes it (openapi.yaml:245-249). Snapshots
//   are append-only (openapi.yaml:278) — listed for this session, no delete.
// - format select is metadata only: "Phase 1 treats both as plain text; YAML
//   schema validation is Phase 2" (openapi.yaml:1163-1164).
//
// P1-T20b — "Test in Runs" (sketch 06 "Test ▸"; annotated 06 tags it
// "POST …/refunds/snapshots"): "the draft text is snapshotted immutably into
// the run config (snapshot_id), so the tested text is exactly what ran even
// if editing continues" (feature-spec.md:86). The button ensures a snapshot
// of the CURRENT draft — reusing the last one if the draft is unchanged since
// it (same content-equality rule the promoting Save uses) — then hands off to
// the Runs stepper.
//
// Handoff = router state, not query params: the payload carries a display
// label ("v3-draft (a3f1)") that has no business in a URL, drafts are
// session-local so a deep link to this handoff is meaningless after reload,
// and react-router state costs no new persistence. Shape:
// navigate("/runs", { state: { testInRuns: { agent_id, snapshot_id,
// snapshot_label } } }) — consumed by RunsPage (see its prefill note).
//
// "Last tested: run …" breadcrumb in the editor: SKIPPED — the editor
// unmounts on the navigate, so surfacing the queued run back here would need
// new persistence (session storage / server state the contract doesn't have).
// The spec'd link-back lives on the Results side ("Back to editor" breadcrumb,
// feature-spec.md:88) — not this task's scope to invent storage for.

const DEL_STYLE = { background: "#FCEBEB", color: "#A32D2D" };
const ADD_STYLE = { background: "#EAF3DE", color: "#3B6D11" };

export function EditorPage() {
  const { tree } = useApp();
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [history, setHistory] = useState<InstructionHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [format, setFormat] = useState<"text" | "yaml">("text");
  const [mode, setMode] = useState<"edit" | "diff">("edit");
  // Diff selectors hold "draft" or a version number as string.
  const [diffFrom, setDiffFrom] = useState("draft");
  const [diffTo, setDiffTo] = useState("draft");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [lastSnapshot, setLastSnapshot] = useState<{
    id: string;
    content: string;
    label: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setHistory(null);
    setError(null);
    setSnapshots([]);
    setLastSnapshot(null);
    setMode("edit");
    api
      .instructions(tree, agentId)
      .then((h) => {
        if (cancelled) return;
        // Editor seeds from the LIVE version; v0 agents start empty
        // (openapi.yaml:215 "live_version 0 until v1 is saved").
        const live = h.versions.find((v) => v.version === h.live_version);
        setHistory(h);
        setDraft(live?.content ?? "");
        setSavedContent(live?.content ?? "");
        setFormat(h.format);
        // Default diff: draft vs live (task brief).
        setDiffFrom(live ? String(live.version) : "draft");
        setDiffTo("draft");
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [tree, agentId]);

  const dirty = history !== null && draft !== savedContent;
  const nextVersion = (history?.live_version ?? 0) + 1;

  const contentOf = (sel: string): string => {
    if (sel === "draft") return draft;
    return history?.versions.find((v) => v.version === Number(sel))?.content ?? "";
  };
  const diff = useMemo(
    () => (mode === "diff" ? diffLines(contentOf(diffFrom), contentOf(diffTo)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, diffFrom, diffTo, draft, history],
  );

  if (!agentId) return null;

  const save = async () => {
    if (!history) return;
    setBusy(true);
    try {
      const body: InstructionSave = { content: draft, format };
      // Unchanged since the last snapshot → this save promotes it
      // (openapi.yaml:245-249).
      if (lastSnapshot && lastSnapshot.content === draft) {
        body.snapshot_id = lastSnapshot.id;
      }
      const created = await api.saveInstructions(tree, agentId, body);
      setHistory({
        ...history,
        live_version: created.version,
        format: created.format,
        versions: [...history.versions, created], // append-only, ascending
      });
      setSavedContent(body.content);
      setFormat(created.format);
      setLastSnapshot(null);
      setDiffFrom(String(created.version));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Shared by "Snapshot draft" and "Test in Runs": POST the current draft as
  // an immutable snapshot and remember it for content-equality reuse.
  const createDraftSnapshot = async (): Promise<Snapshot> => {
    if (!history) throw new Error("no history loaded");
    const snap = await api.createSnapshot(tree, agentId, {
      content: draft,
      base_version: history.live_version,
    });
    setSnapshots((s) => [...s, snap]);
    setLastSnapshot({ id: snap.snapshot_id, content: draft, label: snap.label });
    return snap;
  };

  const snapshotDraft = async () => {
    if (!history) return;
    setBusy(true);
    try {
      await createDraftSnapshot();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // "Test in Runs snapshots your draft and replays your usual conversations
  // against it" (skein-phases.md:18). Snapshots are immutable, so an unchanged
  // draft REUSES the last one instead of POSTing a duplicate (same rule Save
  // uses for promotion); an edited draft gets a fresh snapshot.
  const testInRuns = async () => {
    if (!history) return;
    setBusy(true);
    try {
      const snap =
        lastSnapshot && lastSnapshot.content === draft
          ? { snapshot_id: lastSnapshot.id, label: lastSnapshot.label }
          : await createDraftSnapshot();
      navigate("/runs", {
        state: {
          testInRuns: {
            agent_id: agentId,
            snapshot_id: snap.snapshot_id,
            snapshot_label: snap.label,
          },
        },
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const restore = (version: number) => {
    setDraft(contentOf(String(version)));
    setMode("edit");
  };

  if (error) {
    return (
      <Stack gap="sm">
        <Title order={3}>Instruction editor — {agentId}</Title>
        <Alert color="red" title="Instruction editor error">
          {error}
        </Alert>
      </Stack>
    );
  }
  if (history === null) {
    return (
      <Stack gap="sm">
        <Title order={3}>Instruction editor — {agentId}</Title>
        <Loader size="sm" />
      </Stack>
    );
  }

  const versionsDesc = [...history.versions].reverse();
  const diffOptions = [
    { value: "draft", label: "draft" },
    ...versionsDesc.map((v) => ({
      value: String(v.version),
      label: `v${v.version}${v.version === history.live_version ? " (live)" : ""}`,
    })),
  ];

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Title order={3}>Instruction editor — {agentId}</Title>
        <SegmentedControl
          size="xs"
          value={mode}
          onChange={(v) => setMode(v as "edit" | "diff")}
          data={[
            { value: "edit", label: "Edit" },
            { value: "diff", label: "Diff" },
          ]}
        />
      </Group>
      <Group align="flex-start" gap="md" wrap="nowrap">
        {/* Version rail (sketch 06: "Versions" panel, draft on top, live badge) */}
        <Paper withBorder p="sm" w={230} style={{ flexShrink: 0 }}>
          <Stack gap="xs">
            <Text size="xs" c="dimmed">
              Versions
            </Text>
            <Group gap={6} data-testid="version-draft">
              <Badge size="sm" variant="light" color="blue">
                v{nextVersion} · draft
              </Badge>
              {dirty && (
                <Badge size="sm" variant="dot" color="orange">
                  unsaved changes
                </Badge>
              )}
            </Group>
            {versionsDesc.length === 0 && (
              <Text size="xs" c="dimmed">
                No versions yet — first save creates v1.
              </Text>
            )}
            {versionsDesc.map((v) => (
              <Group key={v.version} gap={6} justify="space-between" data-testid={`version-${v.version}`}>
                <Group gap={6}>
                  <Text size="sm">v{v.version}</Text>
                  {v.version === history.live_version && (
                    <Badge size="xs" variant="filled" color="violet">
                      live
                    </Badge>
                  )}
                  {v.promoted_from_snapshot_id && (
                    <Badge size="xs" variant="light" color="teal">
                      from snapshot {v.promoted_from_snapshot_id}
                    </Badge>
                  )}
                  <Text size="xs" c="dimmed">
                    {relativeTime(v.created_at)}
                  </Text>
                </Group>
                {/* ↩ rollback (sketch 06): restore into the draft, then Save
                    = "PUT the old version's content" (openapi.yaml:249-250). */}
                <UnstyledButton
                  aria-label={`Restore v${v.version}`}
                  onClick={() => restore(v.version)}
                  fz="xs"
                  c="dimmed"
                >
                  &#x21A9; restore
                </UnstyledButton>
              </Group>
            ))}
            <NativeSelect
              label="Format"
              size="xs"
              data={["text", "yaml"]}
              value={format}
              onChange={(e) => setFormat(e.currentTarget.value as "text" | "yaml")}
            />
            {snapshots.length > 0 && (
              <>
                <Text size="xs" c="dimmed">
                  Snapshots
                </Text>
                {snapshots.map((s) => (
                  <Text key={s.snapshot_id} size="xs" data-testid={`snapshot-${s.snapshot_id}`}>
                    {s.label}
                  </Text>
                ))}
              </>
            )}
          </Stack>
        </Paper>

        {/* Content area: editor or diff (sketch 06) */}
        <Stack gap="xs" style={{ flexGrow: 1, minWidth: 0 }}>
          {mode === "edit" ? (
            <Textarea
              aria-label="Instructions"
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              autosize
              minRows={14}
              styles={{ input: { fontFamily: "monospace" } }}
            />
          ) : (
            <Paper withBorder p="sm">
              <Group gap="xs" mb="xs">
                <NativeSelect
                  aria-label="Diff from"
                  size="xs"
                  data={diffOptions}
                  value={diffFrom}
                  onChange={(e) => setDiffFrom(e.currentTarget.value)}
                />
                <Text size="xs" c="dimmed">
                  →
                </Text>
                <NativeSelect
                  aria-label="Diff to"
                  size="xs"
                  data={diffOptions}
                  value={diffTo}
                  onChange={(e) => setDiffTo(e.currentTarget.value)}
                />
              </Group>
              <div style={{ fontFamily: "monospace", fontSize: 13, overflowX: "auto" }}>
                {diff.length === 0 && (
                  <Text size="xs" c="dimmed">
                    No differences.
                  </Text>
                )}
                {diff.map((d, i) => (
                  <div
                    key={i}
                    data-testid={`diff-${d.type}`}
                    style={d.type === "del" ? DEL_STYLE : d.type === "add" ? ADD_STYLE : undefined}
                  >
                    {d.type === "del" ? "- " : d.type === "add" ? "+ " : "  "}
                    {d.line}
                  </div>
                ))}
              </div>
            </Paper>
          )}
          <Group justify="space-between">
            <Text size="xs" c="dimmed">
              Saving never overwrites — creates v{nextVersion}
            </Text>
            <Group gap="xs">
              <Button size="xs" variant="default" onClick={() => void snapshotDraft()} disabled={busy}>
                Snapshot draft
              </Button>
              {/* sketch 06 "Test ▸" — snapshot the draft, hand off to Runs
                  (skein-phases.md:18 "editor → Runs flow (sketches 06 → 03)"). */}
              <Button size="xs" variant="light" onClick={() => void testInRuns()} disabled={busy}>
                Test in Runs ▸
              </Button>
              <Button size="xs" onClick={() => void save()} disabled={busy || !dirty}>
                Save as v{nextVersion}
              </Button>
            </Group>
          </Group>
        </Stack>
      </Group>
    </Stack>
  );
}
