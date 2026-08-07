"""P2-T07b/07c admin tests — members permission matrix + tree enable/disable.
Run: npm run test:mock.

Contract under test (openapi.yaml v0.3.0):
- :169-218 GET/PUT /admin/users ("Every user, cross-user (admin-only)";
  "upsert keyed by email ... Users absent from the body are untouched")
- :220-265 GET/PUT /admin/users/{userId}/permissions ("Same shape as
  Me.permissions"; "Takes effect on the user's next request")
- :267-296 PATCH /admin/agenttrees/{treeId} {enabled} ("Disabled tree: hidden
  from GET /agenttrees for non-admins ...; new chat/replay/judge against it
  return 409 tree_disabled; ... existing conversations stay READABLE")
- :1966-1970 Forbidden ("admin for /admin/* management", code forbidden)
- :1974-1979 Conflict (code tree_disabled)
"""

import asyncio

import httpx
import pytest

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
    monkeypatch.delenv("CUPEL_JWT_SECRET", raising=False)


async def login(c, email="admin@demo", password="demo"):
    r = await c.post("/auth/token", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def bearer(token):
    return {"Authorization": f"Bearer {token}"}


# ------------------------------------------------------------ role gating
def test_admin_endpoints_403_for_non_admin_on_mode(monkeypatch):
    """openapi.yaml:1966-1970 Forbidden — restricted@demo has roles [] so
    every /admin/* operation answers 403 forbidden in on-mode."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            token = await login(c, "restricted@demo")
            calls = [
                c.get("/admin/users", headers=bearer(token)),
                c.put("/admin/users", headers=bearer(token),
                      json=[{"email": "x@demo"}]),
                c.get("/admin/users/u_restricted/permissions",
                      headers=bearer(token)),
                c.put("/admin/users/u_restricted/permissions",
                      headers=bearer(token), json={"permissions": {}}),
                c.patch("/admin/agenttrees/agent1", headers=bearer(token),
                        json={"enabled": False}),
            ]
            for call in calls:
                r = await call
                assert r.status_code == 403, r.text
                assert r.json()["code"] == "forbidden"
    run(case())


def test_admin_endpoints_401_without_token_on_mode(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            r = await c.get("/admin/users")
            assert r.status_code == 401
            assert r.json()["code"] == "unauthorized"
    run(case())


def test_off_mode_dev_user_is_admin():
    """feature-spec.md:17 "off = ... default admin = all trees, all rights":
    the dev user works the admin endpoints with no token, and GET /me
    advertises roles [admin, inspect] so the role-driven UI shows."""
    async def case():
        async with make_client() as c:
            assert (await c.get("/me")).json()["roles"] == ["admin", "inspect"]
            r = await c.get("/admin/users")
            assert r.status_code == 200
            assert sorted(u["email"] for u in r.json()) == [
                "admin@demo", "restricted@demo"]
            r = await c.patch("/admin/agenttrees/agent2",
                              json={"enabled": False})
            assert r.status_code == 200
            assert r.json() == {"id": "agent2", "name": "Ops Copilot",
                                "enabled": False}
    run(case())


# ------------------------------------------------------------- users CRUD
def test_list_users_shape(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            token = await login(c)
            r = await c.get("/admin/users", headers=bearer(token))
            assert r.status_code == 200
            users = {u["email"]: u for u in r.json()}
            admin = users["admin@demo"]
            # AdminUser (openapi.yaml:3009-3025): roles only, no permissions
            # field — per-tree rights live in the matrix endpoint.
            assert admin["roles"] == ["admin", "inspect"]
            assert admin["invited"] is False
            assert "permissions" not in admin
            assert users["restricted@demo"]["roles"] == []
    run(case())


def test_put_users_upserts_by_email_invite_and_update(monkeypatch):
    """openapi.yaml:195-200 — "a new email creates an invited user ...; an
    existing email updates name/roles. Users absent from the body are
    untouched"."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            token = await login(c)
            r = await c.put("/admin/users", headers=bearer(token), json=[
                {"email": "new@demo", "name": "Newbie"},
                {"email": "restricted@demo", "roles": ["inspect"]},
            ])
            assert r.status_code == 200
            by_email = {u["email"]: u for u in r.json()}
            assert by_email["new@demo"]["invited"] is True
            assert by_email["new@demo"]["name"] == "Newbie"
            # Null name = leave unchanged (openapi.yaml:3033).
            assert by_email["restricted@demo"]["name"] == "Restricted"
            assert by_email["restricted@demo"]["roles"] == ["inspect"]

            listing = await c.get("/admin/users", headers=bearer(token))
            emails = sorted(u["email"] for u in listing.json())
            assert emails == ["admin@demo", "new@demo", "restricted@demo"]
            # Invited users cannot sign in — no password flow in the mock.
            r = await c.post("/auth/token",
                             json={"email": "new@demo", "password": "demo"})
            assert r.status_code == 401
    run(case())


# ------------------------------------------------------ permission matrix
def test_permissions_round_trip_and_effect_on_me_and_trees(monkeypatch):
    """PUT matrix → the target user's NEXT /me reflects it and tree filtering
    follows (openapi.yaml:246-250; e2e checklist 12 "admin permission matrix
    edit takes effect"). No live push — effect lands on the next request."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            admin = await login(c)
            restricted = await login(c, "restricted@demo")

            r = await c.get("/admin/users/u_restricted/permissions",
                            headers=bearer(admin))
            assert r.status_code == 200
            assert r.json() == {"user_id": "u_restricted",
                                "permissions": {"agent1": ["view", "evaluate"]}}

            matrix = {"agent1": ["view", "evaluate"], "agent2": ["view"]}
            r = await c.put("/admin/users/u_restricted/permissions",
                            headers=bearer(admin),
                            json={"permissions": matrix})
            assert r.status_code == 200
            assert r.json()["permissions"] == matrix

            # Same JWT, next request: /me and /agenttrees pick up the grant.
            me = await c.get("/me", headers=bearer(restricted))
            assert me.json()["permissions"] == matrix
            trees = await c.get("/agenttrees", headers=bearer(restricted))
            assert [t["id"] for t in trees.json()] == ["agent1", "agent2"]

            # Revoke agent2 again — the tree drops off and 404s directly.
            await c.put("/admin/users/u_restricted/permissions",
                        headers=bearer(admin),
                        json={"permissions": {"agent1": ["view"]}})
            trees = await c.get("/agenttrees", headers=bearer(restricted))
            assert [t["id"] for t in trees.json()] == ["agent1"]
            r = await c.get("/agenttrees/agent2/agents",
                            headers=bearer(restricted))
            assert r.status_code == 404
    run(case())


def test_permissions_unknown_user_404_and_bad_body_422(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            admin = await login(c)
            r = await c.get("/admin/users/u_nobody/permissions",
                            headers=bearer(admin))
            assert r.status_code == 404
            r = await c.put("/admin/users/u_restricted/permissions",
                            headers=bearer(admin),
                            json={"permissions": {"agent1": ["root"]}})
            assert r.status_code == 422
    run(case())


# --------------------------------------------------- tree disable semantics
def test_disable_blocks_writes_keeps_reads():
    """The documented write-block set (mock/main.py need_enabled_tree): chat,
    replay, replay/turn, judge-on-run, create agent, PUT instructions, POST
    snapshots, PUT last-selection, conversation rename/delete → 409
    tree_disabled; every GET stays 200 — "new work blocked, history kept
    read-only" (cupel-phases.md:77). Off mode (dev user = admin) — the
    disable gate is mode-independent."""
    async def case():
        async with make_client() as c:
            # Seed history BEFORE disabling: a conversation with a turn.
            r = await c.post("/agenttrees/agent1/chat",
                             json={"message": "pre-disable", "stream": False})
            assert r.status_code == 200
            conv_id = r.json()["conversation_id"]
            turn_id = r.json()["turn"]["id"]
            # And a finished run to point judge at.
            r = await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "claude-sonnet-5"}]})
            assert r.status_code == 202
            run_id = r.json()["run_id"]
            await asyncio.sleep(0.05)  # zero-delay engine drains instantly
            await c.post("/eval/rubrics",
                         json={"name": "r", "prompt": "score it"})

            r = await c.patch("/admin/agenttrees/agent1",
                              json={"enabled": False})
            assert r.status_code == 200 and r.json()["enabled"] is False

            writes = [
                c.post("/agenttrees/agent1/chat",
                       json={"message": "hi", "stream": False}),
                c.post("/agenttrees/agent1/replay", json={
                    "selection": [{"conversation_id": conv_id}],
                    "configs": [{}]}),
                c.post("/agenttrees/agent1/replay/turn", json={
                    "conversation_id": conv_id, "turn_id": turn_id,
                    "endpoints": ["ep_agent1_prod"]}),
                c.post("/agenttrees/agent1/agents", json={"name": "New"}),
                c.put("/agenttrees/agent1/agents/ag_concierge/instructions",
                      json={"content": "x"}),
                c.post("/agenttrees/agent1/agents/ag_concierge/snapshots",
                       json={"content": "x"}),
                c.put("/agenttrees/agent1/agents/ag_concierge/last-selection",
                      json={"items": []}),
                c.patch(f"/agenttrees/agent1/conversations/{conv_id}",
                        json={"title": "renamed"}),
                c.delete(f"/agenttrees/agent1/conversations/{conv_id}"),
            ]
            for call in writes:
                r = await call
                assert r.status_code == 409, r.text
                assert r.json()["code"] == "tree_disabled"

            # Judge on a run whose tree is disabled → 409 (documented rule).
            rubric = (await c.get("/eval/rubrics")).json()[0]
            r = await c.post("/eval/judge", json={
                "run_id": run_id, "judge_model": "claude-sonnet-5",
                "rubric_id": rubric["id"]})
            assert r.status_code == 409
            assert r.json()["code"] == "tree_disabled"

            # Reads all keep working — history and traces aren't lost.
            reads = [
                "/agenttrees/agent1/conversations",
                f"/agenttrees/agent1/conversations/{conv_id}",
                "/agenttrees/agent1/agents",
                "/agenttrees/agent1/agents/ag_concierge/instructions",
                "/agenttrees/agent1/agents/ag_concierge/last-selection",
                "/agenttrees/agent1/endpoints",
                "/agenttrees/agent1/runs",
                f"/agenttrees/agent1/runs/{run_id}",
                f"/agenttrees/agent1/turns/{turn_id}/trace",
            ]
            for path in reads:
                r = await c.get(path)
                assert r.status_code == 200, path

            # Feedback stays allowed — annotation of history, not new work.
            r = await c.post("/feedback",
                             json={"message_id": turn_id, "rating": "up"})
            assert r.status_code == 201

            # Re-enable restores everything (feature-spec.md:20).
            r = await c.patch("/admin/agenttrees/agent1",
                              json={"enabled": True})
            assert r.status_code == 200 and r.json()["enabled"] is True
            r = await c.post("/agenttrees/agent1/chat",
                             json={"message": "back", "stream": False})
            assert r.status_code == 200
    run(case())


def test_disabled_tree_visibility_admin_vs_restricted(monkeypatch):
    """feature-spec.md:121 "GET /agenttrees (permitted + enabled; admins also
    see disabled)": non-admins lose the disabled tree from the listing;
    admins keep it with enabled:false."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            admin = await login(c)
            restricted = await login(c, "restricted@demo")
            r = await c.patch("/admin/agenttrees/agent1",
                              headers=bearer(admin), json={"enabled": False})
            assert r.status_code == 200

            admin_trees = (await c.get("/agenttrees",
                                       headers=bearer(admin))).json()
            assert {t["id"]: t["enabled"] for t in admin_trees} == {
                "agent1": False, "agent2": True}

            # restricted has view on agent1 only — disabled, so the listing
            # is empty; agent1's HISTORY is still readable directly.
            restricted_trees = (await c.get("/agenttrees",
                                            headers=bearer(restricted))).json()
            assert restricted_trees == []
            r = await c.get("/agenttrees/agent1/conversations",
                            headers=bearer(restricted))
            assert r.status_code == 200
    run(case())


def test_patch_tree_validation():
    async def case():
        async with make_client() as c:
            r = await c.patch("/admin/agenttrees/nope", json={"enabled": False})
            assert r.status_code == 404
            r = await c.patch("/admin/agenttrees/agent1", json={"enabled": "no"})
            assert r.status_code == 422
    run(case())
