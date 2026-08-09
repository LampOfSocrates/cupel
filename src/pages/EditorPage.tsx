import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Alert, Loader, Stack, Title } from "@mantine/core";
import { api } from "../api/client";
import type { InstructionHistory } from "../api/types";
import { useApp } from "../AppContext";
import { InstructionEditor } from "./editor/InstructionEditor";

// Instruction editor (sketch 06): "Edit an agent's instructions
// safely: every save is a new version, with diff view and rollback, never an
// overwrite" (cupel-phases.md:17); "save = new version, never overwrite. Diff
// view + rollback" (feature-spec.md:33).
//
// This file is the LOADER half only: GET the history, show the loader/load
// error, and mount the body. Everything that touches the draft lives in
// ./editor/InstructionEditor, mounted under key={tree/agentId} — the identity
// of the loaded data, never its content. That key is the fix for #7: the
// editor's six form buffers are unsaved user input, so only a genuinely
// different agent or tree may reset them. A refetch of the same agent
// re-renders the body with a new `loaded` value that it deliberately ignores,
// which is why the Textarea does not need disabling while a save is in flight.
//
// Flow decisions:
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
// "Test in Runs" (sketch 06 "Test ▸"; annotated 06 tags it
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
// navigate("/evaluations", { state: { testInRuns: { agent_id, snapshot_id,
// snapshot_label } } }) — consumed by EvaluationsPage (see its prefill note).
//
// "Last tested: run …" breadcrumb in the editor: SKIPPED — the editor
// unmounts on the navigate, so surfacing the queued run back here would need
// new persistence (session storage / server state the contract doesn't have).
// The spec'd link-back lives on the Results side ("Back to editor" breadcrumb,
// feature-spec.md:88).

export function EditorPage() {
  const { tree } = useApp();
  const { agentId } = useParams();
  const [history, setHistory] = useState<InstructionHistory | null>(null);
  // Load errors only. A failed WRITE is the body's own inline alert — it must
  // never replace the page, because the page is where the draft is (#7).
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    setHistory(null);
    setError(null);
    api
      .instructions(tree, agentId)
      .then((h) => {
        if (!cancelled) setHistory(h);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [tree, agentId]);

  if (!agentId) return null;

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

  return (
    <InstructionEditor key={`${tree}/${agentId}`} tree={tree} agentId={agentId} loaded={history} />
  );
}
