import { describe, expect, it, vi } from "vitest";

// Remap hook: "Connect backends whose routes are named
// differently (e.g. /nabu-service/…) via remap" (cupel-phases.md:75). The
// shipped config defines no remapped target, so the store is mocked to
// resolve one; buildUrl must apply remap BEFORE prefixing baseUrl.
// getTargetForPath is what the client asks (it routes mocked families
// elsewhere); with no `families` block it is the active target for every path.
vi.mock("./target", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./target")>();
  const nabu = {
    id: "nabu",
    label: "Nabu",
    baseUrl: "http://localhost:9999",
    remap: (path: string) => `/nabu-service${path}`,
  };
  return { ...mod, getActiveTarget: () => nabu, getTargetForPath: () => nabu };
});

import { buildUrl } from "./client";

describe("buildUrl through a remapped target", () => {
  it("applies the target's remap, then the baseUrl prefix", () => {
    expect(buildUrl("/me")).toBe("http://localhost:9999/nabu-service/me");
    expect(buildUrl("/agenttrees/agent1/chat")).toBe(
      "http://localhost:9999/nabu-service/agenttrees/agent1/chat",
    );
  });

  it("query params attach after remapping", () => {
    expect(buildUrl("/tasks", { page: 2 })).toBe(
      "http://localhost:9999/nabu-service/tasks?page=2",
    );
  });
});
