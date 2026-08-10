import hashlib
import json
import re
import uuid
from datetime import datetime, timezone


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


# An inbound correlation id is HONOURED, not replaced (openapi.yaml Error
# .request_id): an adopter behind a gateway already stamped a trace id, and
# minting a second one here would make the id printed in the error body
# unjoinable to the logs a support ticket needs. It is untrusted input that
# ends up in log lines and in a response header, so it is admitted only if it
# is short and boring — anything else (control characters, CR/LF that would
# split a header, a 4 KB essay) is dropped and a fresh id generated instead.
SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._:/+=@-]{1,128}$")


def request_id(inbound: str | None) -> str:
    if inbound and SAFE_REQUEST_ID.match(inbound):
        return inbound
    return new_id("req")


def det_hash(*parts) -> int:
    h = hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()
    return int(h, 16)


def clamp_page(page: int, page_size: int, max_size: int) -> tuple[int, int]:
    """The one offset-paging clamp every collection route uses (openapi.yaml
    info.description, "Collections"). Out-of-range values are CLAMPED rather
    than rejected — a caller asking for page 0 wants the first page, and a
    422 there teaches nothing. page_size's ceiling is the operation's own
    declared maximum, so it is passed in rather than assumed."""
    return max(1, page), min(max(1, page_size), max_size)


def page_of(items: list, page: int, page_size: int, total: int) -> dict:
    """THE collection envelope — every `<Thing>Page` schema in the contract is
    this object with a different item type. `total` counts matches across ALL
    pages, which is what lets a client say "showing N of total"."""
    return {"items": items, "page": page, "page_size": page_size, "total": total}


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
