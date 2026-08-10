"""Per-operation permissions — the contract's `x-requires`, enforced.

Run: npm run test:mock.

Contract under test (openapi.yaml v0.3.0, cited by NAME because the line
numbers in this repo's citations are known-stale):
- info.description "Per-operation permissions (`x-requires`)" — every operation
  declares the one capability its caller must hold, and the two failures are
  deliberately different.
- components.responses.NotFound — "Resource not found (or tree not permitted)":
  a missing `view` HIDES the tree, and must keep doing so.
- components.responses.Forbidden — a missing tune/evaluate/admin/inspect
  EXPLAINS itself, code forbidden, message naming the permission and the tree.

The defect this closes: a user with `view` but not `tune` who pressed Save in
the instruction editor got a write that behaved like a backend fault. Nothing
told them, or the client, that the answer was "you are not allowed to".
"""

import asyncio
import re
from pathlib import Path

import httpx
import pytest

from mock import permissions
from mock.main import create_app

ROOT = Path(__file__).resolve().parents[2]


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


async def login(c, email, password="demo"):
    r = await c.post("/auth/token", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def contract_requirements() -> dict[str, str]:
    """`x-requires` read straight out of openapi.yaml.

    Hand-rolled rather than PyYAML: the mock's runtime image carries no YAML
    parser (mock/permissions.py explains the trade), and the three shapes this
    needs — a path key, a method key, an x-requires key — are unambiguous at
    fixed indentation. A structural change to the document fails this loudly by
    finding the wrong number of operations, which is what the count assert is
    for.
    """
    out: dict[str, str] = {}
    path = method = None
    in_paths = False
    for line in (ROOT / "openapi.yaml").read_text(encoding="utf-8").splitlines():
        if line == "paths:":
            in_paths = True
            continue
        if not in_paths:
            continue
        if m := re.fullmatch(r"  (/\S*):\s*", line):
            path, method = m.group(1), None
        elif m := re.fullmatch(r"    ([a-z]+):\s*", line):
            method = m.group(1)
        elif m := re.fullmatch(r"      x-requires: (\S+)\s*", line):
            out[f"{method.upper()} {path}"] = m.group(1)
    return out


# --------------------------------------------------------------- the table
def test_declared_requirements_match_the_contract():
    """mock/permissions.py is a cached PROJECTION of openapi.yaml, so it may
    never disagree with it — not on a value, not on an operation's existence.
    This is the same guarantee test_ready gives mock/capabilities.py."""
    contract = contract_requirements()
    assert len(contract) == 67, f"expected 67 operations, read {len(contract)}"
    assert permissions.REQUIREMENTS == contract


def test_only_capabilities_are_enforced_here():
    """`view` and `none` are pass-through in this module BY DESIGN: a missing
    view is the AuthGate's 404, and moving it here would turn existence-hiding
    into existence-confirming."""
    assert set(permissions.ENFORCED.values()) == {"tune", "evaluate", "admin", "inspect"}
    for key, requires in permissions.REQUIREMENTS.items():
        assert (key in permissions.ENFORCED) == (requires not in ("none", "view"))


def test_a_literal_segment_beats_a_placeholder():
    """/tasks/stream is not a task id. The gate matches templates itself
    (it runs before routing), so the ordering rule needs its own assertion."""
    assert permissions.requirement("GET", "/tasks/stream") is None
    assert permissions.requirement("POST", "/agenttrees/agent1/memory/compact") == (
        "tune", "/agenttrees/{tree}/memory/compact")
    assert permissions.requirement("GET", "/agenttrees/agent1/agents") is None
    assert permissions.requirement("POST", "/nope/at/all") is None


def test_tree_is_read_off_the_path():
    assert permissions.tree_of("/agenttrees/agent1/replay") == "agent1"
    assert permissions.tree_of("/agenttrees") is None
    assert permissions.tree_of("/tasks/t_1") is None


# ------------------------------------------------------- 403, auth on
def test_view_without_tune_is_a_403_that_says_so(monkeypatch):
    """The headline case. restricted@demo holds agent1 [view, evaluate]: they
    can read the instructions and they cannot save them."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            headers = await login(c, "restricted@demo")
            read = await c.get("/agenttrees/agent1/agents/ag_concierge/instructions",
                               headers=headers)
            assert read.status_code == 200, read.text

            save = await c.post(
                "/agenttrees/agent1/agents/ag_concierge/instructions/versions",
                headers=headers, json={"content": "nope", "format": "text"})
            assert save.status_code == 403, save.text
            body = save.json()
            assert body["code"] == "forbidden"
            # Names the permission AND the tree — the remedy is a checkbox on a
            # specific row of the admin matrix, so both halves are needed.
            assert "tune" in body["message"] and "agent1" in body["message"]
            # F7's correlation id rides every error, gates included.
            assert body["request_id"]

            # …and the write really did not happen.
            after = await c.get("/agenttrees/agent1/agents/ag_concierge/instructions",
                                headers=headers)
            assert after.json()["live_version"] == read.json()["live_version"]
    run(case())


def test_every_tune_operation_refuses_the_same_way(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            headers = await login(c, "restricted@demo")
            calls = [
                c.post("/agenttrees/agent1/agents", headers=headers,
                       json={"name": "child"}),
                c.post("/agenttrees/agent1/agents/ag_concierge/snapshots",
                       headers=headers, json={"content": "draft", "base_version": 1}),
                c.post("/agenttrees/agent1/agents/ag_concierge/instructions/versions",
                       headers=headers, json={"content": "x", "format": "text"}),
            ]
            for call in calls:
                r = await call
                assert r.status_code == 403, r.text
                assert r.json()["code"] == "forbidden"
    run(case())


def test_the_permission_the_caller_holds_still_works(monkeypatch):
    """A 403 that also fired on `evaluate` would just be a broken backend.
    restricted@demo HAS evaluate on agent1, so the evaluate operations pass."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            headers = await login(c, "restricted@demo")
            r = await c.put("/agenttrees/agent1/agents/ag_concierge/last-selection",
                            headers=headers, json={"items": []})
            assert r.status_code == 200, r.text
    run(case())


def test_revoking_evaluate_refuses_the_evaluate_operations(monkeypatch):
    """The matrix is the only input: an admin edit takes effect on the user's
    next request, for 403 exactly as it already did for the tree listing."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            admin = await login(c, "admin@demo")
            restricted = await login(c, "restricted@demo")
            put = await c.put("/admin/users/u_restricted/permissions", headers=admin,
                              json={"permissions": {"agent1": ["view"]}})
            assert put.status_code == 200, put.text

            r = await c.put("/agenttrees/agent1/agents/ag_concierge/last-selection",
                            headers=restricted, json={"items": []})
            assert r.status_code == 403
            assert "evaluate" in r.json()["message"]
            # …and reading still works: view was never taken away.
            assert (await c.get("/agenttrees/agent1/conversations",
                                headers=restricted)).status_code == 200
    run(case())


def test_an_unpermitted_tree_still_404s_even_for_a_tune_operation(monkeypatch):
    """The security property this stage was not allowed to weaken. agent2 is
    not in restricted@demo's matrix at all, so a tune operation against it must
    answer 404 — 403 would confirm the tree exists."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            headers = await login(c, "restricted@demo")
            for r in [
                await c.post("/agenttrees/agent2/agents/ag_ops/instructions/versions",
                             headers=headers, json={"content": "x", "format": "text"}),
                await c.get("/agenttrees/agent2/agents", headers=headers),
                await c.post("/agenttrees/agent2/replay", headers=headers, json={}),
            ]:
                assert r.status_code == 404, r.text
                assert r.json()["code"] == "not_found"
            # A tree that does not exist answers identically — that is the point.
            ghost = await c.get("/agenttrees/nosuchtree/agents", headers=headers)
            assert ghost.status_code == 404
            assert ghost.json()["code"] == "not_found"
    run(case())


def test_roles_are_enforced_by_the_same_gate(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            headers = await login(c, "restricted@demo")
            users = await c.get("/admin/users", headers=headers)
            assert users.status_code == 403
            assert users.json()["message"] == "The admin role is required."
            inspector = await c.get("/admin/conversations", headers=headers)
            assert inspector.status_code == 403
            assert inspector.json()["message"] == "The inspect role is required."
    run(case())


# ------------------------------------------------------- 403, auth OFF
def test_off_mode_runs_the_same_gate_and_is_allowed():
    """No AUTH_MODE branch (CLAUDE.md invariant): the check runs, and the dev
    user holds everything, so every capability operation answers normally. If
    this ever 403s, the gate has started reading the mode instead of the
    matrix."""
    async def case():
        async with make_client() as c:
            save = await c.post(
                "/agenttrees/agent1/agents/ag_concierge/instructions/versions",
                json={"content": "dev can tune", "format": "text"})
            assert save.status_code == 201, save.text
            sel = await c.put("/agenttrees/agent1/agents/ag_concierge/last-selection",
                              json={"items": []})
            assert sel.status_code == 200, sel.text
            assert (await c.get("/admin/users")).status_code == 200
            assert (await c.get("/admin/conversations")).status_code == 200
    run(case())
