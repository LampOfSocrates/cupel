"""Behavioural tests: chat both modes, SSE, task lifecycle, SQLite
state, forks/lineage, append-only invariants. Run: npm run test:mock."""

import asyncio
import json
import time

import httpx
import pytest

from mock.main import create_app
from mock.tests import with_turns


class StreamingASGITransport(httpx.AsyncBaseTransport):
    """httpx's bundled ASGITransport buffers the whole body before returning,
    which deadlocks on infinite SSE (/tasks/stream) and defeats mid-stream
    cancellation — so run the app as a background task and stream chunks."""

    def __init__(self, app):
        self.app = app

    async def handle_async_request(self, request):
        body = await request.aread()
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": request.method,
            "headers": [(k.lower(), v) for k, v in request.headers.raw],
            "scheme": request.url.scheme, "path": request.url.path,
            "raw_path": request.url.raw_path.split(b"?")[0],
            "query_string": request.url.query,
            "server": (request.url.host, request.url.port),
            "client": ("127.0.0.1", 123), "root_path": "",
        }
        body_sent = False
        disconnect = asyncio.Event()
        chunks: asyncio.Queue = asyncio.Queue()
        started: dict = {}
        started_ev = asyncio.Event()

        async def receive():
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            await disconnect.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.start":
                started["status"] = message["status"]
                started["headers"] = message.get("headers", [])
                started_ev.set()
            elif message["type"] == "http.response.body":
                if message.get("body"):
                    chunks.put_nowait(message["body"])
                if not message.get("more_body", False):
                    chunks.put_nowait(None)

        app_task = asyncio.create_task(self.app(scope, receive, send))
        app_task.add_done_callback(lambda t: (chunks.put_nowait(None), started_ev.set()))
        await started_ev.wait()
        if "status" not in started:
            exc = app_task.exception()
            raise exc if exc else RuntimeError("ASGI app finished without a response")

        class Stream(httpx.AsyncByteStream):
            async def __aiter__(self):
                while True:
                    chunk = await chunks.get()
                    if chunk is None:
                        break
                    yield chunk
                if app_task.done() and app_task.exception():
                    raise app_task.exception()

            async def aclose(self):
                disconnect.set()
                try:
                    await asyncio.wait_for(asyncio.shield(app_task), timeout=5)
                except (asyncio.TimeoutError, Exception):
                    app_task.cancel()

        return httpx.Response(started["status"], headers=started["headers"], stream=Stream())


def client_pair():
    app = create_app(db_path=":memory:", token_delay=0.01, step_delay=0.01)
    return httpx.AsyncClient(transport=StreamingASGITransport(app), base_url="http://t")


def run(coro):
    return asyncio.run(coro)


async def wait_task(c, task_id, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = await c.get(f"/tasks/{task_id}")
        assert r.status_code == 200
        task = r.json()
        if task["status"] in ("done", "failed", "cancelled"):
            return task
        await asyncio.sleep(0.03)
    raise AssertionError(f"task {task_id} did not finish: {task}")


async def seed_conversation(c, tree="agent1", n=2):
    conv_id = None
    for i in range(n):
        r = await c.post(f"/agenttrees/{tree}/chat", json={
            "message": f"Question {i}: how do replays stay comparable?",
            "conversation_id": conv_id, "stream": False,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        conv_id = body["conversation_id"]
        await wait_task(c, body["task_id"])
    return conv_id


def parse_sse(chunks: str):
    events = []
    for frame in chunks.split("\n\n"):
        lines = [ln for ln in frame.split("\n") if ln]
        if not lines or lines[0].startswith(":"):
            continue
        event = next((ln[7:] for ln in lines if ln.startswith("event: ")), None)
        data = next((ln[6:] for ln in lines if ln.startswith("data: ")), None)
        if event:
            events.append((event, json.loads(data)))
    return events


# ---------------------------------------------------------------- identity/meta
def test_me_healthz_models_trees():
    async def case():
        async with client_pair() as c:
            me = (await c.get("/me")).json()
            assert me["user"]["id"] == "dev"
            assert set(me["permissions"]["agent1"]) == {"view", "tune", "evaluate"}
            hz = (await c.get("/healthz")).json()
            assert hz["status"] == "ok" and hz["seed"]
            assert any(m["id"] == "claude-sonnet-5" for m in (await c.get("/models")).json())
            trees = (await c.get("/agenttrees")).json()
            assert {t["id"] for t in trees} == {"agent1", "agent2"}
            assert all(t["enabled"] for t in trees)
            eps = (await c.get("/agenttrees/agent1/endpoints")).json()
            assert len(eps) >= 2
            assert (await c.get("/agenttrees/nope/endpoints")).status_code == 404
    run(case())


def test_create_tree_and_agent():
    async def case():
        async with client_pair() as c:
            r = await c.post("/agenttrees", json={"id": "agent3", "name": "Third"})
            assert r.status_code == 201 and r.json()["enabled"] is True
            r = await c.post("/agenttrees/agent3/agents", json={"name": "Root3"})
            assert r.status_code == 201
            agent = r.json()
            assert agent["live_version"] == 0 and agent["parent_id"] is None
            assert agent["format"] == "text"
    run(case())


# --------------------------------------------------------------------- agents
def test_instructions_append_only_and_snapshot_promotion():
    async def case():
        async with client_pair() as c:
            hist = (await c.get("/agenttrees/agent1/agents/ag_concierge/instructions")).json()
            assert hist["live_version"] == 3
            assert [v["version"] for v in hist["versions"]] == [1, 2, 3]

            r = await c.put("/agenttrees/agent1/agents/ag_concierge/instructions",
                            json={"content": "v4 text"})
            assert r.status_code == 201 and r.json()["version"] == 4

            snap = (await c.post("/agenttrees/agent1/agents/ag_concierge/snapshots",
                                 json={"content": "draft text", "base_version": 4})).json()
            assert snap["label"].startswith("v4-draft (")

            r = await c.put("/agenttrees/agent1/agents/ag_concierge/instructions",
                            json={"content": "draft text", "snapshot_id": snap["snapshot_id"]})
            v5 = r.json()
            assert v5["version"] == 5
            assert v5["promoted_from_snapshot_id"] == snap["snapshot_id"]

            hist = (await c.get("/agenttrees/agent1/agents/ag_concierge/instructions")).json()
            assert [v["version"] for v in hist["versions"]] == [1, 2, 3, 4, 5]
    run(case())


def test_last_selection_roundtrip():
    async def case():
        async with client_pair() as c:
            empty = (await c.get("/agenttrees/agent1/agents/ag_refunds/last-selection")).json()
            assert empty == {"items": []}
            items = [{"conversation_id": "conv_x", "turn_ids": ["turn_1"]}]
            await c.put("/agenttrees/agent1/agents/ag_refunds/last-selection",
                        json={"items": items})
            got = (await c.get("/agenttrees/agent1/agents/ag_refunds/last-selection")).json()
            assert got["items"] == items
    run(case())


# ----------------------------------------------------------------------- chat
def test_chat_nonstream_persists_conversation_turns_envelope():
    async def case():
        async with client_pair() as c:
            r = await c.post("/agenttrees/agent1/chat",
                             json={"message": "Hello there", "stream": False})
            assert r.status_code == 200
            body = r.json()
            assert body["turn"]["role"] == "assistant"
            assert body["turn"]["content"]
            assert body["turn"]["envelope"]["timezone"] == "Europe/London"

            task = await wait_task(c, body["task_id"])
            assert task["status"] == "done"
            assert task["type"] == "chat"
            assert task["result"]["conversation_id"] == body["conversation_id"]

            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{body['conversation_id']}")
            assert conv["origin"] == "interactive"
            assert conv["agent_id"] == "ag_concierge"
            assert [t["role"] for t in conv["turns"]] == ["user", "assistant"]
            assert all(t["envelope"] for t in conv["turns"])
            assert conv["turns"][1]["author"] == "Concierge"
    run(case())


def test_chat_stream_sse_events():
    async def case():
        async with client_pair() as c:
            collected = ""
            async with c.stream("POST", "/agenttrees/agent1/chat",
                                json={"message": "Stream me", "stream": True}) as r:
                assert r.status_code == 200
                assert r.headers["content-type"].startswith("text/event-stream")
                async for chunk in r.aiter_text():
                    collected += chunk
            events = parse_sse(collected)
            names = [e for e, _ in events]
            assert names[0] == "task" and names[-1] == "done"
            assert names.count("token") > 5
            task_ev = events[0][1]
            assert {"task_id", "conversation_id", "user_turn_id", "assistant_turn_id"} <= set(task_ev)
            done = events[-1][1]
            assert done["status"] == "completed"
            streamed = "".join(d["delta"] for e, d in events if e == "token")
            assert streamed == done["turn"]["content"]
            assert done["turn"]["id"] == task_ev["assistant_turn_id"]
    run(case())


def test_chat_stop_generation_persists_partial():
    async def case():
        async with client_pair() as c:
            collected, task_id = "", None
            async with c.stream("POST", "/agenttrees/agent1/chat",
                                json={"message": "Long answer please", "stream": True}) as r:
                buf = b""
                async for chunk in r.aiter_bytes():
                    buf += chunk
                    text = buf.decode()
                    if task_id is None and '"task_id"' in text:
                        events = parse_sse(text)
                        if events:
                            task_id = events[0][1]["task_id"]
                            # Stop mid-stream (openapi.yaml:472-475).
                            resp = await c.delete(f"/tasks/{task_id}")
                            assert resp.json()["status"] == "cancelled"
                    collected = buf.decode()
            events = parse_sse(collected)
            done = [d for e, d in events if e == "done"]
            assert done and done[0]["status"] == "cancelled"
            partial = done[0]["turn"]
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{events[0][1]['conversation_id']}")
            stored = next(t for t in conv["turns"] if t["id"] == partial["id"])
            assert stored["content"] == partial["content"]
            full_len = len(parse_sse(collected))
            assert stored["content"] is not None
            assert full_len  # partial persisted even though cancelled
    run(case())


def test_chat_idempotent_client_message_id():
    async def case():
        async with client_pair() as c:
            req = {"message": "Only once", "stream": False, "origin": "machine",
                   "author": "mail-scanner", "client_message_id": "cmid-1"}
            first = (await c.post("/agenttrees/agent1/chat", json=req)).json()
            await wait_task(c, first["task_id"])
            second = (await c.post("/agenttrees/agent1/chat", json=req)).json()
            assert second["conversation_id"] == first["conversation_id"]
            assert second["turn"]["id"] == first["turn"]["id"]
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{first['conversation_id']}")
            assert len(conv["turns"]) == 2
            assert conv["origin"] == "machine"
            assert conv["turns"][0]["author"] == "mail-scanner"
    run(case())


def test_upload_and_attach():
    async def case():
        async with client_pair() as c:
            r = await c.post("/upload", files={"file": ("notes.txt", b"hello", "text/plain")})
            assert r.status_code == 201
            att = r.json()
            assert att["filename"] == "notes.txt" and att["size"] == 5

            big = b"x" * (5 * 1024 * 1024 + 1)
            r = await c.post("/upload", files={"file": ("big.bin", big, "application/octet-stream")})
            assert r.status_code == 413

            r = await c.post("/agenttrees/agent1/chat", json={
                "message": "See attachment", "stream": False, "attachments": [att["id"]]})
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{r.json()['conversation_id']}")
            assert conv["turns"][0]["attachments"][0]["id"] == att["id"]
    run(case())


def test_feedback_appends_human_judgment():
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=1)
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{conv_id}")
            turn_id = conv["turns"][1]["id"]
            r = await c.post("/feedback", json={"message_id": turn_id, "rating": "up"})
            assert r.status_code == 201
            judg = r.json()
            assert judg["scorer"]["kind"] == "human" and judg["score"] == 1.0
            # A thumb subjects the TURN and invents no rubric to score it with.
            assert judg["subject"] == {"kind": "turn", "id": turn_id}
            assert judg["scorer"]["ref"] is None and judg["scorer"]["version"] is None
            assert judg["scorer"]["model"] is None and judg["evaluation_id"] is None
            got = (await c.get("/eval/judgments", params={"subject_kind": "turn", "subject_id": turn_id})).json()["items"]
            assert len(got) == 1 and got[0]["id"] == judg["id"]
            assert (await c.post("/feedback",
                                 json={"message_id": "nope", "rating": "up"})).status_code == 404
    run(case())


# The optional FeedbackRequest.comment rides on Judgment.reasoning
# (the same field the LLM judge explains itself in). Bare thumbs are unchanged;
# re-rating APPENDS a second judgment, newest first (openapi.yaml:994).
def test_feedback_comment_stores_as_reasoning_and_appends():
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=1)
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{conv_id}")
            turn_id = conv["turns"][1]["id"]

            # no comment → reasoning stays null, exactly as before
            bare = (await c.post("/feedback",
                                 json={"message_id": turn_id, "rating": "up"})).json()
            assert bare["reasoning"] is None and bare["score"] == 1.0

            # with a comment → stored on reasoning, readable via the history
            r = await c.post("/feedback", json={"message_id": turn_id, "rating": "down",
                                                "comment": "  wrong refund window  "})
            assert r.status_code == 201
            judg = r.json()
            assert judg["scorer"]["kind"] == "human" and judg["score"] == 0.0
            assert judg["reasoning"] == "wrong refund window"  # trimmed
            assert judg["subject"] == {"kind": "turn", "id": turn_id}
            assert judg["scorer"]["ref"] is None

            # append-only: two judgments for the turn, newest first
            got = (await c.get("/eval/judgments", params={"subject_kind": "turn", "subject_id": turn_id})).json()["items"]
            assert [g["id"] for g in got] == [judg["id"], bare["id"]]
            assert [g["reasoning"] for g in got] == ["wrong refund window", None]

            # re-rating with a new comment appends a third — nothing overwritten
            again = (await c.post("/feedback",
                                  json={"message_id": turn_id, "rating": "up",
                                        "comment": "fixed, thanks"})).json()
            got = (await c.get("/eval/judgments", params={"subject_kind": "turn", "subject_id": turn_id})).json()["items"]
            assert len(got) == 3
            assert got[0]["id"] == again["id"] and got[0]["reasoning"] == "fixed, thanks"
            assert got[2]["reasoning"] is None  # the original bare thumb, untouched

            # blank comment is treated as no comment
            blank = (await c.post("/feedback", json={"message_id": turn_id, "rating": "up",
                                                     "comment": "   "})).json()
            assert blank["reasoning"] is None
    run(case())


# -------------------------------------------------------------- conversations
def test_conversation_list_search_rename_delete():
    async def case():
        async with client_pair() as c:
            a = await seed_conversation(c, n=1)
            b = await seed_conversation(c, n=1)
            page = (await c.get("/agenttrees/agent1/conversations")).json()
            assert page["total"] == 2
            assert page["items"][0]["id"] == b  # most recent first
            # Rows are metadata + a count; the transcript is its own
            # collection, so a listing's size no longer scales with how much
            # was said in each conversation.
            assert "turns" not in page["items"][0]
            assert page["items"][0]["turn_count"] == 2

            await c.patch(f"/agenttrees/agent1/conversations/{a}",
                          json={"title": "Zebra refunds"})
            found = (await c.get("/agenttrees/agent1/conversations",
                                 params={"search": "zebra"})).json()
            assert found["total"] == 1 and found["items"][0]["id"] == a

            r = await c.delete(f"/agenttrees/agent1/conversations/{a}")
            assert r.status_code == 204
            assert (await c.get(f"/agenttrees/agent1/conversations/{a}")).status_code == 404
            assert (await c.get("/agenttrees/agent1/conversations")).json()["total"] == 1
    run(case())


def test_soft_delete_preserves_judgments():
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=1)
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{conv_id}")
            turn_id = conv["turns"][1]["id"]
            await c.post("/feedback", json={"message_id": turn_id, "rating": "down"})
            await c.delete(f"/agenttrees/agent1/conversations/{conv_id}")
            got = (await c.get("/eval/judgments", params={"subject_kind": "turn", "subject_id": turn_id})).json()["items"]
            assert len(got) == 1  # judgments survive the tombstone (openapi.yaml:438-443)
    run(case())


# ----------------------------------------------------------------- evaluations
def test_replay_grid_fills_and_children_progress():
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=2)
            r = await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "deepseek-v3"}, {"instruction_version": 2}],
            })
            assert r.status_code == 202
            acc = r.json()
            parent = await wait_task(c, acc["task_id"])
            assert parent["status"] == "done"
            assert parent["progress"] == {"done": 2, "total": 2,
                                          "stage": parent["progress"]["stage"]}
            detail = (await c.get(f"/tasks/{acc['task_id']}")).json()
            assert len(detail["children"]) == 2
            assert all(ch["status"] == "done" for ch in detail["children"])

            evaluation = (await c.get(f"/agenttrees/agent1/evaluations/{acc['evaluation_id']}")).json()
            assert evaluation["status"] == "done"
            assert [col["label"] for col in evaluation["columns"]] == ["baseline", "deepseek-v3", "v2"]
            assert len(evaluation["rows"]["items"]) == 2  # one per assistant turn
            for row in evaluation["rows"]["items"]:
                base, c1, c2 = row["cells"]
                assert base["status"] == "done" and base["content"]
                assert c1["status"] == "done" and c1["content"] and c1["turn_id"]
                assert c2["status"] == "done"
                assert c1["content"] != base["content"]

            listed = (await c.get("/agenttrees/agent1/evaluations")).json()["items"]
            assert listed[0]["id"] == acc["evaluation_id"]

            trace = (await c.get(
                f"/agenttrees/agent1/turns/{evaluation['rows']['items'][0]['cells'][1]['turn_id']}/trace")).json()
            assert trace["spans"]  # replayed turns are traceable
            assert trace["envelope"]  # frozen from the original turn
    run(case())


def test_replay_turn_forks_with_lineage():
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=2)
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{conv_id}")
            fork_turn = conv["turns"][3]  # second assistant turn
            r = await c.post("/agenttrees/agent1/replay/turn", json={
                "conversation_id": conv_id, "turn_id": fork_turn["id"],
                "endpoints": ["ep_agent1_prod", "ep_agent1_staging"],
            })
            assert r.status_code == 202
            acc = r.json()
            assert len(acc["results"]) == 2
            for res in acc["results"]:
                await wait_task(c, res["task_id"])
                fork = await with_turns(c, f"/agenttrees/agent1/conversations/{res['conversation_id']}")
                assert fork["lineage"]["parent_conversation_id"] == conv_id
                assert fork["lineage"]["fork_turn_id"] == fork_turn["id"]
                assert fork["lineage"]["endpoint_id"] == res["endpoint_id"]
                # history copied up to the fork turn, then regenerated
                assert [t["role"] for t in fork["turns"]] == ["user", "assistant", "user", "assistant"]
                assert fork["turns"][-1]["content"] != fork_turn["content"]

            parent_page = (await c.get("/agenttrees/agent1/conversations")).json()
            target = next(i for i in parent_page["items"] if i["id"] == conv_id)
            assert target["fork_count"] == 2
            forks = (await c.get("/agenttrees/agent1/conversations",
                                 params={"forks_of": conv_id})).json()
            assert forks["total"] == 2

            evaluation = (await c.get(f"/agenttrees/agent1/evaluations/{acc['evaluation_id']}")).json()
            assert [col["label"] for col in evaluation["columns"]] == ["baseline", "prod", "staging"]
            assert len(evaluation["rows"]["items"]) == 1
    run(case())


# -------------------------------------------------------- context envelope
# Invariants under test: "The server stamps assistant turns at generation and
# inbound (user/machine) turns at receipt" (openapi.yaml:1323-1325); "Phase 1
# pin — replays always run under each turn's original envelope
# (feature-spec.md:77, :82)" with context_policy enum [frozen]
# (openapi.yaml:1540-1546, :1570-1574).

# Distinctive shape: if a replay freshly stamped instead of reusing the source
# envelope, the patched stamp would leak into the new turn and fail equality.
SENTINEL_ENVELOPE = {"system_date": "1999-01-01", "timezone": "UTC",
                     "region": "US", "locale": "en-US", "user_profile_ref": None}


def test_machine_origin_inbound_turn_envelope_stamped_at_receipt():
    async def case():
        async with client_pair() as c:
            r = await c.post("/agenttrees/agent1/chat", json={
                "message": "order #123 parsed", "stream": False,
                "origin": "machine", "author": "mail-scanner"})
            body = r.json()
            await wait_task(c, body["task_id"])
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{body['conversation_id']}")
            inbound = conv["turns"][0]
            assert inbound["author"] == "mail-scanner"
            env = inbound["envelope"]
            # all four required fields present and non-empty (openapi.yaml:1264)
            assert all(env[k] for k in ("system_date", "timezone", "region", "locale"))
    run(case())


def test_replay_cell_turn_reuses_source_envelope(monkeypatch):
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=1)
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{conv_id}")
            source_env = conv["turns"][1]["envelope"]

            # Any fresh stamp during regeneration would now be the sentinel.
            monkeypatch.setattr("mock.engine.stamp_envelope", lambda: SENTINEL_ENVELOPE)
            acc = (await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "deepseek-v3"}],
            })).json()
            await wait_task(c, acc["task_id"])
            evaluation = (await c.get(f"/agenttrees/agent1/evaluations/{acc['evaluation_id']}")).json()
            cell = evaluation["rows"]["items"][0]["cells"][1]
            trace = (await c.get(
                f"/agenttrees/agent1/turns/{cell['turn_id']}/trace")).json()
            assert trace["envelope"] == source_env  # frozen, not a fresh stamp
            assert trace["envelope"] != SENTINEL_ENVELOPE
    run(case())


def test_replay_turn_fork_reuses_source_envelope(monkeypatch):
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=1)
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{conv_id}")
            fork_turn = conv["turns"][1]

            monkeypatch.setattr("mock.engine.stamp_envelope", lambda: SENTINEL_ENVELOPE)
            acc = (await c.post("/agenttrees/agent1/replay/turn", json={
                "conversation_id": conv_id, "turn_id": fork_turn["id"],
                "endpoints": ["ep_agent1_prod"],
            })).json()
            res = acc["results"][0]
            await wait_task(c, res["task_id"])
            fork = await with_turns(c, f"/agenttrees/agent1/conversations/{res['conversation_id']}")
            regenerated = fork["turns"][-1]
            assert regenerated["id"] != fork_turn["id"]
            assert regenerated["envelope"] == fork_turn["envelope"]  # frozen
            assert regenerated["envelope"] != SENTINEL_ENVELOPE
    run(case())


def test_replay_rejects_non_frozen_context_policy():
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=1)
            r = await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "deepseek-v3"}],
                "context_policy": "current",
            })
            assert r.status_code == 422
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{conv_id}")
            r = await c.post("/agenttrees/agent1/replay/turn", json={
                "conversation_id": conv_id, "turn_id": conv["turns"][1]["id"],
                "endpoints": ["ep_agent1_prod"], "context_policy": "custom",
            })
            assert r.status_code == 422
            # explicit frozen is accepted (the enum's only member)
            r = await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "deepseek-v3"}],
                "context_policy": "frozen",
            })
            assert r.status_code == 202
            await wait_task(c, r.json()["task_id"])
    run(case())


def test_cancel_cascades_to_children():
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=2)
            acc = (await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "a"}, {"model": "b"}, {"model": "c"}],
            })).json()
            await c.delete(f"/tasks/{acc['task_id']}")
            parent = await wait_task(c, acc["task_id"])
            assert parent["status"] == "cancelled"
            children = (await c.get(f"/tasks/{acc['task_id']}")).json()["children"]
            assert all(ch["status"] in ("cancelled", "done") for ch in children)
            assert any(ch["status"] == "cancelled" for ch in children)
    run(case())


# ----------------------------------------------------------------------- eval
def test_rubrics_append_only_versions():
    async def case():
        async with client_pair() as c:
            r1 = (await c.post("/eval/rubrics",
                               json={"name": "Helpfulness", "prompt": "v1"})).json()
            assert (r1["version"], r1["prompt"]) == (1, "v1")
            r2 = (await c.post("/eval/rubrics",
                               json={"name": "Helpfulness", "prompt": "v2"})).json()
            assert r2["id"] == r1["id"] and r2["version"] == 2
            latest = (await c.get("/eval/rubrics")).json()["items"]
            assert len(latest) == 1 and latest[0]["version"] == 2
    run(case())


def test_judge_score_update_is_scoped_to_its_evaluation():
    """docs/review-2026-08-05.md A1 — `UPDATE evaluation_cells SET latest_score = ?
    WHERE case_id = ?` carried no run scope, so judging one run overwrote the
    score on every OTHER run's cell that shares the case. Result.latest_score
    is a per-run denormalization ("score column reads latest judgment per
    (case, rubric)", feature-spec.md:62); it must move only for the run being
    judged."""
    async def case():
        app = create_app(db_path=":memory:", token_delay=0.01, step_delay=0.01)
        async with httpx.AsyncClient(transport=StreamingASGITransport(app),
                                     base_url="http://t") as c:
            conv_id = await seed_conversation(c, n=1)
            evaluation_ids = []
            for _ in range(2):
                acc = (await c.post("/agenttrees/agent1/replay", json={
                    "selection": [{"conversation_id": conv_id}],
                    "configs": [{"model": "deepseek-v3"}],
                })).json()
                await wait_task(c, acc["task_id"])
                evaluation_ids.append(acc["evaluation_id"])

            rubric = (await c.post("/eval/rubrics",
                                   json={"name": "Accuracy", "prompt": "Is it right?"})).json()
            first = (await c.post("/eval/judge", json={
                "evaluation_id": evaluation_ids[0], "judge_model": "claude-haiku-4-5",
                "rubric_id": rubric["id"]})).json()
            await wait_task(c, first["task_id"])
            grid_a = (await c.get(f"/agenttrees/agent1/evaluations/{evaluation_ids[0]}")).json()
            case_id = grid_a["rows"]["items"][0]["cells"][1]["case_id"]
            assert case_id

            # Make the two evaluations share the case. No endpoint attaches an
            # existing case to a cell (cases are auto-created per cell,
            # openapi.yaml:938-941), so the sharing is planted directly — the
            # defect under test is the UPDATE's scope, not how cells are paired.
            app.state.db.run(
                "UPDATE evaluation_cells SET case_id = ?, latest_score = NULL"
                " WHERE evaluation_id = ? AND row_idx = 0 AND col_idx = 1",
                (case_id, evaluation_ids[1]))

            second = (await c.post("/eval/judge", json={
                "evaluation_id": evaluation_ids[0], "judge_model": "claude-sonnet-5",
                "rubric_id": rubric["id"]})).json()
            await wait_task(c, second["task_id"])

            judged = (await c.get(f"/agenttrees/agent1/evaluations/{evaluation_ids[0]}")).json()
            untouched = (await c.get(f"/agenttrees/agent1/evaluations/{evaluation_ids[1]}")).json()
            assert judged["rows"]["items"][0]["cells"][1]["latest_score"] is not None
            assert untouched["rows"]["items"][0]["cells"][1]["latest_score"] is None
    run(case())


def test_judge_evaluation_auto_cases_judgments_summary():
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=2)
            acc = (await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "deepseek-v3"}],
            })).json()
            await wait_task(c, acc["task_id"])
            rubric = (await c.post("/eval/rubrics",
                                   json={"name": "Accuracy", "prompt": "Is it right?"})).json()
            jr = await c.post("/eval/judge", json={
                "evaluation_id": acc["evaluation_id"], "judge_model": "claude-haiku-4-5",
                "rubric_id": rubric["id"]})
            assert jr.status_code == 202
            await wait_task(c, jr.json()["task_id"])

            evaluation = (await c.get(f"/agenttrees/agent1/evaluations/{acc['evaluation_id']}")).json()
            scored = [row["cells"][1] for row in evaluation["rows"]["items"]]
            assert all(cell["case_id"] for cell in scored)
            assert all(cell["latest_score"] is not None for cell in scored)

            case_doc = (await c.get(f"/eval/cases/{scored[0]['case_id']}")).json()
            assert case_doc["input"]["prompt"]
            assert case_doc["source"]["conversation_id"] == conv_id

            judgments = (await c.get("/eval/judgments",
                                     params={"evaluation_id": acc["evaluation_id"]})).json()["items"]
            assert len(judgments) == 2
            assert all(j_["scorer"]["kind"] == "llm" and j_["scorer"]["version"] == 1
                       and j_["subject"]["kind"] == "case" for j_ in judgments)

            # Re-judging appends, never overwrites (openapi.yaml:962-969).
            jr2 = (await c.post("/eval/judge", json={
                "evaluation_id": acc["evaluation_id"], "judge_model": "claude-haiku-4-5",
                "rubric_id": rubric["id"]})).json()
            await wait_task(c, jr2["task_id"])
            judgments2 = (await c.get("/eval/judgments",
                                      params={"evaluation_id": acc["evaluation_id"]})).json()["items"]
            assert len(judgments2) == 4

            summary = (await c.get(f"/eval/evaluations/{acc['evaluation_id']}/summary")).json()
            group = summary["scorers"][0]
            assert group["scorer"] == {"kind": "llm", "ref": rubric["id"],
                                       "version": 1, "model": None}
            assert group["count"] == 4
            assert sum(group["distribution"]) == 4
            assert 0 <= group["mean"] <= 1.01

            bad = await c.post("/eval/judge", json={
                "judge_model": "m", "rubric_id": rubric["id"]})
            assert bad.status_code == 422  # exactly one of evaluation_id / case_ids
    run(case())


# --------------------------------------------------------------- tasks stream
def test_tasks_stream_emits_task_progress_span_events():
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=1)
            seen = set()

            async def consume():
                async with c.stream("GET", "/tasks/stream") as r:
                    buf = ""
                    async for chunk in r.aiter_text():
                        buf += chunk
                        for ev, _ in parse_sse(buf):
                            seen.add(ev)
                        if {"task", "progress", "span"} <= seen:
                            return

            async def produce():
                await asyncio.sleep(0.05)
                acc = (await c.post("/agenttrees/agent1/replay", json={
                    "selection": [{"conversation_id": conv_id}],
                    "configs": [{"model": "deepseek-v3"}],
                })).json()
                await wait_task(c, acc["task_id"])

            await asyncio.wait_for(asyncio.gather(consume(), produce()), timeout=20)
            assert {"task", "progress", "span"} <= seen
    run(case())


def test_grid_pages_by_row_and_revalidates_with_an_etag():
    """getEvaluation — one page of the grid, conditional.

    The two claims the contract makes and the polling UI leans on: a page
    number means the same ROWS throughout (the row set is written once at
    creation, only cells change), and an unchanged page answers 304 with no
    body so a poll over a finished grid costs nothing but the round trip."""
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=3)  # 3 assistant turns
            acc = (await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "x"}, {"model": "y"}],
            })).json()
            await wait_task(c, acc["task_id"])
            url = f"/agenttrees/agent1/evaluations/{acc['evaluation_id']}"

            whole = (await c.get(url)).json()
            assert whole["rows"]["total"] == 3
            assert len(whole["columns"]) == 3  # baseline + 2 configs, never paged

            first = await c.get(url, params={"page": 1, "page_size": 2})
            page1 = first.json()
            assert [r["source"]["turn_id"] for r in page1["rows"]["items"]] == [
                r["source"]["turn_id"] for r in whole["rows"]["items"][:2]]
            second = (await c.get(url, params={"page": 2, "page_size": 2})).json()
            assert second["rows"]["page"] == 2 and len(second["rows"]["items"]) == 1

            etag = first.headers["etag"]
            again = await c.get(url, params={"page": 1, "page_size": 2},
                                headers={"If-None-Match": etag})
            assert again.status_code == 304
            assert again.headers["etag"] == etag
            assert again.content == b""
            # The tag is scoped to the URL: another page is a different entity.
            other = await c.get(url, params={"page": 2, "page_size": 2},
                                headers={"If-None-Match": etag})
            assert other.status_code == 200

            # A judgment changes a cell, so the validator must change with it.
            rubric = (await c.post("/eval/rubrics", json={
                "name": "Grid", "prompt": "Score 0-1."})).json()
            judge = (await c.post("/eval/judge", json={
                "evaluation_id": acc["evaluation_id"], "judge_model": "m",
                "rubric_id": rubric["id"]})).json()
            await wait_task(c, judge["task_id"])
            moved = await c.get(url, params={"page": 1, "page_size": 2},
                                headers={"If-None-Match": etag})
            assert moved.status_code == 200
            assert moved.headers["etag"] != etag
    run(case())


def test_turns_are_a_paged_collection_defaulting_to_the_tail():
    """listTurns — the transcript, split off the conversation resource.

    Three properties the contract promises and the UI depends on: an omitted
    page means the LAST page (a reader opens a transcript at its end), rows
    are chronological so page 1 is immutable as the conversation grows, and
    turn_ids fetches named turns without walking the pages."""
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=3)  # 6 turns
            conv = (await c.get(f"/agenttrees/agent1/conversations/{conv_id}")).json()
            assert "turns" not in conv and conv["turn_count"] == 6

            tail = (await c.get(f"/agenttrees/agent1/conversations/{conv_id}/turns",
                                params={"page_size": 2})).json()
            assert tail["total"] == 6 and tail["page"] == 3  # the LAST page
            first = (await c.get(f"/agenttrees/agent1/conversations/{conv_id}/turns",
                                 params={"page_size": 2, "page": 1})).json()
            assert [t["role"] for t in first["items"]] == ["user", "assistant"]
            assert first["items"][0]["created_at"] <= tail["items"][0]["created_at"]

            # Appending never moves page 1 — the whole point of ordering a
            # transcript oldest-first under offset paging.
            page1_ids = [t["id"] for t in first["items"]]
            await seed_conversation(c, n=1)  # unrelated traffic
            await c.post("/agenttrees/agent1/chat", json={
                "message": "one more", "conversation_id": conv_id, "stream": False})
            again = (await c.get(f"/agenttrees/agent1/conversations/{conv_id}/turns",
                                 params={"page_size": 2, "page": 1})).json()
            assert [t["id"] for t in again["items"]] == page1_ids
            assert again["total"] > 6

            picked = (await c.get(f"/agenttrees/agent1/conversations/{conv_id}/turns",
                                  params={"turn_ids": f"{page1_ids[1]},nope"})).json()
            assert [t["id"] for t in picked["items"]] == [page1_ids[1]]
            assert picked["total"] == 1  # the unknown id is ignored, not a 404

            assert (await c.get(
                "/agenttrees/agent1/conversations/ghost/turns")).status_code == 404
    run(case())


def test_every_collection_answers_the_same_page_envelope():
    """One collection shape (openapi.yaml info.description, "Collections").

    The point of the test is that the four keys mean the same thing on every
    listing: `total` counts matches ACROSS pages (not the slice), a
    page_size over the operation's maximum is clamped rather than rejected,
    and page 2 of a 1-per-page walk is disjoint from page 1."""
    async def case():
        async with client_pair() as c:
            await seed_conversation(c, n=1)
            await seed_conversation(c, n=1)
            for path in ("/agenttrees/agent1/conversations", "/tasks", "/eval/sets",
                         "/eval/rubrics", "/eval/judgments", "/admin/users",
                         "/agenttrees/agent1/evaluations"):
                page = (await c.get(path)).json()
                assert set(page) == {"items", "page", "page_size", "total"}, path
                assert page["page"] == 1 and isinstance(page["total"], int), path
                assert len(page["items"]) <= page["page_size"], path
                # Clamped, never rejected — page 0 means the first page.
                assert (await c.get(path, params={"page": 0})).json()["page"] == 1, path

            first = (await c.get("/agenttrees/agent1/conversations",
                                 params={"page": 1, "page_size": 1})).json()
            second = (await c.get("/agenttrees/agent1/conversations",
                                  params={"page": 2, "page_size": 1})).json()
            assert first["total"] == second["total"] >= 2
            assert first["items"][0]["id"] != second["items"][0]["id"]
            # page_size above the declared maximum is clamped to it.
            wide = (await c.get("/agenttrees/agent1/conversations",
                                params={"page_size": 5000})).json()
            assert wide["page_size"] == 100
    run(case())


def test_task_listing_defaults_to_parents():
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=1)
            acc = (await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "x"}],
            })).json()
            await wait_task(c, acc["task_id"])
            top = (await c.get("/tasks")).json()["items"]
            assert all(t["parent_id"] is None for t in top)
            children = (await c.get("/tasks", params={"parent_id": acc["task_id"]})).json()["items"]
            assert children and all(t["parent_id"] == acc["task_id"] for t in children)
            done = (await c.get("/tasks", params={"status": "done"})).json()["items"]
            assert all(t["status"] == "done" for t in done)
            retry = await c.post(f"/tasks/{acc['task_id']}/retry-failed")
            assert retry.status_code == 202
    run(case())


def test_fail_marker_injects_one_failure_then_retry_succeeds(monkeypatch):
    """Failure injection (config.fail_marker): a child whose payload
    mentions MOCK_FAIL_MARKER fails its FIRST attempt only, so retry-failed is
    exercisable end-to-end and deterministically."""
    monkeypatch.setenv("MOCK_FAIL_MARKER", "BOOM-MARKER")

    async def case():
        async with client_pair() as c:
            r = (await c.post("/agenttrees/agent1/chat", json={
                "message": "BOOM-MARKER please fail once", "stream": False,
            })).json()
            await wait_task(c, r["task_id"])
            acc = (await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": r["conversation_id"]}],
                "configs": [{"model": "deepseek-v3"}],
            })).json()
            # Partial failure: the batch itself completes (feature-spec.md:106
            # "failed children don't kill the batch") — the FAILURE is on the
            # child, which is what retry-failed and the UI's retry button read.
            parent = await wait_task(c, acc["task_id"])
            assert parent["status"] == "done"
            children = (await c.get("/tasks", params={"parent_id": acc["task_id"]})).json()["items"]
            assert [ch["status"] for ch in children] == ["failed"]
            assert "injected failure" in children[0]["error"]

            assert (await c.post(f"/tasks/{acc['task_id']}/retry-failed")).status_code == 202
            retried = await wait_task(c, acc["task_id"])
            assert retried["status"] == "done"
    run(case())


def test_evaluation_status_is_derived_from_its_task(monkeypatch):
    """openapi.yaml Evaluation.status (engine.evaluation_status): the field is
    a VIEW of the owning task, so the two can never disagree.

    The partial-failure read is the interesting one — the batch Task stays
    `done` ("failed children don't kill the batch", feature-spec.md:106) while
    the EVALUATION reads `failed`, because a cell it promised was never
    produced. Retrying the failure flips it back to `done` with no other
    write, which is only possible because nothing stores it."""
    monkeypatch.setenv("MOCK_FAIL_MARKER", "BOOM-MARKER")

    async def case():
        async with client_pair() as c:
            r = (await c.post("/agenttrees/agent1/chat", json={
                "message": "BOOM-MARKER derived status", "stream": False,
            })).json()
            await wait_task(c, r["task_id"])
            acc = (await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": r["conversation_id"]}],
                "configs": [{"model": "deepseek-v3"}],
            })).json()
            assert (await wait_task(c, acc["task_id"]))["status"] == "done"

            url = f"/agenttrees/agent1/evaluations/{acc['evaluation_id']}"
            assert (await c.get(url)).json()["status"] == "failed"
            # The summary list derives it through the same function.
            listed = (await c.get("/agenttrees/agent1/evaluations")).json()["items"]
            assert listed[0]["status"] == "failed"

            await c.post(f"/tasks/{acc['task_id']}/retry-failed")
            assert (await wait_task(c, acc["task_id"]))["status"] == "done"
            assert (await c.get(url)).json()["status"] == "done"
    run(case())


def test_evaluation_status_falls_back_to_cells_without_its_task():
    """Case 4 of the derivation: task history pruned out from under an
    evaluation. This mock never deletes a task, so the row is removed by hand
    here — a real backend with a retention policy reaches this state on its
    own, and the contract must not leave it undefined. Cells outlive the task,
    so they answer: all `done` -> done, anything else -> failed."""
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=1)
            acc = (await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "deepseek-v3"}],
            })).json()
            await wait_task(c, acc["task_id"])
            url = f"/agenttrees/agent1/evaluations/{acc['evaluation_id']}"
            db = c._transport.app.state.db
            db.run("DELETE FROM tasks WHERE id = ? OR parent_id = ?",
                   (acc["task_id"], acc["task_id"]))
            assert (await c.get(url)).json()["status"] == "done"

            db.run("UPDATE evaluation_cells SET status = 'pending'"
                   " WHERE evaluation_id = ? AND col_idx = 1", (acc["evaluation_id"],))
            assert (await c.get(url)).json()["status"] == "failed"
    run(case())


def test_fail_marker_is_inert_when_unset(monkeypatch):
    monkeypatch.delenv("MOCK_FAIL_MARKER", raising=False)

    async def case():
        async with client_pair() as c:
            r = (await c.post("/agenttrees/agent1/chat", json={
                "message": "BOOM-MARKER but no marker configured", "stream": False,
            })).json()
            await wait_task(c, r["task_id"])
            acc = (await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": r["conversation_id"]}],
                "configs": [{"model": "deepseek-v3"}],
            })).json()
            assert (await wait_task(c, acc["task_id"]))["status"] == "done"
    run(case())


def test_persistence_across_app_restart(tmp_path):
    async def case():
        db_file = str(tmp_path / "mock.sqlite")
        app1 = create_app(db_path=db_file, token_delay=0, step_delay=0)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app1),
                                     base_url="http://t") as c:
            r = (await c.post("/agenttrees/agent1/chat",
                              json={"message": "persist me", "stream": False})).json()
            conv_id = r["conversation_id"]
        app2 = create_app(db_path=db_file, token_delay=0, step_delay=0)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app2),
                                     base_url="http://t") as c:
            conv = await with_turns(c, f"/agenttrees/agent1/conversations/{conv_id}")
            assert len(conv["turns"]) == 2  # SQLite survives restart
    run(case())
