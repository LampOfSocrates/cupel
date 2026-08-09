import { describe, expect, it } from "vitest";
import type { InstructionHistory } from "../api/types";
import {
  exportFilename,
  serializeHistoryJson,
  serializeHistoryMarkdown,
} from "./exportInstructions";

// Serializers over InstructionHistory exactly as fetched
// (openapi.yaml:1194-1204): JSON must round-trip verbatim; markdown is the
// human-readable rendering of the same append-only history.

const fixture: InstructionHistory = {
  agent_id: "ag_concierge",
  format: "yaml",
  live_version: 2,
  versions: [
    {
      version: 1,
      content: "You are Concierge.\nBe brief.",
      format: "text",
      created_at: "2026-07-01T10:00:00Z",
      promoted_from_snapshot_id: null,
    },
    {
      version: 2,
      content: "name: concierge\ninstructions: Be polite.",
      format: "yaml",
      created_at: "2026-08-01T10:00:00Z",
      promoted_from_snapshot_id: "a3f1",
    },
  ],
};

describe("exportFilename", () => {
  it("builds {label}-instructions-v{live}.{ext}", () => {
    expect(exportFilename("ag_concierge", 2, "json")).toBe(
      "ag_concierge-instructions-v2.json",
    );
    expect(exportFilename("ag_concierge", 2, "md")).toBe("ag_concierge-instructions-v2.md");
  });
});

describe("serializeHistoryJson", () => {
  it("round-trips the fetched history exactly", () => {
    expect(JSON.parse(serializeHistoryJson(fixture))).toEqual(fixture);
  });
});

describe("serializeHistoryMarkdown", () => {
  const md = serializeHistoryMarkdown(fixture, "ag_concierge", new Date("2026-08-05T12:00:00Z"));

  it("opens with an H1 + Cupel export header carrying the date", () => {
    expect(md.startsWith("# ag_concierge — instruction history\n")).toBe(true);
    expect(md).toContain(
      "Cupel export — 2026-08-05 — live version v2 — format yaml",
    );
  });

  it("emits one section per version with created_at", () => {
    expect(md).toContain("## v1 — 2026-07-01T10:00:00Z");
    expect(md).toContain("## v2 — 2026-08-01T10:00:00Z");
  });

  it("notes promotion only on the promoted version", () => {
    expect(md).toContain("Promoted from snapshot a3f1.");
    expect(md.match(/Promoted from snapshot/g)).toHaveLength(1);
  });

  it("fences content — yaml language for yaml versions, plain otherwise", () => {
    expect(md).toContain("```\nYou are Concierge.\nBe brief.\n```");
    expect(md).toContain("```yaml\nname: concierge\ninstructions: Be polite.\n```");
  });
});
