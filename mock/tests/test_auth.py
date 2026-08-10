"""Auth tests — both AUTH_MODEs (cupel-phases.md:76, :98; openapi.yaml
:21-36 AUTH_MODE semantics). Run: npm run test:mock.

Off-mode (AUTH_MODE unset — the deployed demo's configuration) must behave
exactly as it did before auth: /me answers the dev user, nothing enforced. On-mode:
seeded admin@demo / restricted@demo (password "demo"), real-shaped HS256 JWTs,
401s, permission filtering.
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
from mock.tests import with_turns
from mock.tests.test_mock import StreamingASGITransport, parse_sse


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
    monkeypatch.delenv("CUPEL_JWT_SECRET", raising=False)


async def login(c, email="admin@demo", password="demo"):
    r = await c.post("/auth/token", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


# ----------------------------------------------------------- off mode (demo)
def test_off_mode_me_is_dev_user_unchanged():
    """DELIBERATE change to the off-mode /me byte-parity assertion:
    the dev user now carries roles ["admin", "inspect"] — roles is the
    additive OPTIONAL v0.3.0 Me field (openapi.yaml:2004-2012), and off mode
    is "instant dev as a chosen user ... default admin = all trees, all
    rights" (feature-spec.md:17, cupel-phases.md:76), so the dev user must
    advertise admin for the role-driven Settings → Members / Agent trees UI.
    Everything else stays byte-identical to the pre-auth shape."""
    async def case():
        async with make_client() as c:
            r = await c.get("/me")
            assert r.status_code == 200
            assert r.json() == {
                "user": {"id": "dev", "name": "Dev User", "email": "dev@cupel.local"},
                "roles": ["admin", "inspect"],
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
                                "message": "Agent tree 'agent2' not found.",
                                "request_id": r.headers["X-Request-Id"]}
            r = await c.post("/agenttrees/agent2/chat", headers=bearer(restricted),
                             json={"message": "hi", "stream": False})
            assert r.status_code == 404

            admin = (await login(c))["access_token"]
            r = await c.get("/agenttrees", headers=bearer(admin))
            assert [t["id"] for t in r.json()] == ["agent1", "agent2"]
    run(case())


# ------------------------------------- cross-tree leaks (review bucket A)
async def wait_task_as(c, task_id, token, timeout=15):
    deadline = time.monotonic() + timeout
    task = None
    while time.monotonic() < deadline:
        r = await c.get(f"/tasks/{task_id}", headers=bearer(token))
        assert r.status_code == 200, r.text
        task = r.json()
        if task["status"] in ("done", "failed", "cancelled"):
            return task
        await asyncio.sleep(0.02)
    raise AssertionError(f"task {task_id} did not finish: {task}")


def test_tasks_stream_only_emits_events_of_permitted_trees(monkeypatch):
    """docs/review-2026-08-05.md A2 — GET /tasks/stream is ONE global channel
    (openapi.yaml:1183-1219 declares no parameters), and it fanned every task
    result, span and judgment to every subscriber. "Unpermitted trees never
    render" (feature-spec.md:32) has to hold on the stream too, so each event
    is authorized against the subscriber's permission matrix.

    restricted@demo holds view on agent1 only; work happens on agent2 first,
    then on agent1 — so the agent1 event both subscribers stop on proves the
    agent2 events were dropped for restricted, not merely late."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        app = create_app(db_path=":memory:", token_delay=0, step_delay=0,
                         static_dir="__no_dist__")
        async with httpx.AsyncClient(transport=StreamingASGITransport(app),
                                     base_url="http://t") as c:
            admin = (await login(c))["access_token"]
            limited = (await login(c, "restricted@demo"))["access_token"]
            ids, seen_limited, seen_admin = {}, [], []
            subscribed = asyncio.Event()
            ready = 0

            def done_task_ids(events):
                return {d["id"] for ev, d in events
                        if ev == "task" and d["status"] == "done"}

            async def consume(token, sink, want_done):
                nonlocal ready
                async with c.stream("GET", "/tasks/stream",
                                    headers=bearer(token)) as r:
                    assert r.status_code == 200
                    buf = ""
                    async for chunk in r.aiter_text():
                        buf += chunk
                        ready += 1
                        if ready >= 2:
                            subscribed.set()
                        sink[:] = parse_sse(buf)
                        if len(done_task_ids(sink)) >= want_done:
                            return

            async def produce():
                await subscribed.wait()
                r = await c.post("/agenttrees/agent2/chat", headers=bearer(admin),
                                 json={"message": "agent2 only", "stream": False})
                assert r.status_code == 200, r.text
                ids["agent2_task"] = r.json()["task_id"]
                await wait_task_as(c, ids["agent2_task"], admin)
                r = await c.post("/agenttrees/agent1/chat", headers=bearer(limited),
                                 json={"message": "agent1 shared", "stream": False})
                assert r.status_code == 200, r.text
                ids["agent1_task"] = r.json()["task_id"]
                ids["agent1_conv"] = r.json()["conversation_id"]
                await wait_task_as(c, ids["agent1_task"], limited)

            await asyncio.wait_for(asyncio.gather(
                consume(limited, seen_limited, 1),
                consume(admin, seen_admin, 2),
                produce()), timeout=25)

            # The permitted subscriber saw agent1's task family and nothing else.
            limited_tasks = ({d["id"] for ev, d in seen_limited if ev == "task"}
                             | {d["task_id"] for ev, d in seen_limited if ev == "progress"})
            assert limited_tasks == {ids["agent1_task"]}
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{ids['agent1_conv']}",
                                headers=bearer(limited))
            agent1_turns = {t["id"] for t in conv["turns"]}
            assert {d["turn_id"] for ev, d in seen_limited if ev == "span"} <= agent1_turns
            # …while a holder of both trees still receives both.
            admin_tasks = {d["id"] for ev, d in seen_admin if ev == "task"}
            assert {ids["agent1_task"], ids["agent2_task"]} <= admin_tasks
    run(case())


def test_span_payload_requires_view_on_the_spans_tree(monkeypatch):
    """docs/review-2026-08-05.md A3 — GET /spans/{spanId}/payload is globally
    addressable and holds the full prompt/response, but had no ownership check.
    The span's turn decides: no view on its tree → 404, indistinguishable from
    absent, like every tree-scoped resource (openapi.yaml:1948)."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            admin = (await login(c))["access_token"]
            limited = (await login(c, "restricted@demo"))["access_token"]

            async def span_of(tree, token):
                r = await c.post(f"/agenttrees/{tree}/chat", headers=bearer(token),
                                 json={"message": "trace me", "stream": False})
                assert r.status_code == 200, r.text
                turn_id = r.json()["turn"]["id"]
                await wait_task_as(c, r.json()["task_id"], token)
                trace = (await c.get(f"/agenttrees/{tree}/turns/{turn_id}/trace",
                                     headers=bearer(token))).json()
                llm = next(s for s in trace["spans"] if s["type"] == "llm")
                return llm["payload_ref"]

            secret = await span_of("agent2", admin)
            shared = await span_of("agent1", limited)

            r = await c.get(f"/spans/{secret}/payload", headers=bearer(limited))
            assert r.status_code == 404
            assert r.json() == {"code": "not_found",
                                "message": f"Span '{secret}' not found.",
                                "request_id": r.headers["X-Request-Id"]}
            assert (await c.get(f"/spans/{secret}/payload",
                                headers=bearer(admin))).status_code == 200
            r = await c.get(f"/spans/{shared}/payload", headers=bearer(limited))
            assert r.status_code == 200
            assert r.json()["prompt"]
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
            monkeypatch.setenv("CUPEL_JWT_SECRET", "rotated")
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
