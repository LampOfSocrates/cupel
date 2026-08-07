"""P2-T07 auth — both AUTH_MODEs (cupel-phases.md:76 "Turn auth on or off with
one env var: off = instant dev as a chosen user; on = real login, tokens, and
401 handling"; mock deliverable cupel-phases.md:98 "auth endpoints in both
AUTH_MODEs (seeded admin@demo/restricted@demo, real-shaped JWTs)").

AUTH_MODE env semantics (openapi.yaml:26-32): unset or anything but "on" =
off = today's behavior byte-for-byte — /me answers the dev user, nothing is
enforced. "on" = the AuthGate middleware (mock/main.py) requires a valid
bearer JWT on API paths and /me answers per token user.

JWT: real-shaped HS256 (header.payload.signature, base64url), claims
sub/email/roles/iat/exp (~12h). Hand-rolled on hashlib/hmac so the mock adds
no dependency; secret from env CUPEL_JWT_SECRET (dev default below) — read
per call so tests/deployments can flip it without reimport.

Seeded users (feature-spec.md:21 "on = seeded credentials (admin@demo /
restricted@demo) issuing real-shaped JWTs, so the auth-on path is testable
without a real IdP"): password "demo" for both; restricted has agent1
[view, evaluate] ONLY (no agent2) so permission filtering is exercisable.

Migration safety for pre-existing DBs: the users table is part of db.py's
CREATE TABLE IF NOT EXISTS schema (applied on every Db open), and
ensure_users() is INSERT OR IGNORE — called from seed.bootstrap() (fresh
DBs), unconditionally in create_app() (pre-existing DBs whose bootstrap
short-circuits on the stored seed label), and defensively on every
POST /auth/token (first auth-mode request). All three are idempotent.
"""

import base64
import hashlib
import hmac
import json
import os
import time

from .db import Db, j, unj
from .util import now_iso

DEFAULT_JWT_SECRET = "cupel-dev-jwt-secret"
TOKEN_TTL_S = 12 * 3600  # exp ~12h

# password "demo" for both (cupel-phases.md:98); stored as sha256 — mock-only
# hygiene, not real password storage.
SEED_USERS = [
    {
        "id": "u_admin", "email": "admin@demo", "name": "Admin",
        "password": "demo", "roles": ["admin", "inspect"],
        # Full permissions on both seeded trees (mock/seed.py TREES).
        "permissions": {"agent1": ["view", "tune", "evaluate"],
                        "agent2": ["view", "tune", "evaluate"]},
    },
    {
        "id": "u_restricted", "email": "restricted@demo", "name": "Restricted",
        "password": "demo", "roles": [],
        # agent1 view+evaluate only; NO agent2 — exercises tree filtering
        # (GET /agenttrees) and the 404-on-unpermitted rule (openapi.yaml:1948).
        "permissions": {"agent1": ["view", "evaluate"]},
    },
]


def auth_on() -> bool:
    """AUTH_MODE=on enables enforcement; unset/"off"/anything else = off.
    Read per request (like config.live_disabled) so tests can monkeypatch."""
    return os.environ.get("AUTH_MODE") == "on"


def jwt_secret() -> str:
    return os.environ.get("CUPEL_JWT_SECRET") or DEFAULT_JWT_SECRET


def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def verify_password(password: str, password_hash: str) -> bool:
    return hmac.compare_digest(hash_password(password), password_hash)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def encode_jwt(claims: dict) -> str:
    """HS256 header.payload.signature — real-shaped (openapi.yaml:2991)."""
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(json.dumps(claims).encode())
    signing_input = f"{header}.{payload}".encode()
    signature = _b64url(hmac.new(jwt_secret().encode(), signing_input,
                                 hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


def decode_jwt(token: str) -> dict | None:
    """Verified claims, or None for malformed/bad-signature/expired tokens —
    all collapse to 401 {"code":"unauthorized"} (openapi.yaml:1957-1962)."""
    parts = token.split(".")
    if len(parts) != 3:
        return None
    header, payload, signature = parts
    signing_input = f"{header}.{payload}".encode()
    expected = _b64url(hmac.new(jwt_secret().encode(), signing_input,
                                hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        claims = json.loads(_unb64url(payload))
    except (ValueError, json.JSONDecodeError):
        return None
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or exp <= time.time():
        return None
    return claims


def issue_token(user: dict, ttl_s: int = TOKEN_TTL_S) -> tuple[str, int]:
    """(jwt, expires_in) for a users-table row (AuthTokenResponse,
    openapi.yaml:2987-3006)."""
    now = int(time.time())
    claims = {"sub": user["id"], "email": user["email"],
              "roles": unj(user["roles"], []), "iat": now, "exp": now + ttl_s}
    return encode_jwt(claims), ttl_s


def me_payload(user: dict) -> dict:
    """Me schema (openapi.yaml:1993-2022) from a users-table row — the same
    shape POST /auth/token embeds and GET /me answers (auth-on)."""
    return {
        "user": {"id": user["id"], "name": user["name"], "email": user["email"]},
        "roles": unj(user["roles"], []),
        "permissions": unj(user["permissions"], {}),
    }


def ensure_users(db: Db) -> None:
    """Idempotent seed (INSERT OR IGNORE keyed on both id and unique email) —
    safe on every boot and on pre-existing DBs; never overwrites edits made
    via the future admin endpoints (P2-T07b)."""
    now = now_iso()
    for u in SEED_USERS:
        db.run(
            "INSERT OR IGNORE INTO users (id, email, name, password_hash, roles,"
            " permissions, invited, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
            (u["id"], u["email"], u["name"], hash_password(u["password"]),
             j(u["roles"]), j(u["permissions"]), now))


def find_user(db: Db, email: str) -> dict | None:
    return db.one("SELECT * FROM users WHERE email = ?", (email,))


def user_by_id(db: Db, user_id: str) -> dict | None:
    return db.one("SELECT * FROM users WHERE id = ?", (user_id,))
