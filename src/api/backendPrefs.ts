// P2-T17 — device-local Settings → Backend preferences (localStorage, the
// specced home for device-local state: feature-spec.md:161 "Target is
// device-local (not synced via /settings)"). try/catch mirrors llmKey.ts:
// localStorage can throw (privacy mode) — prefs then fall back to defaults.

// "Prod requires an auth token field" (feature-spec.md:161). Since P2-T07 the
// client attaches it as "Authorization: Bearer" on requiresToken targets —
// but only when no login JWT exists for the target (precedence documented in
// src/api/auth.ts authHeaders: the login JWT wins).
export const PROD_TOKEN_KEY = "cupel.backend.prodToken";

export function getProdToken(): string {
  try {
    return localStorage.getItem(PROD_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setProdToken(token: string): void {
  try {
    if (token) localStorage.setItem(PROD_TOKEN_KEY, token);
    else localStorage.removeItem(PROD_TOKEN_KEY);
  } catch {
    // storage unavailable — nothing to persist or clear
  }
}

// "SSE streaming on/off" (feature-spec.md:160) — the one mock option that is
// real today: ChatPage sends stream:<flag> and "the UI degrades gracefully to
// non-streaming when the SSE toggle is off in mock options"
// (cupel-phases.md:43). Default ON; only the off state is stored.
export const SSE_STORAGE_KEY = "cupel.backend.sse";

export function getSseEnabled(): boolean {
  try {
    return localStorage.getItem(SSE_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSseEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(SSE_STORAGE_KEY);
    else localStorage.setItem(SSE_STORAGE_KEY, "off");
  } catch {
    // storage unavailable — streaming stays on
  }
}
