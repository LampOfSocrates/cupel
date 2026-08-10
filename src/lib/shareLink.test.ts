import { describe, expect, it } from "vitest";
import { conversationShareUrl, sharePathPrefix, TURN_PARAM, turnShareUrl } from "./shareLink";

// Share links are the app's own routes made absolute against the
// CURRENT origin (no configured share host, nothing to keep in sync) and add
// nothing to the contract. jsdom serves these tests from http://localhost:3000.

describe("shareLink", () => {
  it("a conversation link is an absolute URL to /chat/{id} on the current origin", () => {
    const url = conversationShareUrl("c1");
    expect(url).toBe(`${window.location.origin}/chat/c1`);
    expect(url).toMatch(/^https?:\/\//);
  });

  it("a turn link is the conversation link plus ?turn={turnId}", () => {
    expect(turnShareUrl("c1", "t2")).toBe(`${window.location.origin}/chat/c1?turn=t2`);
    expect(TURN_PARAM).toBe("turn");
    // Round-trips through the same parser ChatPage reads it with.
    const parsed = new URL(turnShareUrl("c1", "t2"));
    expect(parsed.pathname).toBe("/chat/c1");
    expect(parsed.searchParams.get(TURN_PARAM)).toBe("t2");
  });

  it("escapes ids so a hostile id cannot forge extra path or query", () => {
    const url = new URL(turnShareUrl("c1/../evil", "t2&admin=1"));
    expect(url.pathname).toBe("/chat/c1%2F..%2Fevil");
    expect(url.searchParams.get(TURN_PARAM)).toBe("t2&admin=1");
    expect(url.searchParams.get("admin")).toBeNull();
  });

  // import.meta.env.PROD is statically replaced at `vite build` time — in
  // vitest it is always false, so the production branch (the demo mounted at
  // /cupel-demo, mock/root.py) is exercised via the injectable isProd param.
  it("carries the /cupel-demo prefix in production builds only", () => {
    expect(sharePathPrefix(false)).toBe("");
    expect(sharePathPrefix(true)).toBe("/cupel-demo");
  });
});
