// P1-TEXPORT — free-tier "download version history to file" (user decision
// 2026-08-05: file export instead of repo integration; P2-T20 repo/PR is
// pro-tier). Pure client-side serializers over InstructionHistory exactly as
// the editor already fetched it (GET .../instructions, openapi.yaml:221-239) —
// no contract change, no new endpoints.
import type { InstructionHistory } from "../api/types";

// {agentName-or-id}-instructions-v{live_version}.{ext}
export function exportFilename(
  agentLabel: string,
  liveVersion: number,
  ext: "json" | "md",
): string {
  return `${agentLabel}-instructions-v${liveVersion}.${ext}`;
}

// JSON export = the fetched InstructionHistory verbatim (agent_id, format,
// live_version, versions[]) — round-trips exactly.
export function serializeHistoryJson(history: InstructionHistory): string {
  return JSON.stringify(history, null, 2) + "\n";
}

// Markdown export: H1 + Cupel export header + date, then one section per
// version (versions are ascending, append-only — openapi.yaml:1203).
// yaml-fenced when the version's format is yaml, plain fence otherwise
// (format semantics: feature-spec.md:34).
export function serializeHistoryMarkdown(
  history: InstructionHistory,
  agentLabel: string,
  exportedAt: Date = new Date(),
): string {
  const lines: string[] = [
    `# ${agentLabel} — instruction history`,
    "",
    `Cupel export — ${exportedAt.toISOString().slice(0, 10)} — live version v${history.live_version} — format ${history.format}`,
  ];
  for (const v of history.versions) {
    lines.push("", `## v${v.version} — ${v.created_at}`);
    if (v.promoted_from_snapshot_id) {
      lines.push("", `Promoted from snapshot ${v.promoted_from_snapshot_id}.`);
    }
    lines.push("", "```" + (v.format === "yaml" ? "yaml" : ""), v.content, "```");
  }
  lines.push("");
  return lines.join("\n");
}

// DOM side kept apart from the pure serializers so they stay unit-testable.
export function triggerDownload(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
