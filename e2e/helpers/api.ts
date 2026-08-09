import { expect, test as base, type Page, type Request } from "@playwright/test";

// Request interception that asserts the ENDPOINT TAGS from the
// sketches. feature-spec.md:205: "one spec file per numbered dev prompt; each
// asserts against the endpoint tags in the sketches" — i.e. a journey must be
// shown to CALL the documented endpoints, not merely to look right.
//
// Patterns are written exactly as the sketches and the UI×API grid
// (feature-spec.md:222-250) write them:
//
//     POST /agenttrees/{tree}/replay
//     GET  /spans/{id}/payload
//
// Every {placeholder} matches one path segment. Nothing else is magic — no
// framework, one file.

/** The mock's origin: agentic.config.ts target `mock`, which every e2e run
 * boots (playwright.config.ts webServer). Calls to vite (:5173) are page
 * assets, not API, and are ignored. */
export const API_ORIGIN = "http://localhost:4010";

export interface ApiCall {
  method: string;
  /** Path only — query strings are kept separately so patterns stay short. */
  path: string;
  query: string;
}

function toMatcher(pattern: string): (call: ApiCall) => boolean {
  const [method, path] = pattern.trim().split(/\s+/);
  if (!method || !path) throw new Error(`bad endpoint pattern: ${pattern}`);
  const source = path
    .split("/")
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  const re = new RegExp(`^${source}$`);
  return (call) => call.method === method.toUpperCase() && re.test(call.path);
}

export class ApiRecorder {
  readonly calls: ApiCall[] = [];

  constructor(page: Page) {
    page.on("request", (request: Request) => {
      const url = new URL(request.url());
      if (url.origin !== API_ORIGIN) return;
      this.calls.push({
        method: request.method(),
        path: url.pathname,
        query: url.search,
      });
    });
  }

  /** Every recorded call matching an endpoint tag, newest last. */
  matching(pattern: string): ApiCall[] {
    return this.calls.filter(toMatcher(pattern));
  }

  /** Forget everything so far — lets one spec assert per journey step. */
  clear(): void {
    this.calls.length = 0;
  }

  /** Assert the journey hit this endpoint tag. Polls, because a call may be
   * in flight (SSE, background refresh) when the UI outcome is already
   * visible; the failure message lists what WAS called instead. */
  async expectCalled(pattern: string, count?: number): Promise<void> {
    await expect
      .poll(() => this.matching(pattern).length, {
        message: `expected ${pattern}\nrecorded:\n  ${this.summary()}`,
      })
      .toBeGreaterThanOrEqual(count ?? 1);
  }

  /** Assert the journey did NOT hit this endpoint tag (checked immediately —
   * use after the awaited outcome that would have triggered it). */
  expectNotCalled(pattern: string): void {
    expect(
      this.matching(pattern),
      `expected NO ${pattern}\nrecorded:\n  ${this.summary()}`,
    ).toHaveLength(0);
  }

  /** The most recent call for a tag — for asserting query params (?search=…). */
  last(pattern: string): ApiCall | undefined {
    return this.matching(pattern).at(-1);
  }

  private summary(): string {
    const seen = new Set(this.calls.map((c) => `${c.method} ${c.path}`));
    return [...seen].join("\n  ") || "(none)";
  }
}

/** `test` with an `api` recorder attached to the page from the first byte —
 * created before any navigation so boot calls (/me, /agenttrees) are caught. */
export const test = base.extend<{ api: ApiRecorder }>({
  api: async ({ page }, use) => {
    await use(new ApiRecorder(page));
  },
});

export { expect } from "@playwright/test";
