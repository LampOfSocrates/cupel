"""Inspector + eval-set tests. Run: npm run test:mock.

Contract under test (openapi.yaml v0.3.0):
- :298-348 GET /admin/conversations ("Inspector — every conversation,
  cross-user"; filters user_id/tree/date_from/date_to/score_min/score_max,
  page/page_size; "Requires the inspect role (403 otherwise); EVERY access is
  audit-logged server-side")
- :3129-3155 AdminConversationItem (user_id, user_email, latest_score) +
  AdminConversationPage (items/page/page_size/total)
- GET/POST /eval/sets, GET/PATCH/PUT/DELETE /eval/sets/{setId} — the noun
  Casebook merged into ("A member is either kind, so the collection is both")
- POST /eval/sets/{setId}/items ("IDEMPOTENT: adding a referent the latest
  version already holds appends nothing and returns that version unchanged")
- POST /eval/sets/{setId}/freeze ("reuses the existing eval case for that turn
  or creates one sourced from it … The item keeps its id and its source")
- POST /eval/sets/{setId}/replay ("one evaluation per tree touched, all
  children of a single parent task", EvalSetReplayAccepted)
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



# ================================================================= eval sets
# The merged noun: Casebook folded into EvalSet, so what used to be nine
# /casebooks routes plus three /eval/sets ones is one resource whose members
# carry a kind (reference | frozen). "Materialize the casebook" became
# POST /eval/sets/{id}/freeze flipping items in place.
async def seed_set(c, name="Noteworthy", **kwargs):
    r = await c.post("/eval/sets", json={"name": name}, **kwargs)
    assert r.status_code == 201, r.text
    return r.json()


def ref(conv, tree="agent1", **extra):
    return {"source": {"tree": tree, "conversation_id": conv["conversation_id"],
                       "turn_id": conv["turn"]["id"]}, **extra}


def test_eval_set_crud():
    async def case():
        async with make_client() as c:
            assert (await c.get("/eval/sets")).json() == []
            s = await seed_set(c, "Refund failures")
            assert s["name"] == "Refund failures"
            assert s["items"] == [] and s["description"] is None
            assert s["version"] == 1 and s["created_at"]

            assert [x["id"] for x in (await c.get("/eval/sets")).json()] == [s["id"]]
            assert (await c.get(f"/eval/sets/{s['id']}")).json()["id"] == s["id"]

            r = await c.patch(f"/eval/sets/{s['id']}",
                              json={"name": "Refunds", "description": "worst first"})
            assert r.status_code == 200, r.text
            assert r.json()["name"] == "Refunds"
            assert r.json()["description"] == "worst first"
            # PATCH is metadata only — membership is untouched AND unversioned.
            assert r.json()["items"] == []
            assert r.json()["version"] == 1

            assert (await c.delete(f"/eval/sets/{s['id']}")).status_code == 204
            assert (await c.get(f"/eval/sets/{s['id']}")).status_code == 404
            assert (await c.delete(f"/eval/sets/{s['id']}")).status_code == 404
            assert (await c.get("/eval/sets")).json() == []
    run(case())


def test_create_requires_a_name():
    async def case():
        async with make_client() as c:
            assert (await c.post("/eval/sets", json={})).status_code == 422
    run(case())


def test_reference_items_are_references_only_and_removal_appends_a_version():
    """A reference item is a REFERENCE to a turn, never a copy; removing it
    (PUT with the item left out) touches nothing else."""
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "keep this one")
            s = await seed_set(c)
            r = await c.post(f"/eval/sets/{s['id']}/items",
                             json=ref(conv, note="great answer"))
            assert r.status_code == 201, r.text
            # Adding appends a MEMBERSHIP VERSION — the casebook's free
            # mutation is gone.
            assert r.json()["version"] == 2
            item = r.json()["items"][0]
            assert item["kind"] == "reference"
            assert item["source"] == {"tree": "agent1",
                                      "conversation_id": conv["conversation_id"],
                                      "turn_id": conv["turn"]["id"]}
            assert item["case_id"] is None
            assert item["note"] == "great answer" and item["added_at"]
            # No transcript copy travels with the item.
            assert set(item) == {"id", "kind", "source", "case_id", "note", "added_at"}

            fetched = (await c.get(f"/eval/sets/{s['id']}")).json()
            assert [i["id"] for i in fetched["items"]] == [item["id"]]

            r = await c.put(f"/eval/sets/{s['id']}", json={"items": []})
            assert r.status_code == 201, r.text
            assert r.json()["items"] == [] and r.json()["version"] == 3
            # The turn and its conversation survived the removal.
            got = await c.get(
                f"/agenttrees/agent1/conversations/{conv['conversation_id']}")
            assert got.status_code == 200
            assert any(t["id"] == conv["turn"]["id"] for t in got.json()["turns"])
    run(case())


def test_item_ids_are_stable_across_membership_versions():
    """"the server carries an item's id forward when the new version still
    holds the same referent" — what makes .../freeze able to name an item."""
    async def case():
        async with make_client() as c:
            a = await chat(c, "agent1", "first")
            b = await chat(c, "agent1", "second")
            s = await seed_set(c)
            first = (await c.post(f"/eval/sets/{s['id']}/items", json=ref(a))).json()
            item_id = first["items"][0]["id"]
            after = (await c.put(f"/eval/sets/{s['id']}",
                                 json={"items": [ref(b), ref(a)]})).json()
            assert after["version"] == 3
            assert [i["id"] for i in after["items"]][1] == item_id
            # ...and a referent the previous version did not hold gets a new id.
            assert after["items"][0]["id"] != item_id
    run(case())


def test_adding_the_same_turn_twice_appends_nothing():
    """THE DUPLICATE RULE, restated for versioned membership: "adding a
    referent the latest version already holds appends nothing and returns
    that version unchanged"."""
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "collect me twice")
            s = await seed_set(c)
            body = ref(conv, note="first note")
            first = (await c.post(f"/eval/sets/{s['id']}/items", json=body)).json()
            r = await c.post(f"/eval/sets/{s['id']}/items",
                             json={**body, "note": "second note"})
            assert r.status_code == 201, r.text
            assert r.json() == first  # same version, same id, original note
            assert len((await c.get(f"/eval/sets/{s['id']}")).json()["items"]) == 1
    run(case())


def test_item_endpoints_404_on_unknown_references():
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "real turn")
            s = await seed_set(c)
            assert (await c.post("/eval/sets/set_nope/items",
                                 json=ref(conv))).status_code == 404
            assert (await c.post(f"/eval/sets/{s['id']}/items", json={"source": {
                "tree": "agent1", "conversation_id": conv["conversation_id"],
                "turn_id": "turn_nope"}})).status_code == 404
            assert (await c.post(f"/eval/sets/{s['id']}/items",
                                 json={"source": {"tree": "agent1"}})).status_code == 422
            # oneOf: a member points at a turn or at a case, never both/neither.
            assert (await c.post(f"/eval/sets/{s['id']}/items",
                                 json={})).status_code == 422
            assert (await c.post(f"/eval/sets/{s['id']}/items",
                                 json={**ref(conv), "case_id": "case_x"})).status_code == 422
            assert (await c.post(f"/eval/sets/{s['id']}/items",
                                 json={"case_id": "case_nope"})).status_code == 404
    run(case())


def test_a_set_holds_references_and_frozen_cases_side_by_side():
    """The whole point of the merge: one collection, two kinds of member."""
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "live turn")
            handmade = (await c.post("/eval/cases", json={
                "input": {"prompt": "p"}, "output": "o"})).json()
            s = await seed_set(c)
            await c.post(f"/eval/sets/{s['id']}/items", json=ref(conv))
            r = await c.post(f"/eval/sets/{s['id']}/items",
                             json={"case_id": handmade["id"]})
            assert r.status_code == 201, r.text
            assert [i["kind"] for i in r.json()["items"]] == ["reference", "frozen"]
            assert r.json()["items"][1]["case_id"] == handmade["id"]
            assert r.json()["items"][1]["source"] is None
    run(case())


def test_cross_tree_visibility_omits_items_the_viewer_cannot_see(monkeypatch):
    """A set may reference turns across trees; per-item visibility still
    follows the viewer's tree permissions. Decision: OMIT rather than leak —
    restricted@demo has no agent2 view."""
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            admin = await login(c)
            one = await chat(c, "agent1", "visible everywhere", **admin)
            two = await chat(c, "agent2", "admin only", **admin)
            s = await seed_set(c, "Mixed", headers=admin)
            for conv, tree in ((one, "agent1"), (two, "agent2")):
                r = await c.post(f"/eval/sets/{s['id']}/items", headers=admin,
                                 json=ref(conv, tree))
                assert r.status_code == 201, r.text
            assert len((await c.get(f"/eval/sets/{s['id']}",
                                    headers=admin)).json()["items"]) == 2

            limited = await login(c, "restricted@demo")
            seen = (await c.get(f"/eval/sets/{s['id']}", headers=limited)).json()
            assert [i["source"]["tree"] for i in seen["items"]] == ["agent1"]
            assert [i["source"]["tree"] for i in
                    (await c.get("/eval/sets", headers=limited)).json()[0]["items"]] == ["agent1"]

            # ...and the hidden item cannot be added or acted on.
            assert (await c.post(f"/eval/sets/{s['id']}/items", headers=limited,
                                 json=ref(two, "agent2"))).status_code == 404

            # Omitting must not become DELETING: a PUT from the partially
            # permitted viewer preserves what they were never shown.
            r = await c.put(f"/eval/sets/{s['id']}", headers=limited,
                            json={"items": [ref(one)]})
            assert r.status_code == 201, r.text
            assert [i["source"]["tree"] for i in r.json()["items"]] == ["agent1"]
            full = (await c.get(f"/eval/sets/{s['id']}", headers=admin)).json()
            assert sorted(i["source"]["tree"] for i in full["items"]) == ["agent1", "agent2"]
    run(case())


# ----------------------------------------------------------------- freeze
def test_freeze_turns_references_into_cases_in_place():
    """"the server reuses the existing eval case for that turn or creates one
    sourced from it ... The item keeps its id and its source"."""
    async def case():
        async with make_client() as c:
            a = await chat(c, "agent1", "first prompt")
            b = await chat(c, "agent1", "second prompt")
            s = await seed_set(c)
            for conv in (a, b):
                await c.post(f"/eval/sets/{s['id']}/items", json=ref(conv))
            before = (await c.get(f"/eval/sets/{s['id']}")).json()

            r = await c.post(f"/eval/sets/{s['id']}/freeze", json={})
            assert r.status_code == 201, r.text
            frozen = r.json()
            assert frozen["id"] == s["id"]
            assert frozen["version"] == before["version"] + 1
            assert [i["kind"] for i in frozen["items"]] == ["frozen", "frozen"]
            # Ids and provenance survive the freeze.
            assert [i["id"] for i in frozen["items"]] == [i["id"] for i in before["items"]]
            assert [i["source"] for i in frozen["items"]] == [i["source"] for i in before["items"]]

            # Each case matches the turn it froze from.
            sources = []
            for item in frozen["items"]:
                got = (await c.get(f"/eval/cases/{item['case_id']}")).json()
                sources.append(got["source"])
                assert got["input"]["prompt"]
                assert got["output"]
            assert sources == [
                {"tree": "agent1", "conversation_id": a["conversation_id"],
                 "turn_id": a["turn"]["id"]},
                {"tree": "agent1", "conversation_id": b["conversation_id"],
                 "turn_id": b["turn"]["id"]},
            ]
            # The earlier version still reads as references — append-only.
            assert [i["kind"] for i in before["items"]] == ["reference", "reference"]
    run(case())


def test_freeze_reuses_an_existing_case_for_the_same_turn():
    async def case():
        async with make_client() as c:
            conv = await chat(c, "agent1", "already a case")
            source = {"tree": "agent1", "conversation_id": conv["conversation_id"],
                      "turn_id": conv["turn"]["id"]}
            existing = (await c.post("/eval/cases", json={"source": source})).json()
            s = await seed_set(c)
            await c.post(f"/eval/sets/{s['id']}/items", json={"source": source})
            r = await c.post(f"/eval/sets/{s['id']}/freeze", json={})
            assert [i["case_id"] for i in r.json()["items"]] == [existing["id"]]
    run(case())


def test_freeze_can_name_a_subset_and_leaves_the_rest_alone():
    async def case():
        async with make_client() as c:
            a = await chat(c, "agent1", "freeze me")
            b = await chat(c, "agent1", "leave me live")
            s = await seed_set(c)
            await c.post(f"/eval/sets/{s['id']}/items", json=ref(a))
            latest = (await c.post(f"/eval/sets/{s['id']}/items", json=ref(b))).json()
            target = latest["items"][0]["id"]
            r = await c.post(f"/eval/sets/{s['id']}/freeze", json={"item_ids": [target]})
            assert r.status_code == 201, r.text
            assert [i["kind"] for i in r.json()["items"]] == ["frozen", "reference"]
    run(case())


def test_freeze_validation():
    async def case():
        async with make_client() as c:
            s = await seed_set(c)
            # Empty set — nothing to freeze.
            assert (await c.post(f"/eval/sets/{s['id']}/freeze",
                                 json={})).status_code == 422
            handmade = (await c.post("/eval/cases", json={
                "input": {"prompt": "p"}, "output": "o"})).json()
            await c.post(f"/eval/sets/{s['id']}/items", json={"case_id": handmade["id"]})
            # Every item already frozen — still nothing to do, and no empty
            # version is appended for it.
            assert (await c.post(f"/eval/sets/{s['id']}/freeze",
                                 json={})).status_code == 422
            assert (await c.get(f"/eval/sets/{s['id']}")).json()["version"] == 2
            assert (await c.post(f"/eval/sets/{s['id']}/freeze",
                                 json={"item_ids": ["esi_nope"]})).status_code == 404
            assert (await c.post("/eval/sets/set_nope/freeze",
                                 json={})).status_code == 404
    run(case())


def test_freeze_uses_only_the_items_the_viewer_can_see(monkeypatch):
    monkeypatch.setenv("AUTH_MODE", "on")

    async def case():
        async with make_client() as c:
            admin = await login(c)
            one = await chat(c, "agent1", "visible", **admin)
            two = await chat(c, "agent2", "hidden", **admin)
            s = await seed_set(c, "Mixed", headers=admin)
            for conv, tree in ((one, "agent1"), (two, "agent2")):
                await c.post(f"/eval/sets/{s['id']}/items", headers=admin,
                             json=ref(conv, tree))
            limited = await login(c, "restricted@demo")
            r = await c.post(f"/eval/sets/{s['id']}/freeze", headers=limited, json={})
            assert r.status_code == 201, r.text
            assert [i["kind"] for i in r.json()["items"]] == ["frozen"]
            # The hidden item is still there, still a reference.
            full = (await c.get(f"/eval/sets/{s['id']}", headers=admin)).json()
            assert sorted(i["kind"] for i in full["items"]) == ["frozen", "reference"]
    run(case())


# --------------------------------------------------------- judging a set
def test_judging_a_set_resolves_reference_items_to_cases():
    """"judging resolves each item to a case ... but it does NOT alter
    membership: the item stays a reference until someone freezes it"."""
    app = make_app()

    async def case():
        async with client_for(app) as c:
            conv = await chat(c, "agent1", "judge my reference")
            rubric = (await c.post("/eval/rubrics", json={
                "name": "helpful", "prompt": "score it"})).json()
            s = await seed_set(c)
            await c.post(f"/eval/sets/{s['id']}/items", json=ref(conv))
            r = await c.post("/eval/judge", json={
                "set_id": s["id"], "judge_model": "claude-sonnet-5",
                "rubric_id": rubric["id"]})
            assert r.status_code == 202, r.text
            for _ in range(300):
                task = (await c.get(f"/tasks/{r.json()['task_id']}")).json()
                if task["status"] in ("done", "failed", "cancelled"):
                    break
                await asyncio.sleep(0.01)
            assert task["status"] == "done", task
            judged = (await c.get("/eval/judgments")).json()
            assert len(judged) == 1
            # The judgment's subject IS the resolved case (stage C: judging a
            # set resolves each reference item to one, and the case is what the
            # score names).
            assert judged[0]["subject"]["kind"] == "case"
            case_row = (await c.get(f"/eval/cases/{judged[0]['subject']['id']}")).json()
            assert case_row["source"]["turn_id"] == conv["turn"]["id"]
            # Membership is untouched: still one REFERENCE item, still v2.
            after = (await c.get(f"/eval/sets/{s['id']}")).json()
            assert after["version"] == 2
            assert [i["kind"] for i in after["items"]] == ["reference"]
    run(case())


def test_judging_pins_a_membership_version():
    async def case():
        async with make_client() as c:
            rubric = (await c.post("/eval/rubrics", json={
                "name": "r", "prompt": "p"})).json()
            handmade = (await c.post("/eval/cases", json={
                "input": {"prompt": "p"}, "output": "o"})).json()
            s = await seed_set(c)
            await c.post(f"/eval/sets/{s['id']}/items", json={"case_id": handmade["id"]})
            # v1 was empty, so pinning it has nothing to judge; v2 has the case.
            assert (await c.post("/eval/judge", json={
                "set_id": s["id"], "set_version": 1, "judge_model": "m",
                "rubric_id": rubric["id"]})).status_code == 422
            assert (await c.post("/eval/judge", json={
                "set_id": s["id"], "set_version": 2, "judge_model": "m",
                "rubric_id": rubric["id"]})).status_code == 202
            assert (await c.post("/eval/judge", json={
                "set_id": s["id"], "set_version": 9, "judge_model": "m",
                "rubric_id": rubric["id"]})).status_code == 404
    run(case())


# ----------------------------------------------------------------- replay
def test_replay_fans_out_one_evaluation_per_tree_under_one_parent_task():
    """EvalSetReplayAccepted — "One parent task; one evaluation per tree the
    set's reference items touch"."""
    app = make_app()

    async def case():
        async with client_for(app) as c:
            one = await chat(c, "agent1", "support question")
            two = await chat(c, "agent1", "second support question")
            three = await chat(c, "agent2", "ops question")
            s = await seed_set(c)
            for conv, tree in ((one, "agent1"), (two, "agent1"), (three, "agent2")):
                await c.post(f"/eval/sets/{s['id']}/items", json=ref(conv, tree))

            r = await c.post(f"/eval/sets/{s['id']}/replay",
                             json={"configs": [{"model": "deepseek-v3"}]})
            assert r.status_code == 202, r.text
            accepted = r.json()
            assert set(accepted) == {"task_id", "evaluations"}
            assert [evaluation["tree_id"] for evaluation in accepted["evaluations"]] == ["agent1", "agent2"]
            assert len({evaluation["evaluation_id"] for evaluation in accepted["evaluations"]}) == 2

            # One parent task, children under it, one evaluation each.
            for evaluation in accepted["evaluations"]:
                row = app.state.db.one("SELECT * FROM evaluations WHERE id = ?",
                                       (evaluation["evaluation_id"],))
                assert row["task_id"] == accepted["task_id"]
                assert row["tree_id"] == evaluation["tree_id"]
            children = app.state.db.all(
                "SELECT * FROM tasks WHERE parent_id = ?", (accepted["task_id"],))
            assert len(children) == 2  # one config x two trees

            # The agent1 evaluation carries both of that tree's turns; agent2 one.
            grids = {}
            for evaluation in accepted["evaluations"]:
                got = await c.get(
                    f"/agenttrees/{evaluation['tree_id']}/evaluations/{evaluation['evaluation_id']}")
                assert got.status_code == 200, got.text
                grids[evaluation["tree_id"]] = got.json()
            assert len(grids["agent1"]["rows"]) == 2
            assert len(grids["agent2"]["rows"]) == 1
            # baseline + one config column
            assert [col["label"] for col in grids["agent1"]["columns"]] == [
                "baseline", "deepseek-v3"]
            assert grids["agent1"]["rows"][0]["cells"][0]["status"] == "done"
    run(case())


def test_replay_finishes_and_fills_both_evaluations():
    app = make_app()

    async def case():
        async with client_for(app) as c:
            one = await chat(c, "agent1", "a question")
            two = await chat(c, "agent2", "another question")
            s = await seed_set(c)
            for conv, tree in ((one, "agent1"), (two, "agent2")):
                await c.post(f"/eval/sets/{s['id']}/items", json=ref(conv, tree))
            accepted = (await c.post(f"/eval/sets/{s['id']}/replay",
                                     json={"configs": [{}]})).json()
            for _ in range(200):
                task = (await c.get(f"/tasks/{accepted['task_id']}")).json()
                if task["status"] in ("done", "failed", "cancelled"):
                    break
                await asyncio.sleep(0.01)
            assert task["status"] == "done", task
            assert task["result"] == {"evaluations": accepted["evaluations"]}
            for evaluation in accepted["evaluations"]:
                grid = (await c.get(
                    f"/agenttrees/{evaluation['tree_id']}/evaluations/{evaluation['evaluation_id']}")).json()
                assert grid["status"] == "done"
                for row in grid["rows"]:
                    assert [cell["status"] for cell in row["cells"]] == ["done", "done"]
                    assert row["cells"][1]["content"]
    run(case())


def test_replay_skips_frozen_items():
    """"Frozen items are skipped: a frozen case is content, not a turn in a
    conversation, so there is nothing to re-fire"."""
    async def case():
        async with make_client() as c:
            handmade = (await c.post("/eval/cases", json={
                "input": {"prompt": "p"}, "output": "o"})).json()
            s = await seed_set(c)
            await c.post(f"/eval/sets/{s['id']}/items", json={"case_id": handmade["id"]})
            assert (await c.post(f"/eval/sets/{s['id']}/replay",
                                 json={"configs": [{}]})).status_code == 422
            conv = await chat(c, "agent1", "replayable")
            await c.post(f"/eval/sets/{s['id']}/items", json=ref(conv))
            r = await c.post(f"/eval/sets/{s['id']}/replay", json={"configs": [{}]})
            assert r.status_code == 202, r.text
            grid = (await c.get(
                f"/agenttrees/agent1/evaluations/{r.json()['evaluations'][0]['evaluation_id']}")).json()
            assert len(grid["rows"]) == 1  # the frozen case contributed no row
    run(case())


def test_replay_validation_and_disabled_trees():
    async def case():
        async with make_client() as c:
            s = await seed_set(c)
            assert (await c.post(f"/eval/sets/{s['id']}/replay",
                                 json={"configs": [{}]})).status_code == 422
            conv = await chat(c, "agent2", "ops")
            await c.post(f"/eval/sets/{s['id']}/items", json=ref(conv, "agent2"))
            assert (await c.post(f"/eval/sets/{s['id']}/replay",
                                 json={"configs": []})).status_code == 422
            # Context widening is Phase 3; frozen is pinned like tree replay.
            assert (await c.post(f"/eval/sets/{s['id']}/replay",
                                 json={"configs": [{}],
                                       "context_policy": "current"})).status_code == 422
            assert (await c.post("/eval/sets/set_nope/replay",
                                 json={"configs": [{}]})).status_code == 404

            await c.patch("/admin/agenttrees/agent2", json={"enabled": False})
            r = await c.post(f"/eval/sets/{s['id']}/replay", json={"configs": [{}]})
            assert r.status_code == 409, r.text
            assert r.json()["code"] == "tree_disabled"
    run(case())


def test_replay_accepts_a_user_turn_reference_by_replaying_its_answer():
    """Items may reference either half of an invocation (a collect on the
    prompt); replay regenerates the ASSISTANT turn either way."""
    app = make_app()

    async def case():
        async with client_for(app) as c:
            conv = await chat(c, "agent1", "prompt half")
            user_turn = app.state.db.one(
                "SELECT * FROM turns WHERE conversation_id = ? AND role = 'user'",
                (conv["conversation_id"],))
            s = await seed_set(c)
            await c.post(f"/eval/sets/{s['id']}/items", json={"source": {
                "tree": "agent1", "conversation_id": conv["conversation_id"],
                "turn_id": user_turn["id"]}})
            accepted = (await c.post(f"/eval/sets/{s['id']}/replay",
                                     json={"configs": [{}]})).json()
            grid = (await c.get(
                f"/agenttrees/agent1/evaluations/{accepted['evaluations'][0]['evaluation_id']}")).json()
            assert len(grid["rows"]) == 1
            assert grid["rows"][0]["source"]["turn_id"] == conv["turn"]["id"]
    run(case())
