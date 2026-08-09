import { describe, expect, it } from "vitest";
import { loginPath, sanitizeReturnTo } from "./returnTo";

// Return_to round-trip — built for share deep links
// (/chat/{id}?turn=...): 401 → /login?return_to=<full path incl. query>;
// after login navigate back, SAME-ORIGIN RELATIVE PATHS ONLY.

describe("loginPath", () => {
  it("carries pathname + query as an encoded return_to", () => {
    expect(loginPath({ pathname: "/chat/c1", search: "?turn=t2" })).toBe(
      "/login?return_to=%2Fchat%2Fc1%3Fturn%3Dt2",
    );
  });

  // A multi-param deep link must survive as ONE return_to value —
  // an unencoded "&" would split the second param off into the login URL.
  it("encodes the query so a second param cannot leak out of return_to", () => {
    const encoded = loginPath({ pathname: "/chat/c1", search: "?turn=t2&highlight=1" });
    expect(encoded).toBe("/login?return_to=%2Fchat%2Fc1%3Fturn%3Dt2%26highlight%3D1");
    const parsed = new URLSearchParams(encoded.slice("/login?".length));
    expect(parsed.get("return_to")).toBe("/chat/c1?turn=t2&highlight=1");
    expect(parsed.get("highlight")).toBeNull();
    expect(sanitizeReturnTo(parsed.get("return_to"))).toBe("/chat/c1?turn=t2&highlight=1");
  });

  it("root and /login itself get a bare /login (no pointless return_to)", () => {
    expect(loginPath({ pathname: "/", search: "" })).toBe("/login");
    expect(loginPath({ pathname: "/login", search: "?return_to=%2Fchat" })).toBe("/login");
  });
});

describe("sanitizeReturnTo — same-origin relative paths only", () => {
  it("passes app-relative paths through, query intact (?turn= deep link)", () => {
    expect(sanitizeReturnTo("/chat/c1?turn=t2")).toBe("/chat/c1?turn=t2");
    expect(sanitizeReturnTo("/runs/run_1")).toBe("/runs/run_1");
  });

  it.each([
    [null, "missing"],
    ["", "empty"],
    ["http://evil.example", "absolute URL"],
    ["https://evil.example/chat", "absolute URL"],
    ["//evil.example/chat", "protocol-relative"],
    ["/\\evil.example", "backslash smuggling"],
    ["chat/c1", "not rooted"],
    ["javascript:alert(1)", "scheme"],
    ["/login", "login loop"],
    ["/login?return_to=%2F", "login loop with query"],
  ])("rejects %s (%s) → /", (raw, _why) => {
    expect(sanitizeReturnTo(raw)).toBe("/");
  });
});
