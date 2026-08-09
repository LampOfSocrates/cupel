// Login-token store + central auth signals. The client always
// attaches a token when it has one and routes any 401 to the login screen;
// NO component branches on the auth mode (invariant, cupel-phases.md:160 —
// machine-checked by tests/no-authmode-branches.test.js;
// openapi.yaml:30-32 "Clients never branch on the mode: they always attach a
// token when they have one, and route any 401 to the login screen").
//
// Storage: one token PER BACKEND TARGET (cupel.auth.token.<targetId>) —
// logging into staging must not leak a JWT to prod. Device-local like the
// target choice itself (feature-spec.md:161); try/catch mirrors llmKey.ts
// (localStorage can throw in privacy mode — auth then simply has no stored
// token).
import { useSyncExternalStore } from "react";
import { getActiveTarget } from "./target";
import { getProdToken } from "./backendPrefs";

export const AUTH_TOKEN_PREFIX = "cupel.auth.token.";

const tokenKey = (targetId: string) => AUTH_TOKEN_PREFIX + targetId;

type Listener = () => void;
const tokenListeners = new Set<Listener>();
const notifyToken = () => {
  for (const listener of tokenListeners) listener();
};

export function getAuthToken(targetId: string = getActiveTarget().id): string | null {
  try {
    return localStorage.getItem(tokenKey(targetId));
  } catch {
    return null;
  }
}

export function setAuthToken(token: string, targetId: string = getActiveTarget().id): void {
  try {
    localStorage.setItem(tokenKey(targetId), token);
  } catch {
    // storage unavailable — the session lasts until reload only
  }
  notifyToken();
}

export function clearAuthToken(targetId: string = getActiveTarget().id): void {
  try {
    localStorage.removeItem(tokenKey(targetId));
  } catch {
    // storage unavailable — nothing to clear
  }
  notifyToken();
}

export function subscribeAuthToken(listener: Listener): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

/** React view of the ACTIVE target's login token — null when logged out.
 * Drives the boot refetch (App.tsx) and the Sign out affordance (Sidebar):
 * logout shows exactly when a token exists for the active target — an
 * off-mode backend issues no token on boot, so the dev user shows without
 * Sign out, with zero mode branching. */
export function useAuthToken(): string | null {
  return useSyncExternalStore(subscribeAuthToken, () => getAuthToken());
}

/**
 * Authorization header for every client call. Precedence (documented):
 * 1. the login JWT for the active target (POST /auth/token, this store);
 * 2. else, for targets declaring requiresToken (agentic.config.ts — prod),
 *    the static token from Settings → Backend (cupel.backend.prodToken,
 *    "Prod requires an auth token field", feature-spec.md:161).
 * The login JWT wins: an interactive session's identity beats the device's
 * standing credential.
 */
export function authHeaders(): Record<string, string> {
  const target = getActiveTarget();
  const token =
    getAuthToken(target.id) ?? (target.requiresToken ? getProdToken() || null : null);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ---------------------------------------------------------------------------
// auth-required event: the client emits on any 401 (after clearing the
// active target's token); the router-level listener in App.tsx navigates to
// /login?return_to=<current path> (feature-spec.md:18 "401 anywhere → back
// to login").
const authRequiredListeners = new Set<Listener>();

export function onAuthRequired(listener: Listener): () => void {
  authRequiredListeners.add(listener);
  return () => {
    authRequiredListeners.delete(listener);
  };
}

export function emitAuthRequired(): void {
  for (const listener of authRequiredListeners) listener();
}
