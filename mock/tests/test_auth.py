"""P2-T07 auth tests — both AUTH_MODEs (skein-phases.md:76, :98; openapi.yaml
:21-36 AUTH_MODE semantics). Run: npm run test:mock.

Off-mode (AUTH_MODE unset — the deployed demo's configuration) must behave
exactly as before P2-T07: /me answers the dev user, nothing enforced. On-mode:
seeded admin@demo / restricted@demo (password "demo"), real-shaped HS256 JWTs,
401s, permission filtering, DemoTokenGate stacking.
"""

import asyncio
import base64
import json
import sqlite3
import time

import httpx
import pytest

from mock import auth
from mock.main import create_app


def make_client(db_path=":memory:", **kwargs):
    app = create_app(db_path=db_path, token_delay=0, step_delay=0,
                     static_dir="__no_dist__")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t", **kwargs)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.delenv("AUTH_MODE", raising=False)
    monkeypatch.delenv("DEMO_TOKEN", raising=False)
    monkeypatch.delenv("SKEIN_JWT_SECRET", raising=False)


async def login(c, email="admin@demo", password="demo"):
    r = await c.post("/auth/token", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


# ----------------------------------------------------------- off mode (demo)
def test_off_mode_me_is_dev_user_unchanged():
    async def case():
        async with make_client() as c:
            r = await c.get("/me")
            assert r.status_code == 200
            assert r.json() == {
                "user": {"id": "dev", "name": "Dev User", "email": "dev@skein.local"},
                "permissions": {"agent1": ["view", "tune", "evaluate"],
                                "agent2": ["view", "tune", "evaluate"]},
            }
    run(case())


def test_off_mode_phase1_flow_needs_no_token():
    """Representative Phase-1 flow with no token: chat (stream:false) creates
    a conversation, task completes, listing shows it — nothing enforced."""
    async def case():
        async with make_client() as c:
            r = await c.post("/agenttrees/agent1/chat",
                             json={"message": "off-mode chat", "stream": False})
            assert r.status_code == 200
            conv_id = r.json()["conversation_id"]
            r = await c.get("/agenttrees/agent1/conversations")
            assert r.status_code == 200
            assert any(item["id"] == conv_id for item in r.json()["items"])
            assert (await c.get("/agenttrees")).status_code == 200
            assert (await c.post("/auth/logout")).status_code == 204
    run(case())


def test_off_mode_auth_token_still_answers():
    """openapi.yaml:109-111 — "With AUTH_MODE=off the endpoint still answers
    ... so the login flow stays testable"."""
    async def case():
        async with make_client() as c:
            body = await login(c)
            assert body["token_type"] == "bearer"
            assert body["me"]["user"]["email"] == "admin@demo"
    run(case())


# ---------------------------------------------------------- token issue/shape
def test_token_shape_claims_and_expiry(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            body = await login(c)
            token = body["access_token"]
            # Real-shaped JWT: header.payload.signature (openapi.yaml:2991).
            head, payload, sig = token.split(".")
            header = json.loads(base64.urlsafe_b64decode(head + "=="))
            assert header == {"alg": "HS256", "typ": "JWT"}
            claims = json.loads(base64.urlsafe_b64decode(payload + "=="))
            assert claims["sub"] == "u_admin"
            assert claims["email"] == "admin@demo"
            assert claims["roles"] == ["admin", "inspect"]
            # exp ~12h from now.
            assert abs(claims["exp"] - (time.time() + 12 * 3600)) < 60
            assert body["expires_in"] == 12 * 3600
            # Me embedded (same shape as GET /me, openapi.yaml:120).
            assert body["me"]["roles"] == ["admin", "inspect"]
            assert body["me"]["permissions"]["agent2"] == ["view", "tune", "evaluate"]
    run(case())


def test_bad_credentials_401(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            r = await c.post("/auth/token",
                             json={"email": "admin@demo", "password": "wrong"})
            assert r.status_code == 401
            assert r.json()["code"] == "invalid_credentials"
            r = await c.post("/auth/token",
                             json={"email": "nobody@demo", "password": "demo"})
            assert r.status_code == 401
            assert r.json()["code"] == "invalid_credentials"
    run(case())


# ------------------------------------------------------------- enforcement
def test_on_mode_401_without_token(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            for path in ("/me", "/agenttrees", "/models", "/tasks",
                         "/agenttrees/agent1/conversations"):
                r = await c.get(path)
                assert r.status_code == 401, path
                assert r.json()["code"] == "unauthorized"
            r = await c.post("/agenttrees/agent1/chat",
                             json={"message": "hi", "stream": False})
            assert r.status_code == 401
    run(case())


def test_on_mode_open_endpoints(monkeypatch):
    """The contract's only two security:[] operations stay open
    (openapi.yaml:23-25), plus /openapi.json + SPA paths (AuthGate decision:
    static open, API gated — the login screen must be able to render)."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            assert (await c.get("/healthz")).status_code == 200
            assert (await login(c))["access_token"]
            assert (await c.get("/openapi.json")).status_code == 200
            # non-API path falls through to (absent) SPA → plain 404, not 401
            assert (await c.get("/login")).status_code == 404
    run(case())


def test_on_mode_me_answers_per_token_user(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            admin = await login(c)
            r = await c.get("/me", headers=bearer(admin["access_token"]))
            assert r.status_code == 200
            assert r.json()["user"]["id"] == "u_admin"
            assert r.json()["roles"] == ["admin", "inspect"]

            restricted = await login(c, "restricted@demo")
            r = await c.get("/me", headers=bearer(restricted["access_token"]))
            assert r.status_code == 200
            body = r.json()
            assert body["user"]["id"] == "u_restricted"
            assert body["roles"] == []
            assert body["permissions"] == {"agent1": ["view", "evaluate"]}
    run(case())


def test_restricted_user_tree_filtering_and_404(monkeypatch):
    """feature-spec.md:32 "GET /agent-trees returns only permitted trees;
    unpermitted trees never render" — and unpermitted tree paths answer 404
    not_found (openapi.yaml:1948), indistinguishable from absent."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            restricted = (await login(c, "restricted@demo"))["access_token"]
            r = await c.get("/agenttrees", headers=bearer(restricted))
            assert [t["id"] for t in r.json()] == ["agent1"]
            # agent1 (view granted) works; agent2 404s on every method.
            assert (await c.get("/agenttrees/agent1/agents",
                                headers=bearer(restricted))).status_code == 200
            r = await c.get("/agenttrees/agent2/agents", headers=bearer(restricted))
            assert r.status_code == 404
            assert r.json() == {"code": "not_found",
                                "message": "Agent tree 'agent2' not found."}
            r = await c.post("/agenttrees/agent2/chat", headers=bearer(restricted),
                             json={"message": "hi", "stream": False})
            assert r.status_code == 404

            admin = (await login(c))["access_token"]
            r = await c.get("/agenttrees", headers=bearer(admin))
            assert [t["id"] for t in r.json()] == ["agent1", "agent2"]
    run(case())


def test_expired_and_invalid_tokens_401(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            # Expired: issue with negative ttl via the auth module directly.
            expired, _ = auth.issue_token(
                {"id": "u_admin", "email": "admin@demo", "roles": '["admin"]'},
                ttl_s=-10)
            r = await c.get("/me", headers=bearer(expired))
            assert r.status_code == 401
            assert r.json()["code"] == "unauthorized"
            # Garbage / tampered signature.
            assert (await c.get("/me", headers=bearer("not.a.jwt"))).status_code == 401
            good = (await login(c))["access_token"]
            head, payload, sig = good.split(".")
            tampered = f"{head}.{payload}.{'A' * len(sig)}"
            assert (await c.get("/me", headers=bearer(tampered))).status_code == 401
    run(case())


def test_secret_change_invalidates_tokens(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            token = (await login(c))["access_token"]
            assert (await c.get("/me", headers=bearer(token))).status_code == 200
            monkeypatch.setenv("SKEIN_JWT_SECRET", "rotated")
            assert (await c.get("/me", headers=bearer(token))).status_code == 401
    run(case())


def test_logout_204_with_valid_token_401_without(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            token = (await login(c))["access_token"]
            assert (await c.post("/auth/logout",
                                 headers=bearer(token))).status_code == 204
            assert (await c.post("/auth/logout")).status_code == 401
    run(case())


# --------------------------------------------------- demo gate + auth stack
def test_demo_gate_runs_before_auth_gate(monkeypatch):
    """Both gates active: CORS → DemoTokenGate → AuthGate (mock/main.py
    create_app ordering) — the shared demo token is checked first, then the
    per-user JWT."""
    monkeypatch.setenv("AUTH_MODE", "on")
    monkeypatch.setenv("DEMO_TOKEN", "d3mo")

    async def case():
        async with make_client() as c:
            # No demo token: demo gate rejects (its message, not the auth one).
            r = await c.get("/me")
            assert r.status_code == 401
            assert r.json()["message"] == "Missing or invalid demo token."
            # Demo token but no JWT: auth gate rejects.
            r = await c.get("/me", headers={"X-Demo-Token": "d3mo"})
            assert r.status_code == 401
            assert r.json()["code"] == "unauthorized"
            assert "bearer" in r.json()["message"].lower()
            # Both: 200. (/auth/token is open in the AUTH gate but still
            # behind the DEMO gate — pass X-Demo-Token to log in.)
            r = await c.post("/auth/token", headers={"X-Demo-Token": "d3mo"},
                             json={"email": "admin@demo", "password": "demo"})
            assert r.status_code == 200
            token = r.json()["access_token"]
            r = await c.get("/me", headers={"X-Demo-Token": "d3mo", **bearer(token)})
            assert r.status_code == 200
            assert r.json()["user"]["id"] == "u_admin"
    run(case())


# ------------------------------------------------------------- user seeding
def test_users_seeded_idempotently_on_existing_dbs(tmp_path):
    """Migration safety (mock/auth.py docstring): a pre-existing DB — schema
    without the users table, seed label already stored so bootstrap
    short-circuits — gains the table on open and the rows on boot; a second
    boot does not duplicate them (INSERT OR IGNORE)."""
    db_file = str(tmp_path / "pre-existing.sqlite")
    conn = sqlite3.connect(db_file)
    conn.executescript(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);"
        "INSERT INTO meta (key, value) VALUES ('seed', 'bootstrap-v1');")
    conn.commit()
    conn.close()

    async def boot_and_count():
        async with make_client(db_path=db_file) as c:
            body = await login(c)
            assert body["me"]["user"]["id"] == "u_admin"
        conn = sqlite3.connect(db_file)
        n = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        emails = sorted(r[0] for r in conn.execute("SELECT email FROM users"))
        conn.close()
        return n, emails

    assert run(boot_and_count()) == (2, ["admin@demo", "restricted@demo"])
    # Second boot on the same file: still exactly the two seeded users.
    assert run(boot_and_count()) == (2, ["admin@demo", "restricted@demo"])
