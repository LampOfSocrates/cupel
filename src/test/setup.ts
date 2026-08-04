import { File as NodeFile } from "node:buffer";
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { cleanup } from "@testing-library/react";
import { server } from "./msw/server";
import { resetHandlerState } from "./msw/handlers";

// jsdom's File/FormData are incompatible with Node's fetch (which MSW
// intercepts): undici asserts multipart entries are ITS File class, and
// jsdom's FormData stringifies foreign Files. Replace both globals with
// fetch-realm classes so multipart POST /upload round-trips in ui tests:
// - File: node:buffer's File IS the internal undici File.
// - FormData: harvested from the fetch realm via Response#formData() (the
//   npm undici package is a different realm — its classes would not match).
globalThis.File = NodeFile as unknown as typeof globalThis.File;
const fetchRealmFormData = (
  await new Response(new URLSearchParams()).formData()
).constructor as typeof globalThis.FormData;
globalThis.FormData = fetchRealmFormData;

// Mantine needs these browser APIs that jsdom lacks.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = window.ResizeObserver ?? (ResizeObserverMock as unknown as typeof ResizeObserver);
window.HTMLElement.prototype.scrollIntoView =
  window.HTMLElement.prototype.scrollIntoView ?? (() => {});
// Mantine Textarea autosize listens on document.fonts (Autosize.mjs:132) —
// jsdom has no FontFaceSet.
if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
}

// Unhandled request = a call outside the single client / contract — fail loud.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetHandlerState();
});
afterAll(() => server.close());
