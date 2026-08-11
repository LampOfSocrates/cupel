import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Invariant guard, machine-checked — "no component branches on
// AUTH_MODE" (CLAUDE.md invariants). The frontend never
// knows which mode the backend runs: it always attaches a token when it has
// one and routes any 401 to the login screen (openapi.yaml:30-32). The
// literal "AUTH_MODE" is therefore banned from EVERYTHING under src/ — code,
// comments, tests, fixtures — so a branch can't even be written about.
// The env var itself lives server-side (mock/auth.py) and in the e2e rig.

const BANNED = "AUTH_MODE";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

describe("no AUTH_MODE branches in the frontend (invariant)", () => {
  it(`no file under src/ contains "${BANNED}"`, () => {
    const offenders = walk("src").filter((file) =>
      readFileSync(file, "utf8").includes(BANNED),
    );
    expect(offenders).toEqual([]);
  });

  it("the mock does read it (sanity: the grep works where the mode lives)", () => {
    expect(readFileSync("mock/auth.py", "utf8")).toContain(BANNED);
  });
});
