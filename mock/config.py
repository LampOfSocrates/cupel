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

TOKEN_DELAY = float(os.environ.get("MOCK_TOKEN_DELAY", "0.02"))
STEP_DELAY = float(os.environ.get("MOCK_STEP_DELAY", "0.08"))

DB_PATH = os.environ.get("LOOM_MOCK_DB") or str(Path(__file__).with_name("loom-mock.sqlite"))
