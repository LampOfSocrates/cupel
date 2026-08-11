import { beforeEach, describe, expect, it, vi } from "vitest";
import { agenticConfig as shipped } from "../../agentic.config";

// Per-family routing: with `families` answered, one app talks to TWO backends
// at once — the adopter's for `mine`, the bundled mock for `mock`. The shipped
// config answers nothing (everything `mine`), so the split is exercised
// against a config stubbed to look like a generated one.
//
// The modules under test read that config when they LOAD, and the setup file
// has already pulled them in through the MSW handlers — so the stub only takes
// effect on a fresh module graph (vi.resetModules + dynamic import below).
vi.mock("../../agentic.config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../agentic.config")>();
  return {
    ...mod,
    agenticConfig: {
      ...mod.agenticConfig,
      families: {
        chat: "mine",
        conversations: "mock",
        datasets: "hide",
        // not a family of this contract, and not an answer — both ignored,
        // both warned about (assertions below).
        casebooks: "mock",
        trace: "sometimes",
      },
      mockTarget: "mock",
    },
  };
});

const url = (id: string) => shipped.targets.find((t) => t.id === id)!.baseUrl;
const MINE = url("local");
const MOCK = url("mock");

async function load() {
  vi.resetModules();
  const [{ buildUrl }, { setActiveTarget, TARGET_STORAGE_KEY }, families] = await Promise.all([
    import("./client"),
    import("./target"),
    import("../lib/families"),
  ]);
  localStorage.removeItem(TARGET_STORAGE_KEY);
  setActiveTarget("local"); // the adopter's own backend
  return { buildUrl, setActiveTarget, ...families };
}

describe("buildUrl splits by family answer", () => {
  let app: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    app = await load();
  });

  it("sends a `mine` family to the active target", () => {
    expect(app.buildUrl("/agenttrees/agent1/chat")).toBe(`${MINE}/agenttrees/agent1/chat`);
  });

  it("sends a `mock` family to the bundled mock, whatever the active target is", () => {
    expect(app.buildUrl("/agenttrees/agent1/conversations")).toBe(
      `${MOCK}/agenttrees/agent1/conversations`,
    );
    expect(app.buildUrl("/agenttrees/agent1/conversations/c_1/turns", { page: 2 })).toBe(
      `${MOCK}/agenttrees/agent1/conversations/c_1/turns?page=2`,
    );
  });

  // The default is that the backend serves it: an unanswered family and a path
  // outside the contract both go to the active target rather than nowhere.
  it("sends unanswered families and unknown paths to the active target", () => {
    expect(app.buildUrl("/me")).toBe(`${MINE}/me`);
    expect(app.buildUrl("/not/a/contract/path")).toBe(`${MINE}/not/a/contract/path`);
  });

  it("follows the active target when it changes", () => {
    app.setActiveTarget("staging");
    expect(app.buildUrl("/agenttrees/agent1/chat")).toBe(
      `${url("staging")}/agenttrees/agent1/chat`,
    );
    expect(app.buildUrl("/agenttrees/agent1/conversations")).toBe(
      `${MOCK}/agenttrees/agent1/conversations`,
    );
  });
});

describe("answers", () => {
  it("reads mine/mock/hide back per family", async () => {
    const { familyAnswer, isHidden, mockedFamilies } = await load();
    expect(familyAnswer("chat")).toBe("mine");
    expect(familyAnswer("conversations")).toBe("mock");
    expect(isHidden("datasets")).toBe(true);
    expect(mockedFamilies()).toEqual(["conversations"]);
  });

  it("ignores a key the contract does not declare, and a value that is not an answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { familyAnswer, mockedFamilies } = await load();
    expect(familyAnswer("trace")).toBe("mine"); // "sometimes" dropped
    expect(mockedFamilies()).not.toContain("casebooks");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/casebooks.*|.*sometimes/);
    warn.mockRestore();
  });
});
