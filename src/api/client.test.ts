import { describe, expect, it } from "vitest";
import { api, ApiError, buildUrl } from "./client";
import { BASE } from "./base";
import { conversationRequests } from "../test/msw/handlers";

describe("buildUrl", () => {
  it("prefixes BASE and appends query params", () => {
    expect(buildUrl("/agenttrees/agent1/conversations", { search: "billing", page: 2 })).toBe(
      `${BASE}/agenttrees/agent1/conversations?search=billing&page=2`,
    );
  });

  it("omits undefined and empty params", () => {
    expect(buildUrl("/me", { search: undefined, page: undefined })).toBe(`${BASE}/me`);
    expect(buildUrl("/me", { search: "" })).toBe(`${BASE}/me`);
  });
});

describe("api client", () => {
  it("GET /me returns the dev user", async () => {
    const me = await api.me();
    expect(me.user.id).toBe("dev");
    expect(me.permissions.agent1).toContain("view");
  });

  it("conversations() sends contract query params (openapi.yaml:350-378)", async () => {
    await api.conversations("agent1", { search: "ref", page: 3, forks_of: "c2" });
    const url = conversationRequests.at(-1)!;
    expect(url.pathname).toBe("/agenttrees/agent1/conversations");
    expect(url.searchParams.get("search")).toBe("ref");
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.get("forks_of")).toBe("c2");
  });

  it("non-2xx throws ApiError with the contract error shape {code, message}", async () => {
    const err = await api.conversation("agent1", "missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.code).toBe("not_found");
    expect(apiErr.message).toBe("conversation not found");
  });

  it("DELETE resolves on 204 with no body", async () => {
    await expect(api.deleteConversation("agent1", "c3")).resolves.toBeUndefined();
  });
});
