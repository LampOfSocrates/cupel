"""Inspector + Casebooks tests. Run: npm run test:mock.

Contract under test (openapi.yaml v0.3.0):
- :298-348 GET /admin/conversations ("Inspector — every conversation,
  cross-user"; filters user_id/tree/date_from/date_to/score_min/score_max,
  page/page_size; "Requires the inspect role (403 otherwise); EVERY access is
  audit-logged server-side")
- :3129-3155 AdminConversationItem (user_id, user_email, latest_score) +
  AdminConversationPage (items/page/page_size/total)
- :1643-1730 GET/POST /casebooks, GET/PATCH/DELETE /casebooks/{casebookId}
- :1732-1775 POST /casebooks/{id}/items ("Re-adding the same turn is
  idempotent (returns the existing item)"), DELETE …/items/{itemId}
- :1777-1802 POST /casebooks/{id}/to-eval-set ("reuses the existing eval case
  for that turn or creates one sourced from it … then creates a new set")
- :1804-1830 POST /casebooks/{id}/replay ("one run per tree touched, all
  children of a single parent task", CasebookReplayAccepted :3320-3338)
"""

import asyncio

import httpx
import pytest

from mock.main import create_app


def make_app(**kwargs):
    return create_app(db_path=":memory:", token_delay=0, step_delay=0,
                      static_dir="__no_dist__", **kwargs)


def client_for(app, **kwargs):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t", **kwargs)


def make_client(**kwargs):
    return client_for(make_app(), **kwargs)


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
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


async def chat(c, tree, message, author="user", conversation_id=None, **headers):
    r = await c.post(f"/agenttrees/{tree}/chat", json={
        "message": message, "stream": False, "author": author,
        "conversation_id": conversation_id,
    }, headers=headers or None)
    assert r.status_code == 200, r.text
    return r.json()


async def thumb(c, turn_id, rating="up"):
    r = await c.post("/feedback", json={"message_id": turn_id, "rating": rating})
    assert r.status_code == 201, r.text
    return r.json()


# ============================================================ Inspector table
def test_lists_conversations_across_users_with_owner_and_score():
    """AdminConversationItem = "an ordinary conversation plus the cross-user
    dimension" (openapi.yaml:3134-3137) — user_id + latest_score columns."""
    async def case():
        async with make_client() as c:
            a = await chat(c, "agent1", "alpha question", author="persona-a")
            b = await chat(c, "agent1", "beta question", author="persona-b")
            await thumb(c, a["turn"]["id"], "down")

            r = await c.get("/admin/conversations")
            assert r.status_code == 200, r.text
            page = r.json()
            assert page["page"] == 1 and page["page_size"] == 50
            assert page["total"] == 2 and len(page["items"]) == 2
            by_id = {i["id"]: i for i in page["items"]}
            assert by_id[a["conversation_id"]]["user_id"] == "persona-a"
            assert by_id[b["conversation_id"]]["user_id"] == "persona-b"
            assert by_id[a["conversation_id"]]["latest_score"] == 0.0
            assert by_id[b["conversation_id"]]["latest_score"] is None
            # Dense index: rows carry no transcript (the reader fetches it).
            assert "turns" not in by_id[a["conversation_id"]]
    run(case())


def test_filter_by_user_id():
    async def case():
        async with make_client() as c:
            await chat(c, "agent1", "one", author="persona-a")
            await chat(c, "agent1", "two", author="persona-b")
            r = await c.get("/admin/conversations", params={"user_id": "persona-b"})
            page = r.json()
            assert page["total"] == 1
            assert page["items"][0]["user_id"] == "persona-b"
    run(case())


def test_filter_by_tree():
    async def case():
        async with make_client() as c:
            await chat(c, "agent1", "one")
            await chat(c, "agent2", "two")
            r = await c.get("/admin/conversations", params={"tree": "agent2"})
            page = r.json()
            assert page["total"] == 1
            assert page["items"][0]["tree_id"] == "agent2"
    run(case())


def test_filter_by_date_range():
    """"Conversations with activity on/after this date" (openapi.yaml:323) —
    the filter compares the DATE part of last_activity_at."""
    app = make_app()

    async def case():
        async with client_for(app) as c:
            old = await chat(c, "agent1", "ancient")
            new = await chat(c, "agent1", "fresh")
            app.state.db.run(
                "UPDATE conversations SET last_activity_at = ? WHERE id = ?",
                ("2026-01-05T09:00:00.000Z", old["conversation_id"]))
            app.state.db.run(
                "UPDATE conversations SET last_activity_at = ? WHERE id = ?",
                ("2026-06-20T09:00:00.000Z", new["conversation_id"]))

            r = await c.get("/admin/conversations", params={"date_from": "2026-06-01"})
            assert [i["id"] for i in r.json()["items"]] == [new["conversation_id"]]

            r = await c.get("/admin/conversations", params={"date_to": "2026-01-31"})
            assert [i["id"] for i in r.json()["items"]] == [old["conversation_id"]]

            r = await c.get("/admin/conversations",
                            params={"date_from": "2026-01-01", "date_to": "2026-12-31"})
            assert r.json()["total"] == 2

            # Boundary: on/after includes the exact day.
            r = await c.get("/admin/conversations", params={"date_from": "2026-06-20"})
            assert [i["id"] for i in r.json()["items"]] == [new["conversation_id"]]
    run(case())


def test_filter_by_score_range():
    """"Latest-judgment score filter (triage worst-first)" (openapi.yaml:330).
    Unscored conversations fall outside every range."""
    async def case():
        async with make_client() as c:
            bad = await chat(c, "agent1", "bad one")
            good = await chat(c, "agent1", "good one")
            await chat(c, "agent1", "unscored one")
            await thumb(c, bad["turn"]["id"], "down")   # 0.0
            await thumb(c, good["turn"]["id"], "up")    # 1.0

            r = await c.get("/admin/conversations", params={"score_max": 0.5})
            assert [i["id"] for i in r.json()["items"]] == [bad["conversation_id"]]

            r = await c.get("/admin/conversations", params={"score_min": 0.5})
            assert [i["id"] for i in r.json()["items"]] == [good["conversation_id"]]

            r = await c.get("/admin/conversations",
                            params={"score_min": 0.0, "score_max": 1.0})
            assert r.json()["total"] == 2  # the unscored row is excluded
    run(case())


def test_score_filter_uses_the_latest_judgment():
    """Judgments are append-only, so a re-rating appends — the newest wins."""
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "changed my mind")
            await thumb(c, conv["turn"]["id"], "down")
            await thumb(c, conv["turn"]["id"], "up")
            r = await c.get("/admin/conversations")
            assert r.json()["items"][0]["latest_score"] == 1.0
            assert (await c.get("/admin/conversations",
                                params={"score_max": 0.5})).json()["total"] == 0
    run(case())


def test_pagination():
    async def case():
        async with make_client() as c:
            for i in range(5):
                await chat(c, "agent1", f"message {i}")
            first = (await c.get("/admin/conversations",
                                 params={"page": 1, "page_size": 2})).json()
            second = (await c.get("/admin/conversations",
                                  params={"page": 2, "page_size": 2})).json()
            third = (await c.get("/admin/conversations",
                                 params={"page": 3, "page_size": 2})).json()
            assert first["total"] == second["total"] == 5
            assert len(first["items"]) == len(second["items"]) == 2
            assert len(third["items"]) == 1
            ids = {i["id"] for i in first["items"]} | {i["id"] for i in second["items"]}
            assert len(ids) == 4  # pages do not overlap
            assert second["page"] == 2 and second["page_size"] == 2
    run(case())


def test_forks_are_listed_too():
    """"Inspect EVERY conversation in the system" (cupel-phases.md:78) — the
    Inspector is not roots-only like the sidebar listing."""
    app = make_app()

    async def case():
        async with client_for(app) as c:
            parent = await chat(c, "agent1", "root")
            eps = (await c.get("/agenttrees/agent1/endpoints")).json()
            r = await c.post("/agenttrees/agent1/replay/turn", json={
                "conversation_id": parent["conversation_id"],
                "turn_id": parent["turn"]["id"],
                "endpoints": [eps[0]["id"]],
            })
            assert r.status_code == 202, r.text
            fork_id = r.json()["results"][0]["conversation_id"]
            ids = {i["id"] for i in (await c.get("/admin/conversations")).json()["items"]}
            assert parent["conversation_id"] in ids and fork_id in ids
            # A fork belongs to its parent's owner.
            forks = {i["id"]: i for i in (await c.get("/admin/conversations")).json()["items"]}
            assert forks[fork_id]["user_id"] == forks[parent["conversation_id"]]["user_id"]
    run(case())


def test_deleted_conversations_stay_hidden():
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "to be deleted")
            await c.delete(f"/agenttrees/agent1/conversations/{conv['conversation_id']}")
            assert (await c.get("/admin/conversations")).json()["total"] == 0
    run(case())


# ------------------------------------------------------------- role + audit
def test_403_without_the_inspect_role(monkeypatch):
    """"Requires the inspect role (403 otherwise)" (openapi.yaml:308).
    restricted@demo has roles [] (mock/auth.py SEED_USERS)."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            r = await c.get("/admin/conversations",
                            headers=await login(c, "restricted@demo"))
            assert r.status_code == 403, r.text
            assert r.json()["code"] == "forbidden"
            r = await c.get("/admin/conversations", headers=await login(c))
            assert r.status_code == 200, r.text
    run(case())


def test_401_without_a_token_on_mode(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            r = await c.get("/admin/conversations")
            assert r.status_code == 401
    run(case())


def test_inspect_role_does_not_widen_tree_permissions(monkeypatch):
    """Documented decision (mock/main.py list_admin_conversations): inspect
    widens the USER dimension, not the TREE dimension — an inspector still
    sees only the trees their matrix grants."""
    monkeypatch.setenv("AUTH_MODE", "on")
    app = make_app()

    async def case():
        async with client_for(app) as c:
            admin = await login(c)
            await chat(c, "agent1", "in agent1", **admin)
            await chat(c, "agent2", "in agent2", **admin)
            # Grant restricted@demo the inspect role, keeping agent1-only view.
            r = await c.put("/admin/users", headers=admin,
                            json=[{"email": "restricted@demo", "roles": ["inspect"]}])
            assert r.status_code == 200, r.text
            limited = await login(c, "restricted@demo")
            page = (await c.get("/admin/conversations", headers=limited)).json()
            assert page["total"] == 1
            assert page["items"][0]["tree_id"] == "agent1"
            # …while the full inspector sees both.
            assert (await c.get("/admin/conversations", headers=admin)).json()["total"] == 2
    run(case())


def test_every_query_writes_an_audit_record():
    """"EVERY access is audit-logged server-side" (openapi.yaml:308-309).
    The trail is an inspect_audit row — who, the filters, the result count;
    the contract declares no endpoint that reads it back."""
    app = make_app()

    async def case():
        async with client_for(app) as c:
            await chat(c, "agent1", "watch me", author="persona-a")
            await c.get("/admin/conversations", params={"user_id": "persona-a"})
            await c.get("/admin/conversations", params={"score_min": 0.9})
            rows = app.state.db.all("SELECT * FROM inspect_audit ORDER BY rowid")
            assert len(rows) == 2
            assert rows[0]["user_id"] == "dev"
            assert '"user_id": "persona-a"' in rows[0]["filters"]
            assert rows[0]["result_count"] == 1
            assert rows[1]["result_count"] == 0
            assert rows[0]["created_at"]
    run(case())


def test_audit_records_the_verified_user_on_mode(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")
    app = make_app()

    async def case():
        async with client_for(app) as c:
            await c.get("/admin/conversations", headers=await login(c))
            row = app.state.db.one("SELECT * FROM inspect_audit")
            assert row["user_id"] == "u_admin" and row["email"] == "admin@demo"
    run(case())


def test_a_403_writes_no_audit_record(monkeypatch):
    """Only ACCESS is audited — a refused request read nothing."""
    monkeypatch.setenv("AUTH_MODE", "on")
    app = make_app()

    async def case():
        async with client_for(app) as c:
            r = await c.get("/admin/conversations",
                            headers=await login(c, "restricted@demo"))
            assert r.status_code == 403
            assert app.state.db.all("SELECT * FROM inspect_audit") == []
    run(case())


# ================================================================= casebooks
async def seed_casebook(c, name="Noteworthy"):
    r = await c.post("/casebooks", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()


def test_casebook_crud():
    async def case():
        async with make_client() as c:
            assert (await c.get("/casebooks")).json() == []
            book = await seed_casebook(c, "Refund failures")
            assert book["name"] == "Refund failures"
            assert book["items"] == [] and book["description"] is None
            assert book["created_at"]

            assert [b["id"] for b in (await c.get("/casebooks")).json()] == [book["id"]]
            assert (await c.get(f"/casebooks/{book['id']}")).json()["id"] == book["id"]

            r = await c.patch(f"/casebooks/{book['id']}",
                              json={"name": "Refunds", "description": "worst first"})
            assert r.status_code == 200, r.text
            assert r.json()["name"] == "Refunds"
            assert r.json()["description"] == "worst first"
            # PATCH is metadata only — membership is untouched.
            assert r.json()["items"] == []

            assert (await c.delete(f"/casebooks/{book['id']}")).status_code == 204
            assert (await c.get(f"/casebooks/{book['id']}")).status_code == 404
            assert (await c.delete(f"/casebooks/{book['id']}")).status_code == 404
            assert (await c.get("/casebooks")).json() == []
    run(case())


def test_create_requires_a_name():
    async def case():
        async with make_client() as c:
            assert (await c.post("/casebooks", json={})).status_code == 422
    run(case())


def test_add_and_remove_items_are_references_only():
    """"An item is a REFERENCE to a turn, never a copy" (openapi.yaml:1739);
    removing it "touches nothing else" (:1766-1769)."""
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "keep this one")
            book = await seed_casebook(c)
            r = await c.post(f"/casebooks/{book['id']}/items", json={
                "tree": "agent1", "conversation_id": conv["conversation_id"],
                "turn_id": conv["turn"]["id"], "note": "great answer",
            })
            assert r.status_code == 201, r.text
            item = r.json()
            assert item["tree"] == "agent1"
            assert item["conversation_id"] == conv["conversation_id"]
            assert item["turn_id"] == conv["turn"]["id"]
            assert item["note"] == "great answer" and item["added_at"]
            # No transcript copy travels with the item.
            assert set(item) == {"id", "tree", "conversation_id", "turn_id",
                                 "note", "added_at"}

            fetched = (await c.get(f"/casebooks/{book['id']}")).json()
            assert [i["id"] for i in fetched["items"]] == [item["id"]]

            r = await c.delete(f"/casebooks/{book['id']}/items/{item['id']}")
            assert r.status_code == 204
            assert (await c.get(f"/casebooks/{book['id']}")).json()["items"] == []
            # The turn and its conversation survived the removal.
            got = await c.get(
                f"/agenttrees/agent1/conversations/{conv['conversation_id']}")
            assert got.status_code == 200
            assert any(t["id"] == conv["turn"]["id"] for t in got.json()["turns"])
            # Removing twice is a 404.
            assert (await c.delete(
                f"/casebooks/{book['id']}/items/{item['id']}")).status_code == 404
    run(case())


def test_adding_the_same_turn_twice_is_idempotent():
    """THE DUPLICATE RULE — "Re-adding the same turn is idempotent (returns
    the existing item)" (openapi.yaml:1744): same id, original note kept."""
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "collect me twice")
            book = await seed_casebook(c)
            body = {"tree": "agent1", "conversation_id": conv["conversation_id"],
                    "turn_id": conv["turn"]["id"], "note": "first note"}
            first = (await c.post(f"/casebooks/{book['id']}/items", json=body)).json()
            r = await c.post(f"/casebooks/{book['id']}/items",
                             json={**body, "note": "second note"})
            assert r.status_code == 201, r.text
            assert r.json() == first  # id, added_at and note all unchanged
            assert len((await c.get(f"/casebooks/{book['id']}")).json()["items"]) == 1
    run(case())


def test_item_endpoints_404_on_unknown_references():
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "real turn")
            book = await seed_casebook(c)
            assert (await c.post("/casebooks/cb_nope/items", json={
                "tree": "agent1", "conversation_id": conv["conversation_id"],
                "turn_id": conv["turn"]["id"]})).status_code == 404
            assert (await c.post(f"/casebooks/{book['id']}/items", json={
                "tree": "agent1", "conversation_id": conv["conversation_id"],
                "turn_id": "turn_nope"})).status_code == 404
            assert (await c.post(f"/casebooks/{book['id']}/items",
                                 json={"tree": "agent1"})).status_code == 422
    run(case())


def test_cross_tree_visibility_omits_items_the_viewer_cannot_see(monkeypatch):
    """"a casebook may reference turns across trees; per-item visibility still
    follows the viewer's tree permissions" (openapi.yaml:1654-1656). Decision:
    OMIT rather than leak — restricted@demo has no agent2 view."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            admin = await login(c)
            one = await chat(c, "agent1", "visible everywhere", **admin)
            two = await chat(c, "agent2", "admin only", **admin)
            r = await c.post("/casebooks", json={"name": "Mixed"}, headers=admin)
            book = r.json()
            for conv, tree in ((one, "agent1"), (two, "agent2")):
                r = await c.post(f"/casebooks/{book['id']}/items", headers=admin, json={
                    "tree": tree, "conversation_id": conv["conversation_id"],
                    "turn_id": conv["turn"]["id"]})
                assert r.status_code == 201, r.text
            assert len((await c.get(f"/casebooks/{book['id']}",
                                    headers=admin)).json()["items"]) == 2

            limited = await login(c, "restricted@demo")
            seen = (await c.get(f"/casebooks/{book['id']}", headers=limited)).json()
            assert [i["tree"] for i in seen["items"]] == ["agent1"]
            assert [i["tree"] for i in
                    (await c.get("/casebooks", headers=limited)).json()[0]["items"]] == ["agent1"]

            # …and the hidden item cannot be added, removed or acted on.
            hidden = [i for i in (await c.get(f"/casebooks/{book['id']}",
                                              headers=admin)).json()["items"]
                      if i["tree"] == "agent2"][0]
            assert (await c.delete(f"/casebooks/{book['id']}/items/{hidden['id']}",
                                   headers=limited)).status_code == 404
            assert (await c.post(f"/casebooks/{book['id']}/items", headers=limited, json={
                "tree": "agent2", "conversation_id": two["conversation_id"],
                "turn_id": two["turn"]["id"]})).status_code == 404
    run(case())


# ------------------------------------------------------------- to-eval-set
def test_to_eval_set_creates_a_set_matching_the_casebook():
    """"For each item the server reuses the existing eval case for that turn
    or creates one sourced from it … then creates a new set (set_name)"
    (openapi.yaml:1784-1789)."""
    async def case():
        async with make_client() as c:
            a = await chat(c, "agent1", "first prompt")
            b = await chat(c, "agent1", "second prompt")
            book = await seed_casebook(c)
            for conv in (a, b):
                await c.post(f"/casebooks/{book['id']}/items", json={
                    "tree": "agent1", "conversation_id": conv["conversation_id"],
                    "turn_id": conv["turn"]["id"]})

            r = await c.post(f"/casebooks/{book['id']}/to-eval-set",
                             json={"set_name": "casebook regression"})
            assert r.status_code == 201, r.text
            eval_set = r.json()
            assert eval_set["name"] == "casebook regression"
            assert eval_set["version"] == 1
            assert len(eval_set["case_ids"]) == 2

            # Membership matches the referenced turns, case by case.
            sources = []
            for cid in eval_set["case_ids"]:
                got = (await c.get(f"/eval/cases/{cid}")).json()
                sources.append(got["source"])
                assert got["input"]["prompt"]
                assert got["output"]
            assert sources == [
                {"tree": "agent1", "conversation_id": a["conversation_id"],
                 "turn_id": a["turn"]["id"]},
                {"tree": "agent1", "conversation_id": b["conversation_id"],
                 "turn_id": b["turn"]["id"]},
            ]
            assert eval_set["id"] in [s["id"] for s in (await c.get("/eval/sets")).json()]
    run(case())


def test_to_eval_set_reuses_an_existing_case_for_the_same_turn():
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "already a case")
            source = {"tree": "agent1", "conversation_id": conv["conversation_id"],
                      "turn_id": conv["turn"]["id"]}
            existing = (await c.post("/eval/cases", json={"source": source})).json()
            book = await seed_casebook(c)
            await c.post(f"/casebooks/{book['id']}/items", json=source)
            r = await c.post(f"/casebooks/{book['id']}/to-eval-set",
                             json={"set_name": "reuse"})
            assert r.json()["case_ids"] == [existing["id"]]
    run(case())


def test_to_eval_set_appends_a_membership_version_to_an_existing_set():
    """"appends a new membership version to an existing one (set_id —
    versioned membership)" (openapi.yaml:1787-1789); a version carries its
    FULL membership, so the earlier cases stay in."""
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "new case")
            handmade = (await c.post("/eval/cases", json={
                "input": {"prompt": "p"}, "output": "o"})).json()
            base = (await c.post("/eval/sets", json={
                "name": "regression", "case_ids": [handmade["id"]]})).json()
            book = await seed_casebook(c)
            await c.post(f"/casebooks/{book['id']}/items", json={
                "tree": "agent1", "conversation_id": conv["conversation_id"],
                "turn_id": conv["turn"]["id"]})

            r = await c.post(f"/casebooks/{book['id']}/to-eval-set",
                             json={"set_id": base["id"]})
            assert r.status_code == 201, r.text
            updated = r.json()
            assert updated["id"] == base["id"]
            assert updated["version"] == 2
            assert updated["name"] == "regression"
            assert updated["case_ids"][0] == handmade["id"]
            assert len(updated["case_ids"]) == 2
    run(case())


def test_to_eval_set_validation():
    async def case():
        async with make_client() as c:
            book = await seed_casebook(c)
            # Empty casebook — nothing to materialize.
            assert (await c.post(f"/casebooks/{book['id']}/to-eval-set",
                                 json={"set_name": "x"})).status_code == 422
            conv = await chat(c, "agent1", "one")
            await c.post(f"/casebooks/{book['id']}/items", json={
                "tree": "agent1", "conversation_id": conv["conversation_id"],
                "turn_id": conv["turn"]["id"]})
            # oneOf: exactly one target (openapi.yaml:3279-3281).
            assert (await c.post(f"/casebooks/{book['id']}/to-eval-set",
                                 json={})).status_code == 422
            assert (await c.post(f"/casebooks/{book['id']}/to-eval-set",
                                 json={"set_name": "a", "set_id": "b"})).status_code == 422
            assert (await c.post(f"/casebooks/{book['id']}/to-eval-set",
                                 json={"set_id": "set_nope"})).status_code == 404
            assert (await c.post("/casebooks/cb_nope/to-eval-set",
                                 json={"set_name": "x"})).status_code == 404
    run(case())


def test_to_eval_set_uses_only_the_items_the_viewer_can_see(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            admin = await login(c)
            one = await chat(c, "agent1", "visible", **admin)
            two = await chat(c, "agent2", "hidden", **admin)
            book = (await c.post("/casebooks", json={"name": "Mixed"},
                                 headers=admin)).json()
            for conv, tree in ((one, "agent1"), (two, "agent2")):
                await c.post(f"/casebooks/{book['id']}/items", headers=admin, json={
                    "tree": tree, "conversation_id": conv["conversation_id"],
                    "turn_id": conv["turn"]["id"]})
            limited = await login(c, "restricted@demo")
            r = await c.post(f"/casebooks/{book['id']}/to-eval-set",
                             headers=limited, json={"set_name": "partial"})
            assert r.status_code == 201, r.text
            assert len(r.json()["case_ids"]) == 1
    run(case())


# ----------------------------------------------------------------- replay
def test_replay_fans_out_one_run_per_tree_under_one_parent_task():
    """CasebookReplayAccepted — "One parent task; one run per tree the
    casebook's items reference" (openapi.yaml:3320-3327)."""
    app = make_app()

    async def case():
        async with client_for(app) as c:
            one = await chat(c, "agent1", "support question")
            two = await chat(c, "agent1", "second support question")
            three = await chat(c, "agent2", "ops question")
            book = await seed_casebook(c)
            for conv, tree in ((one, "agent1"), (two, "agent1"), (three, "agent2")):
                await c.post(f"/casebooks/{book['id']}/items", json={
                    "tree": tree, "conversation_id": conv["conversation_id"],
                    "turn_id": conv["turn"]["id"]})

            r = await c.post(f"/casebooks/{book['id']}/replay",
                             json={"configs": [{"model": "deepseek-v3"}]})
            assert r.status_code == 202, r.text
            accepted = r.json()
            assert set(accepted) == {"task_id", "runs"}
            assert [run_["tree_id"] for run_ in accepted["runs"]] == ["agent1", "agent2"]
            assert len({run_["run_id"] for run_ in accepted["runs"]}) == 2

            # One parent task, children under it, one run each.
            for run_ in accepted["runs"]:
                row = app.state.db.one("SELECT * FROM runs WHERE id = ?",
                                       (run_["run_id"],))
                assert row["task_id"] == accepted["task_id"]
                assert row["tree_id"] == run_["tree_id"]
            children = app.state.db.all(
                "SELECT * FROM tasks WHERE parent_id = ?", (accepted["task_id"],))
            assert len(children) == 2  # one config x two trees

            # The agent1 run carries both of that tree's turns; agent2 one.
            grids = {}
            for run_ in accepted["runs"]:
                got = await c.get(
                    f"/agenttrees/{run_['tree_id']}/runs/{run_['run_id']}")
                assert got.status_code == 200, got.text
                grids[run_["tree_id"]] = got.json()
            assert len(grids["agent1"]["rows"]) == 2
            assert len(grids["agent2"]["rows"]) == 1
            # baseline + one config column
            assert [col["label"] for col in grids["agent1"]["columns"]] == [
                "baseline", "deepseek-v3"]
            assert grids["agent1"]["rows"][0]["cells"][0]["status"] == "done"
    run(case())


def test_replay_finishes_and_fills_both_runs():
    app = make_app()

    async def case():
        async with client_for(app) as c:
            one = await chat(c, "agent1", "a question")
            two = await chat(c, "agent2", "another question")
            book = await seed_casebook(c)
            for conv, tree in ((one, "agent1"), (two, "agent2")):
                await c.post(f"/casebooks/{book['id']}/items", json={
                    "tree": tree, "conversation_id": conv["conversation_id"],
                    "turn_id": conv["turn"]["id"]})
            accepted = (await c.post(f"/casebooks/{book['id']}/replay",
                                     json={"configs": [{}]})).json()
            for _ in range(200):
                task = (await c.get(f"/tasks/{accepted['task_id']}")).json()
                if task["status"] in ("done", "failed", "cancelled"):
                    break
                await asyncio.sleep(0.01)
            assert task["status"] == "done", task
            assert task["result"] == {"runs": accepted["runs"]}
            for run_ in accepted["runs"]:
                grid = (await c.get(
                    f"/agenttrees/{run_['tree_id']}/runs/{run_['run_id']}")).json()
                assert grid["status"] == "done"
                for row in grid["rows"]:
                    assert [cell["status"] for cell in row["cells"]] == ["done", "done"]
                    assert row["cells"][1]["content"]
    run(case())


def test_replay_validation_and_disabled_trees():
    async def case():
        async with make_client() as c:
            book = await seed_casebook(c)
            assert (await c.post(f"/casebooks/{book['id']}/replay",
                                 json={"configs": [{}]})).status_code == 422
            conv = await chat(c, "agent2", "ops")
            await c.post(f"/casebooks/{book['id']}/items", json={
                "tree": "agent2", "conversation_id": conv["conversation_id"],
                "turn_id": conv["turn"]["id"]})
            assert (await c.post(f"/casebooks/{book['id']}/replay",
                                 json={"configs": []})).status_code == 422
            # Context widening is Phase 3; frozen is pinned like tree replay.
            assert (await c.post(f"/casebooks/{book['id']}/replay",
                                 json={"configs": [{}],
                                       "context_policy": "current"})).status_code == 422
            assert (await c.post("/casebooks/cb_nope/replay",
                                 json={"configs": [{}]})).status_code == 404

            await c.patch("/admin/agenttrees/agent2", json={"enabled": False})
            r = await c.post(f"/casebooks/{book['id']}/replay", json={"configs": [{}]})
            assert r.status_code == 409, r.text
            assert r.json()["code"] == "tree_disabled"
    run(case())


def test_replay_accepts_a_user_turn_reference_by_replaying_its_answer():
    """Items may reference either half of an invocation (a ⊞ on the prompt);
    replay regenerates the ASSISTANT turn either way."""
    app = make_app()

    async def case():
        async with client_for(app) as c:
            conv = await chat(c, "agent1", "prompt half")
            user_turn = app.state.db.one(
                "SELECT * FROM turns WHERE conversation_id = ? AND role = 'user'",
                (conv["conversation_id"],))
            book = await seed_casebook(c)
            await c.post(f"/casebooks/{book['id']}/items", json={
                "tree": "agent1", "conversation_id": conv["conversation_id"],
                "turn_id": user_turn["id"]})
            accepted = (await c.post(f"/casebooks/{book['id']}/replay",
                                     json={"configs": [{}]})).json()
            grid = (await c.get(
                f"/agenttrees/agent1/runs/{accepted['runs'][0]['run_id']}")).json()
            assert len(grid["rows"]) == 1
            assert grid["rows"][0]["source"]["turn_id"] == conv["turn"]["id"]
    run(case())
