"""Generator tests: writes only via the public API (httpx against the
in-process ASGI app), deterministic per --seed, idempotent re-seed, drip
appends activity. Run: npm run test:mock."""

import ast
import asyncio
import pathlib
import time

import httpx

import mock.generator as generator_module
from mock.generator import RUBRICS, Generator
from mock.main import create_app


def make_client():
    app = create_app(db_path=":memory:", token_delay=0, step_delay=0)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


def run(coro):
    return asyncio.run(coro)


async def settle(c, timeout=20):
    """Wait until no top-level task is queued/running (drip fires and forgets)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        tasks = (await c.get("/tasks", params={"page_size": 200})).json()["items"]
        if all(t["status"] in ("done", "failed", "cancelled") for t in tasks):
            return
        await asyncio.sleep(0.05)
    raise AssertionError("tasks did not settle")


async def roots(c, tree):
    r = await c.get(f"/agenttrees/{tree}/conversations", params={"page_size": 100})
    return r.json()


async def snapshot(c):
    """Countable state the seed's idempotency must hold constant."""
    out = {}
    for tree in ("agent1", "agent2"):
        page = await roots(c, tree)
        out[f"{tree}_convs"] = page["total"]
        out[f"{tree}_forks"] = sum(i["fork_count"] for i in page["items"])
        out[f"{tree}_runs"] = len((await c.get(f"/agenttrees/{tree}/evaluations")).json()["items"])
    out["rubrics"] = len((await c.get("/eval/rubrics")).json()["items"])
    out["judgments"] = len((await c.get("/eval/judgments",
                                        params={"page_size": 200})).json()["items"])
    return out


# ------------------------------------------------------- no-direct-DB (code review)
def test_generator_writes_only_via_http():
    """Invariant (feature-spec.md:181): 'never directly to
    the DB'. The module must speak httpx and import nothing from mock."""
    src = pathlib.Path(generator_module.__file__).read_text(encoding="utf-8")
    mods = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Import):
            mods |= {alias.name for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            mods.add("." * node.level + (node.module or ""))
    assert "httpx" in mods
    forbidden = {m for m in mods
                 if m == "sqlite3" or m == "mock" or m.startswith("mock.")
                 or m.startswith(".")}
    assert not forbidden, f"generator must write via HTTP only, found {forbidden}"


# ---------------------------------------------------------------- seed mode
def test_seed_twice_same_seed_is_idempotent():
    async def case():
        async with make_client() as c:
            await Generator(c, seed=7, log=lambda *_: None).seed()
            snap1 = await snapshot(c)
            await Generator(c, seed=7, log=lambda *_: None).seed()
            snap2 = await snapshot(c)
            # chat idempotency (client_message_id) + check-before-create held:
            # nothing duplicated on the second run.
            assert snap1 == snap2

            # exactly the 2 rubrics (feature-spec.md:164 "judgments across 2 rubrics")
            rubrics = (await c.get("/eval/rubrics")).json()["items"]
            assert {r["name"] for r in rubrics} == {name for name, _ in RUBRICS}
            assert len(rubrics) == 2

            # forks exist and carry lineage back to the parent turn
            page = await roots(c, "agent1")
            parents = [i for i in page["items"] if i["fork_count"] > 0]
            assert parents
            forks = (await c.get("/agenttrees/agent1/conversations",
                                 params={"forks_of": parents[0]["id"]})).json()
            assert forks["total"] >= 1
            for f in forks["items"]:
                assert f["lineage"]["parent_conversation_id"] == parents[0]["id"]
                assert f["lineage"]["fork_turn_id"]

            # >= 1 replay evaluation done with judged cells, across both rubric ids
            judged_cells = 0
            for tree in ("agent1", "agent2"):
                for r in (await c.get(f"/agenttrees/{tree}/evaluations")).json()["items"]:
                    if r["status"] != "done":
                        continue
                    detail = (await c.get(f"/agenttrees/{tree}/evaluations/{r['id']}")).json()
                    judged_cells += sum(
                        1 for row in detail["rows"]["items"] for cell in row["cells"]
                        if cell["latest_score"] is not None)
            assert judged_cells >= 1
            llm = [x for x in (await c.get("/eval/judgments",
                                           params={"page_size": 200})).json()["items"]
                   if x["scorer"]["kind"] == "llm"]
            assert len({x["scorer"]["ref"] for x in llm}) == 2

            # every generated conversation is machine-origin with channel+author
            for tree in ("agent1", "agent2"):
                page = await roots(c, tree)
                assert page["total"] >= 6
                for item in page["items"]:
                    assert item["origin"] == "machine"
                    assert item["channel"] == "generator"
                    turns = (await c.get(
                        f"/agenttrees/{tree}/conversations/{item['id']}/turns",
                        params={"page_size": 200})).json()["items"]
                    user_turns = [t for t in turns if t["role"] == "user"]
                    assert user_turns
                    assert all(t["author"].startswith("gen-persona-")
                               for t in user_turns)
    run(case())


def test_seed_deterministic_across_fresh_dbs():
    async def titles(seed):
        async with make_client() as c:
            await Generator(c, seed=seed, log=lambda *_: None).seed()
            out = []
            for tree in ("agent1", "agent2"):
                page = await roots(c, tree)
                out += sorted(i["title"] for i in page["items"])
            return out

    a = run(titles(5))
    b = run(titles(5))
    other = run(titles(9))
    assert a == b  # same seed, fresh DBs -> identical title multiset
    assert a != other  # different seed -> different dataset
    assert len(a) == 20


# ---------------------------------------------------------------- drip mode
def test_drip_appends_activity_through_public_api():
    async def case():
        async with make_client() as c:
            before = len((await c.get("/tasks", params={"page_size": 200})).json()["items"])
            gen = Generator(c, seed=3, log=lambda *_: None)
            await gen.drip(interval=0, iterations=4)
            await settle(c)
            tasks = (await c.get("/tasks", params={"page_size": 200})).json()["items"]
            assert len(tasks) > before  # activity flowed through the task queue
            total = 0
            for tree in ("agent1", "agent2"):
                page = await roots(c, tree)
                total += page["total"]
                for item in page["items"]:
                    assert item["origin"] == "machine"
                    assert item["channel"] == "generator"
            assert total >= 1
    run(case())
