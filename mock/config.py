import os
from pathlib import Path

VERSION = "0.2.0-mock"

MODELS = [
    {"id": "claude-sonnet-5", "name": "Claude Sonnet 5"},
    {"id": "claude-haiku-4-5", "name": "Claude Haiku 4.5"},
    {"id": "deepseek-v3", "name": "DeepSeek V3"},
    {"id": "gemini-flash", "name": "Gemini Flash"},
]

# Phase 1 has no /settings endpoint, so upload limits live in the config
# artifact and the server enforces them (openapi.yaml:533-536).
MAX_UPLOAD_BYTES = 5 * 1024 * 1024

# Bulk import: "Small files: 200 with the per-row report inline. Above
# the server's size threshold: 202 TaskRef" (openapi.yaml:1385-1389). The
# threshold is DATA ROWS, not bytes — it is row work that makes an import slow,
# and it makes the boundary testable without building multi-MB fixtures.
IMPORT_SYNC_MAX_ROWS = int(os.environ.get("MOCK_IMPORT_SYNC_MAX_ROWS", "200"))

TOKEN_DELAY = float(os.environ.get("MOCK_TOKEN_DELAY", "0.02"))
STEP_DELAY = float(os.environ.get("MOCK_STEP_DELAY", "0.08"))


def fail_marker() -> str:
    """FAILURE INJECTION for the e2e suite (cupel-phases.md:98 "failure/latency
    injection env vars"; feature-spec.md:199 "e2e runs with failure-injection ON
    at fixed seed, so retry-failed and error states are exercised
    reproducibly").

    MOCK_FAIL_MARKER names a string. The FIRST attempt at any batch child whose
    payload contains it fails; a retry of that same child succeeds. Marker-based
    and attempt-based rather than a percentage, because a percentage is only
    reproducible with an RNG the test cannot see — this way a spec chooses
    exactly which work fails by what it puts in the prompt, and can assert exact
    counts. Unset (the default, and every deployment) = completely inert.

    The Settings → "Random task failures (5%)" control stays greyed out: that is
    the generator control API, Phase 3.

    Read per call, not at import, so tests can flip it (mirrors live_disabled).
    """
    return os.environ.get("MOCK_FAIL_MARKER", "")

# --- Live-LLM BYOK mode (docs/deployment.md:17-31) ---------------
# "Mock stays the backend of record ...; only the generation call inside
# chat/replay/judge goes to a real provider when a key is present."
# Headers X-LLM-Key / X-LLM-Model are transport-level by design — deliberately
# OUTSIDE the openapi.yaml v0.2.0 contract (no /settings endpoint, Phase 2).


def live_disabled() -> bool:
    """MOCK_LIVE_DISABLED=1 kills the feature entirely (deployment defense).
    Read per-call, not at import, so deployments/tests can flip it."""
    return os.environ.get("MOCK_LIVE_DISABLED") == "1"


OPENROUTER_BASE = "https://openrouter.ai/api/v1"
LIVE_DEFAULT_MODEL = "deepseek/deepseek-chat"
# "Cost control: server-side max_tokens cap + simple rate limit so
# drip/replay can't burn the client's credit" (docs/deployment.md:29-30).
LIVE_MAX_TOKENS = 512
LIVE_RATE_LIMIT = 20  # generations per window per key hash
LIVE_RATE_WINDOW_S = 60.0

# "/models is populated from a curated cheap-model list in live mode"
# (docs/deployment.md:22-23) — OpenRouter model ids.
LIVE_MODELS = [
    {"id": "deepseek/deepseek-chat", "name": "DeepSeek Chat"},
    {"id": "google/gemini-flash-1.5", "name": "Gemini Flash 1.5"},
    {"id": "anthropic/claude-haiku-4.5", "name": "Claude Haiku 4.5"},
    {"id": "meta-llama/llama-3.1-8b-instruct", "name": "Llama 3.1 8B"},
    {"id": "mistralai/mistral-small", "name": "Mistral Small"},
]

DB_PATH = os.environ.get("CUPEL_MOCK_DB") or str(Path(__file__).with_name("cupel-mock.sqlite"))
