import hashlib
import json
import re
import uuid
from datetime import datetime, timezone


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def det_hash(*parts) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(h, 16)


def stamp_envelope() -> dict:
    """Server stamps every new turn at generation/receipt (openapi.yaml:1319-1325)."""
    return {
        "system_date": datetime.now(timezone.utc).date().isoformat(),
        "timezone": "Europe/London",
        "region": "GB",
        "locale": "en-GB",
        "user_profile_ref": None,
    }


def canned_title(message: str) -> str:
    title = " ".join(message.split())
    return title[:48] if title else "New conversation"


_OPENERS = [
    "Here's what I found.",
    "Happy to help with that.",
    "Let me break this down.",
    "Good question — short answer first, then detail.",
]

_POINTS = [
    "the key constraint is the **context envelope**, which is captured at generation",
    "replays run *frozen* by default, so results stay comparable",
    "each step is traced, so you can inspect tokens and cost per span",
    "forked conversations keep their lineage back to the parent turn",
    "judgments are append-only — re-scoring never overwrites history",
    "batch work fans out into child tasks with live progress",
]

_CLOSERS = [
    "Want me to go deeper on any of these?",
    "Let me know if you'd like a worked example.",
    "I can re-check this against a different configuration if useful.",
]


def canned_reply(prompt: str, agent: str, model: str | None = None, salt: str = "") -> str:
    h = det_hash(prompt, agent, model or "", salt)
    p1, p2 = _POINTS[h % len(_POINTS)], _POINTS[(h // 7) % len(_POINTS)]
    quoted = " ".join(prompt.split())[:80]
    lines = [
        _OPENERS[h % len(_OPENERS)],
        "",
        f'Regarding "{quoted}" — from **{agent}**' + (f" (via `{model}`)" if model else "") + ":",
        "",
        f"- First, {p1}.",
        f"- Second, {p2}.",
        f"- Reference `{format(h % 0xFFFF, '04x')}` covers the edge cases.",
        "",
        _CLOSERS[(h // 13) % len(_CLOSERS)],
    ]
    return "\n".join(lines)


def tokenize(text: str) -> list[str]:
    return re.findall(r"\S+\s*|\n", text)


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"
