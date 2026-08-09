// Return_to round-trip for the login redirect. Built for share
// deep links (/chat/{id}?turn=...): a 401 on a shared link must land on
// /login?return_to=<full path incl. query> and, after login, navigate back to
// exactly that path (TASKS.md:48 — sharing "works in both auth modes via
// T07's return_to redirect").

export const RETURN_TO_PARAM = "return_to";

/** The login path carrying the CURRENT location (path + query) as return_to. */
export function loginPath(location: { pathname: string; search: string }): string {
  const current = location.pathname + location.search;
  if (current === "/" || location.pathname === "/login") return "/login";
  return `/login?${RETURN_TO_PARAM}=${encodeURIComponent(current)}`;
}

/**
 * Validated navigation target after login. SAME-ORIGIN RELATIVE PATHS ONLY —
 * an attacker-supplied return_to must never leave the app:
 * - must start with a single "/" ("//evil.com" is protocol-relative, out);
 * - no backslashes (browsers normalize "\" to "/" in URLs);
 * - never /login itself (redirect loop).
 * Anything else falls back to "/".
 */
export function sanitizeReturnTo(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  if (raw === "/login" || raw.startsWith("/login?") || raw.startsWith("/login/")) return "/";
  return raw;
}
