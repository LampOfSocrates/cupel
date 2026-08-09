// Live-LLM BYOK key store. Hard rules (docs/deployment.md:24-27):
// "Client pastes key in UI → browser localStorage only. Sent per request:
// X-LLM-Key + X-LLM-Model headers." localStorage is the SPECCED home for this
// key (deployment.md overrides the earlier no-persistence note, which applied
// to chat settings); it is never put in URLs and never logged.
const KEY_STORAGE = "cupel.byok.key";
const MODEL_STORAGE = "cupel.byok.model";

// try/catch: localStorage can throw (privacy mode, disabled storage) — BYOK
// then simply stays off.
export function getLlmKey(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

export function setLlmKey(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // storage unavailable — nothing to persist or clear
  }
}

export function getLlmModel(): string | null {
  try {
    return localStorage.getItem(MODEL_STORAGE);
  } catch {
    return null;
  }
}

export function setLlmModel(model: string | null): void {
  try {
    if (model) localStorage.setItem(MODEL_STORAGE, model);
    else localStorage.removeItem(MODEL_STORAGE);
  } catch {
    // storage unavailable
  }
}

// Headers for generation-adjacent calls when a key is set; empty otherwise.
export function llmHeaders(): Record<string, string> {
  const key = getLlmKey();
  if (!key) return {};
  const model = getLlmModel();
  return { "X-LLM-Key": key, ...(model ? { "X-LLM-Model": model } : {}) };
}
