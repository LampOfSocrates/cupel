"""OpenRouter client for Live-LLM BYOK mode (docs/deployment.md:17-31).

Key handling hard rules (docs/deployment.md:24-27): the key arrives per request
in the X-LLM-Key header and lives ONLY in function arguments on the caller's
stack — never stored on app/state/db, NEVER persisted, NEVER logged. Error
messages built here carry status codes / exception class names only, never
header values, so they are safe to persist in span notes.

Cost control (docs/deployment.md:29-30): max_tokens is capped server-side
(config.LIVE_MAX_TOKENS) and a simple in-memory sliding window per key hash
limits generations; over-limit raises LiveUnavailable so callers serve canned
content (flows stay alive — no 429 to the client).
"""

import hashlib
import json
import time
from collections import deque

import httpx

from . import config

# Tests inject httpx.MockTransport here — NEVER call the real OpenRouter in
# tests. None = httpx default transport (real network) at runtime.
TRANSPORT: httpx.AsyncBaseTransport | None = None


class LiveUnavailable(Exception):
    """Provider error (401/429/timeout/...) or local rate limit. Callers fall
    back to canned content and append str(exc) as a span note; the message
    must therefore never contain the key."""


# ------------------------------------------------------------- rate limiting
# Sliding window keyed by a hash of the key (the raw key is never stored).
_windows: dict[str, deque] = {}


def _key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:16]


def check_rate_limit(key: str) -> None:
    now = time.monotonic()
    window = _windows.setdefault(_key_hash(key), deque())
    while window and now - window[0] > config.LIVE_RATE_WINDOW_S:
        window.popleft()
    if len(window) >= config.LIVE_RATE_LIMIT:
        raise LiveUnavailable("rate_limited")
    window.append(now)


def reset_rate_limit() -> None:
    _windows.clear()


# ------------------------------------------------------------------ requests
def _payload(model: str | None, prompt: str, system_prompt: str | None,
             temperature: float | None, stream: bool) -> dict:
    messages = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})
    payload = {
        "model": model or config.LIVE_DEFAULT_MODEL,
        "messages": messages,
        "max_tokens": config.LIVE_MAX_TOKENS,  # server-side cap, always
        "stream": stream,
    }
    if temperature is not None:
        payload["temperature"] = temperature
    return payload


def _client(key: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=config.OPENROUTER_BASE,
        headers={"Authorization": f"Bearer {key}"},
        timeout=60.0,
        transport=TRANSPORT,
    )


async def complete(key: str, model: str | None, prompt: str, *,
                   system_prompt: str | None = None,
                   temperature: float | None = None) -> str:
    """One non-streaming chat completion. Raises LiveUnavailable on any
    provider problem — callers fall back to canned content."""
    check_rate_limit(key)
    try:
        async with _client(key) as client:
            r = await client.post(
                "/chat/completions",
                json=_payload(model, prompt, system_prompt, temperature, False))
            if r.status_code != 200:
                raise LiveUnavailable(f"provider_status_{r.status_code}")
            content = r.json()["choices"][0]["message"]["content"]
            return content or ""
    except LiveUnavailable:
        raise
    except Exception as exc:  # timeouts, bad JSON, transport errors, ...
        # Class name only — never the exception body (could echo headers).
        raise LiveUnavailable(type(exc).__name__) from None


async def stream(key: str, model: str | None, prompt: str, *,
                 system_prompt: str | None = None,
                 temperature: float | None = None):
    """Yield content deltas from an OpenRouter SSE chat-completions stream.
    Raises LiveUnavailable (possibly mid-stream) on provider problems."""
    check_rate_limit(key)
    try:
        async with _client(key) as client:
            async with client.stream(
                "POST", "/chat/completions",
                json=_payload(model, prompt, system_prompt, temperature, True),
            ) as r:
                if r.status_code != 200:
                    raise LiveUnavailable(f"provider_status_{r.status_code}")
                async for line in r.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        return
                    try:
                        delta = json.loads(data)["choices"][0]["delta"].get("content")
                    except (ValueError, KeyError, IndexError, TypeError):
                        continue  # comment/keepalive/shape drift — skip
                    if delta:
                        yield delta
    except LiveUnavailable:
        raise
    except Exception as exc:
        raise LiveUnavailable(type(exc).__name__) from None
