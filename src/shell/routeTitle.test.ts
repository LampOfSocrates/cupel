import { describe, expect, it } from "vitest";
import { product } from "../lib/product";
import { routeTitle } from "./routeTitle";

describe("routeTitle — the top bar's fallback name for a route", () => {
  it("names each door", () => {
    expect(routeTitle("/chat").title).toBe("Chat");
    expect(routeTitle("/agents").title).toBe("Agents");
    expect(routeTitle("/queue").title).toBe("Work");
    expect(routeTitle("/settings").title).toBe("Settings");
  });

  it("matches on a path segment, not a string prefix", () => {
    // "/chatter" is not under "/chat"; matching it there would name an
    // unrelated page after this one.
    expect(routeTitle("/chatter").title).toBe(product.label);
    expect(routeTitle("/chat/conv_123").title).toBe("Chat");
  });

  it("prefers the deeper route over its parent", () => {
    expect(routeTitle("/studio").title).toBe("Studio");
    expect(routeTitle("/studio/cases").title).toBe("Cases");
    expect(routeTitle("/studio/evaluations").title).toBe("Evaluations");
    // The stepper and a single evaluation are both the Evaluations tab.
    expect(routeTitle("/studio/evaluations/new").title).toBe("Evaluations");
    expect(routeTitle("/studio/evaluations/eval_9").title).toBe("Evaluations");
  });

  it("falls back to the product's own name for an unknown path", () => {
    // A redirect mid-flight, or a path about to bounce — better the product's
    // name than a guess at what the URL meant.
    expect(routeTitle("/nowhere")).toEqual({ title: product.label });
  });

  it("gives chat no subtitle — the thread's own title lands there instead", () => {
    expect(routeTitle("/chat").subtitle).toBeUndefined();
    expect(routeTitle("/queue").subtitle).toBeTruthy();
  });
});
