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
    // Item 40's split-stream shape: chat replies at ".../chat", chat's SSE
    // stream at its own ".../stream" — `opts` is buildUrl's third argument.
    remap: (path: string, opts?: { stream?: boolean }) =>
      `/nabu-service${opts?.stream ? path.replace(/\/chat$/, "/stream") : path}`,
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

// A backend that splits streaming into its own route (item 40) branches on
// buildUrl's third argument — every OTHER call site omits it, so remap must
// see plain `undefined` there rather than crash on a missing param.
describe("buildUrl passes per-request context to remap", () => {
  it("routes a streaming chat call to the backend's own /stream path", () => {
    expect(buildUrl("/agenttrees/agent1/chat", undefined, { stream: true })).toBe(
      "http://localhost:9999/nabu-service/agenttrees/agent1/stream",
    );
  });

  it("leaves a non-streaming chat call (or any other path) alone", () => {
    expect(buildUrl("/agenttrees/agent1/chat", undefined, { stream: false })).toBe(
      "http://localhost:9999/nabu-service/agenttrees/agent1/chat",
    );
    expect(buildUrl("/agenttrees/agent1/chat")).toBe(
      "http://localhost:9999/nabu-service/agenttrees/agent1/chat",
    );
  });
});
