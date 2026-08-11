import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import {
  Alert,
  Badge,
  Button,
  Group,
  Menu,
  NativeSelect,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { api } from "../../api/client";
import type { InstructionHistory, InstructionSave, Snapshot } from "../../api/types";
import { diffLines } from "../../lib/diff";
import {
  exportFilename,
  serializeHistoryJson,
  serializeHistoryMarkdown,
  triggerDownload,
} from "../../lib/exportInstructions";
import { relativeTime } from "../../lib/relativeTime";
import { ApiErrorNote, errorMessage, errorTitle } from "../../components/ApiErrorNote";

// The editor body: everything downstream of a loaded InstructionHistory.
//
// It is split out of EditorPage for one reason — the draft is unsaved user
// input and the page is the thing that refetches. Mounted with
// key={tree/agentId}, this component's state can only ever be reset by a
// genuinely different agent or tree; a re-seed of the SAME instruction history
// (a refetch, a retry, a re-render of the loader) remounts nothing and so
// cannot touch text the user is still typing. `loaded` is therefore an
// INITIAL value only — it is read once, by the useState initialisers, and any
// later change to it is deliberately ignored.
//
// Write failures are inline and dismissible, never a screen swap: a save that
// 500s must leave the draft where it is (that was #7's data loss — the page's
// single `error` slot was shared by the load and the writes, and setting it
// unmounted the Textarea along with the only copy of the user's work).

const DEL_STYLE = { background: "#FCEBEB", color: "#A32D2D" };
const ADD_STYLE = { background: "#EAF3DE", color: "#3B6D11" };

export function InstructionEditor({
  tree,
  agentId,
  loaded,
}: {
  tree: string;
  agentId: string;
  loaded: InstructionHistory;
}) {
  const navigate = useNavigate();
  // Editor seeds from the LIVE version; v0 agents start empty
  // (openapi.yaml:215 "live_version 0 until v1 is saved").
  const live = loaded.versions.find((v) => v.version === loaded.live_version);
  const liveContent = live?.content ?? "";
  // Local, append-only copy of the history: save() pushes the created version
  // onto it rather than refetching (PUT returns the new version, openapi.yaml:262).
  const [history, setHistory] = useState<InstructionHistory>(loaded);
  const [draft, setDraft] = useState(liveContent);
  const [savedContent, setSavedContent] = useState(liveContent);
  const [format, setFormat] = useState<"text" | "yaml">(loaded.format);
  const [mode, setMode] = useState<"edit" | "diff">("edit");
  // Diff selectors hold "draft" or a version number as string. Default: draft
  // vs live.
  const [diffFrom, setDiffFrom] = useState(live ? String(live.version) : "draft");
  const [diffTo, setDiffTo] = useState("draft");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [lastSnapshot, setLastSnapshot] = useState<{
    id: string;
    content: string;
    label: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  // The thrown VALUE, not its message: a 403 from a tune operation carries a
  // request id and a permission sentence, and flattening it to a string threw
  // both away (openapi.yaml responses.Forbidden).
  const [writeError, setWriteError] = useState<unknown>(null);

  const dirty = draft !== savedContent;
  const nextVersion = history.live_version + 1;

  const contentOf = (sel: string): string => {
    if (sel === "draft") return draft;
    return history.versions.find((v) => v.version === Number(sel))?.content ?? "";
  };
  const diff = useMemo(
    () => (mode === "diff" ? diffLines(contentOf(diffFrom), contentOf(diffTo)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, diffFrom, diffTo, draft, history],
  );

  const save = async () => {
    setBusy(true);
    setWriteError(null);
    try {
      const body: InstructionSave = { content: draft, format };
      // Unchanged since the last snapshot → this save promotes it
      // (openapi.yaml:245-249).
      if (lastSnapshot && lastSnapshot.content === draft) {
        body.snapshot_id = lastSnapshot.id;
      }
      const created = await api.createInstructionVersion(tree, agentId, body);
      setHistory((h) => ({
        ...h,
        live_version: created.version,
        format: created.format,
        versions: [...h.versions, created], // append-only, ascending
      }));
      // savedContent is what LANDED, not what is in the box: if the user kept
      // typing during the PUT the draft stays dirty against the new version
      // instead of being silently marked saved. `format` is deliberately NOT
      // written back from the response — created.format only ever echoes what
      // was sent, so assigning it would revert a format the user picked while
      // the save was in flight.
      setSavedContent(body.content);
      setLastSnapshot(null);
      setDiffFrom(String(created.version));
    } catch (e) {
      setWriteError(e);
    } finally {
      setBusy(false);
    }
  };

  // Shared by "Snapshot draft" and "Test as evaluation": POST the current draft as
  // an immutable snapshot and remember it for content-equality reuse.
  const createDraftSnapshot = async (): Promise<Snapshot> => {
    // Snapshot the draft as it is at this instant — the same value the
    // content-equality reuse rule below is remembered against.
    const content = draft;
    const snap = await api.createSnapshot(tree, agentId, {
      content,
      base_version: history.live_version,
    });
    setSnapshots((s) => [...s, snap]);
    setLastSnapshot({ id: snap.snapshot_id, content, label: snap.label });
    return snap;
  };

  const snapshotDraft = async () => {
    setBusy(true);
    setWriteError(null);
    try {
      await createDraftSnapshot();
    } catch (e) {
      setWriteError(e);
    } finally {
      setBusy(false);
    }
  };

  // 'Test as evaluation' snapshots your draft and replays your usual
  // conversations against it. Snapshots are immutable, so an unchanged
  // draft REUSES the last one instead of POSTing a duplicate (same rule Save
  // uses for promotion); an edited draft gets a fresh snapshot.
  const testInRuns = async () => {
    setBusy(true);
    setWriteError(null);
    try {
      const snap =
        lastSnapshot && lastSnapshot.content === draft
          ? { snapshot_id: lastSnapshot.id, label: lastSnapshot.label }
          : await createDraftSnapshot();
      // Results tab (formerly the bare /evaluations route — UX polish
      // 2026-08-10, Studio merge); the handoff mechanism itself (location.
      // state read by EvaluationsPage, now embedded there) is unchanged.
      navigate("/studio?tab=results", {
        state: {
          testInRuns: {
            agent_id: agentId,
            snapshot_id: snap.snapshot_id,
            snapshot_label: snap.label,
          },
        },
      });
    } catch (e) {
      setWriteError(e);
    } finally {
      setBusy(false);
    }
  };

  const restore = (version: number) => {
    setDraft(contentOf(String(version)));
    setMode("edit");
  };

  // File export: serialize the already-fetched history
  // (no server round-trip, no contract change) and hand it to the browser.
  const download = (kind: "json" | "md") => {
    const text =
      kind === "json"
        ? serializeHistoryJson(history)
        : serializeHistoryMarkdown(history, agentId);
    triggerDownload(
      exportFilename(agentId, history.live_version, kind),
      text,
      kind === "json" ? "application/json" : "text/markdown",
    );
  };

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
            <Group justify="space-between">
              <Text size="xs" c="dimmed">
                Versions
              </Text>
              {/* Download the version history as a file. Disabled
                  on v0 agents — nothing to export yet (openapi.yaml:215). */}
              <Tooltip
                label="No versions yet — nothing to export"
                disabled={history.versions.length > 0}
              >
                <span>
                  <Menu position="bottom-end" withinPortal>
                    <Menu.Target>
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="gray"
                        disabled={history.versions.length === 0}
                      >
                        Download
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={() => download("json")}>JSON (.json)</Menu.Item>
                      <Menu.Item onClick={() => download("md")}>Markdown (.md)</Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                </span>
              </Tooltip>
            </Group>
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
              // The whole row is the click target, not just the trailing
              // "restore" label — a row click with no visible reaction
              // ("I click a different version, I don't see the text") was
              // the bug: only that small trailing text used to carry the
              // handler. ↩ rollback (sketch 06): restore into the draft,
              // then Save = "PUT the old version's content"
              // (openapi.yaml:249-250).
              <UnstyledButton
                key={v.version}
                aria-label={`Restore v${v.version}`}
                onClick={() => restore(v.version)}
                data-testid={`version-${v.version}`}
                style={{ display: "block", width: "100%" }}
              >
                <Group gap={6} justify="space-between" wrap="nowrap">
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
                  <Text size="xs" c="dimmed">
                    &#x21A9; restore
                  </Text>
                </Group>
              </UnstyledButton>
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
          {writeError != null && (
            <Alert
              color="red"
              title={errorTitle(writeError, "Instruction editor error")}
              withCloseButton
              onClose={() => setWriteError(null)}
              data-testid="editor-write-error"
            >
              {errorMessage(writeError)}
              <ApiErrorNote error={writeError} />
            </Alert>
          )}
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
              {/* Only the write BUTTONS go busy. The Textarea stays live on
                  purpose — a save is a network round-trip and locking the box
                  mid-sentence eats keystrokes; the keyed mount is what makes
                  that safe (nothing re-seeds the draft under the cursor). */}
              <Button size="xs" variant="default" onClick={() => void snapshotDraft()} disabled={busy}>
                Snapshot draft
              </Button>
              {/* sketch 06 "Test ▸" — snapshot the draft, hand off to Evaluations
                  (editor → Evaluations flow, sketches 06 → 03). */}
              <Button size="xs" variant="light" onClick={() => void testInRuns()} disabled={busy}>
                Test as evaluation
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
