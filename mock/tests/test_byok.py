"""Live-LLM BYOK tests (docs/deployment.md:17-31).

Hard rules proven here: the key is used in-memory for the request only —
NEVER persisted (sqlite scan), NEVER logged (log/stdout capture); provider
errors and the rate limit fall back to canned content; MOCK_LIVE_DISABLED=1
kills the feature. The provider is ALWAYS a fake httpx.MockTransport —
these tests never call the real OpenRouter.
"""

import asyncio
import json
import logging

import httpx
import pytest

from mock import config, llm
from mock.main import create_app
from mock.util import canned_reply
from mock.tests.test_mock import StreamingASGITransport, parse_sse, run, wait_task

KEY = "sk-or-test-SECRET-key-0451"
HEADERS = {"X-LLM-Key": KEY, "X-LLM-Model": "deepseek/deepseek-chat"}


def make_app():
    app = create_app(db_path=":memory:", token_delay=0.0, step_delay=0.0)
    client = httpx.AsyncClient(transport=StreamingASGITransport(app), base_url="http://t")
    return app, client


def fake_provider(text="LIVE reply.", deltas=None, status=200):
    """OpenRouter stand-in. Returns (transport, calls) — calls records the
    auth header and parsed body of every request the mock made."""
    calls: list[dict] = []

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        calls.append({
            "auth": request.headers.get("authorization"),
            "url": str(request.url),
            "body": body,
        })
        if status != 200:
            return httpx.Response(status, json={"error": {"message": "denied"}})
        if body.get("stream"):
            frames = "".join(
                "data: " + json.dumps({"choices": [{"delta": {"content": d}}]}) + "\n\n"
                for d in (deltas or ["LIVE ", "reply."]))
            return httpx.Response(
                200, headers={"content-type": "text/event-stream"},
                content=(frames + "data: [DONE]\n\n").encode())
        return httpx.Response(200, json={"choices": [{"message": {"content": text}}]})

    return httpx.MockTransport(handler), calls


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.delenv("MOCK_LIVE_DISABLED", raising=False)
    llm.reset_rate_limit()
    yield
    llm.TRANSPORT = None
    llm.reset_rate_limit()


async def chat(c, message, *, stream, headers=None, **extra):
    body = {"message": message, "stream": stream, **extra}
    if not stream:
        r = await c.post("/agenttrees/agent1/chat", json=body, headers=headers or {})
        assert r.status_code == 200, r.text
        payload = r.json()
        await wait_task(c, payload["task_id"])
        return payload
    async with c.stream("POST", "/agenttrees/agent1/chat", json=body,
                        headers=headers or {}) as r:
        assert r.status_code == 200
        raw = "".join([chunk.decode() async for chunk in r.aiter_bytes()])
    return parse_sse(raw)


def scan_sqlite_for(db, needle: str) -> list[str]:
    """Every table, every row, every column — where does the needle appear?"""
    hits = []
    for t in db.all("SELECT name FROM sqlite_master WHERE type = 'table'"):
        for row in db.all(f"SELECT * FROM {t['name']}"):
            for col, val in dict(row).items():
                if isinstance(val, bytes):
                    val = val.decode(errors="replace")
                if val is not None and needle in str(val):
                    hits.append(f"{t['name']}.{col}")
    return hits


# ------------------------------------------------------------------- chat
def test_chat_stream_live_generation_and_span_model():
    llm.TRANSPORT, calls = fake_provider()

    async def case():
        app, c = make_app()
        async with c:
            events = await chat(c, "Hello live", stream=True, headers=HEADERS,
                                temperature=0.3)
            tokens = [d["delta"] for e, d in events if e == "token"]
            assert tokens == ["LIVE ", "reply."]
            done = next(d for e, d in events if e == "done")
            assert done["status"] == "completed"
            assert done["turn"]["content"] == "LIVE reply."
            # provider request shape: Bearer key, capped max_tokens, model +
            # temperature passthrough (docs/deployment.md:26,29)
            assert calls[0]["auth"] == f"Bearer {KEY}"
            assert calls[0]["url"].startswith(config.OPENROUTER_BASE)
            assert calls[0]["body"]["max_tokens"] == config.LIVE_MAX_TOKENS
            assert calls[0]["body"]["model"] == "deepseek/deepseek-chat"
            assert calls[0]["body"]["temperature"] == 0.3
            # llm span records the LIVE model, status ok, no note
            trace = (await c.get(
                f"/agenttrees/agent1/turns/{done['turn']['id']}/trace",
            )).json()
            llm_span = next(s for s in trace["spans"] if s["type"] == "llm")
            assert llm_span["model"] == "deepseek/deepseek-chat"
            assert llm_span["status"] == "ok" and llm_span["error"] is None

    run(case())


def test_chat_nonstream_live_generation():
    llm.TRANSPORT, calls = fake_provider(text="Non-streaming LIVE.")

    async def case():
        app, c = make_app()
        async with c:
            body = await chat(c, "Hello", stream=False, headers=HEADERS)
            conv = (await c.get(
                f"/agenttrees/agent1/conversations/{body['conversation_id']}",
            )).json()
            assert conv["turns"][1]["content"] == "Non-streaming LIVE."
            assert len(calls) == 1
            assert calls[0]["body"]["stream"] is False

    run(case())


def test_no_header_stays_canned_and_never_calls_provider():
    llm.TRANSPORT, calls = fake_provider()

    async def case():
        app, c = make_app()
        async with c:
            body = await chat(c, "Plain question", stream=False)
            conv = (await c.get(
                f"/agenttrees/agent1/conversations/{body['conversation_id']}",
            )).json()
            assert conv["turns"][1]["content"] == canned_reply(
                "Plain question", "Concierge", None)
            assert calls == []

    run(case())


# -------------------------------------------------- never persisted / logged
def test_key_never_persisted_in_sqlite():
    llm.TRANSPORT, _ = fake_provider()

    async def case():
        app, c = make_app()
        async with c:
            await chat(c, "Live turn to persist around", stream=False, headers=HEADERS)
            assert scan_sqlite_for(app.state.db, KEY) == []

    run(case())


def test_key_never_logged(caplog, capsys):
    llm.TRANSPORT, _ = fake_provider()

    async def case():
        app, c = make_app()
        async with c:
            await chat(c, "Quiet please", stream=True, headers=HEADERS)

    with caplog.at_level(logging.DEBUG):
        run(case())
    assert KEY not in caplog.text
    out, err = capsys.readouterr()
    assert KEY not in out and KEY not in err


# ------------------------------------------------------ fallbacks and limits
def test_provider_401_falls_back_to_canned_with_span_note():
    llm.TRANSPORT, calls = fake_provider(status=401)

    async def case():
        app, c = make_app()
        async with c:
            events = await chat(c, "Bad key path", stream=True, headers=HEADERS)
            done = next(d for e, d in events if e == "done")
            # the turn still completes with canned content
            assert done["status"] == "completed"
            assert done["turn"]["content"]
            assert "LIVE" not in done["turn"]["content"]
            task = next(d for e, d in events if e == "task")
            assert (await c.get(f"/tasks/{task['task_id']}")).json()["status"] == "done"
            trace = (await c.get(
                f"/agenttrees/agent1/turns/{done['turn']['id']}/trace",
            )).json()
            llm_span = next(s for s in trace["spans"] if s["type"] == "llm")
            assert llm_span["status"] == "ok"  # turn stays ok by design
            assert "provider_status_401" in llm_span["error"]
            assert KEY not in llm_span["error"]

    run(case())


def test_rate_limit_over_window_serves_canned(monkeypatch):
    monkeypatch.setattr(config, "LIVE_RATE_LIMIT", 1)
    llm.TRANSPORT, calls = fake_provider()

    async def case():
        app, c = make_app()
        async with c:
            first = await chat(c, "One", stream=False, headers=HEADERS)
            second = await chat(c, "Two", stream=False, headers=HEADERS)
            conv1 = (await c.get(
                f"/agenttrees/agent1/conversations/{first['conversation_id']}")).json()
            conv2 = (await c.get(
                f"/agenttrees/agent1/conversations/{second['conversation_id']}")).json()
            assert conv1["turns"][1]["content"] == "LIVE reply."
            assert conv2["turns"][1]["content"] != "LIVE reply."  # canned
            assert len(calls) == 1  # over-limit request never reached the provider
            trace = (await c.get(
                f"/agenttrees/agent1/turns/{conv2['turns'][1]['id']}/trace")).json()
            llm_span = next(s for s in trace["spans"] if s["type"] == "llm")
            assert "rate_limited" in llm_span["error"]

    run(case())


# ------------------------------------------------------------------ /models
def test_models_curated_with_key_static_without():
    async def case():
        app, c = make_app()
        async with c:
            live = (await c.get("/models", headers=HEADERS)).json()
            assert live == config.LIVE_MODELS
            static = (await c.get("/models")).json()
            assert static == config.MODELS

    run(case())


def test_mock_live_disabled_ignores_header(monkeypatch):
    monkeypatch.setenv("MOCK_LIVE_DISABLED", "1")
    llm.TRANSPORT, calls = fake_provider()

    async def case():
        app, c = make_app()
        async with c:
            assert (await c.get("/models", headers=HEADERS)).json() == config.MODELS
            body = await chat(c, "Disabled", stream=False, headers=HEADERS)
            conv = (await c.get(
                f"/agenttrees/agent1/conversations/{body['conversation_id']}")).json()
            assert conv["turns"][1]["content"] == canned_reply("Disabled", "Concierge", None)
            assert calls == []

    run(case())


# ----------------------------------------------------------- replay / judge
def test_replay_children_generate_live_key_in_memory_only():
    llm.TRANSPORT, calls = fake_provider(text="LIVE replayed cell.")

    async def case():
        app, c = make_app()
        async with c:
            # seed a canned conversation first (no key)
            seeded = await chat(c, "Seed for replay", stream=False)
            conv_id = seeded["conversation_id"]
            r = await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": conv_id}],
                "configs": [{"model": "claude-haiku-4-5"}],
                "context_policy": "frozen",
            }, headers=HEADERS)
            assert r.status_code == 202, r.text
            accepted = r.json()
            # key held in-memory for the enqueued work only, keyed by parent
            assert app.state.engine.live_keys[accepted["task_id"]]["key"] == KEY
            # ... and NEVER in the tasks.payload DB column
            for row in app.state.db.all("SELECT payload FROM tasks"):
                assert row["payload"] is None or KEY not in row["payload"]
            await wait_task(c, accepted["task_id"])
            evaluation_doc = (await c.get(
                f"/agenttrees/agent1/evaluations/{accepted['evaluation_id']}")).json()
            cell = evaluation_doc["rows"][0]["cells"][1]
            assert cell["status"] == "done"
            assert cell["content"] == "LIVE replayed cell."
            assert len(calls) == 1
            # cleared once the parent task reached a terminal status
            assert accepted["task_id"] not in app.state.engine.live_keys
            assert scan_sqlite_for(app.state.db, KEY) == []

    run(case())


def test_judge_children_generate_live_reasoning():
    llm.TRANSPORT, calls = fake_provider(text="LIVE judge reasoning.")

    async def case():
        app, c = make_app()
        async with c:
            seeded = await chat(c, "Seed for judging", stream=False)
            r = await c.post("/agenttrees/agent1/replay", json={
                "selection": [{"conversation_id": seeded["conversation_id"]}],
                "configs": [{}], "context_policy": "frozen",
            })
            assert r.status_code == 202
            accepted = r.json()
            await wait_task(c, accepted["task_id"])
            rubric = (await c.post("/eval/rubrics", json={
                "name": "helpfulness",
                "prompt": "Score 0-1 how helpful the response is.",
            })).json()
            jr = await c.post("/eval/judge", json={
                "evaluation_id": accepted["evaluation_id"], "judge_model": "claude-haiku-4-5",
                "rubric_id": rubric["id"],
            }, headers=HEADERS)
            assert jr.status_code == 202, jr.text
            judge_task = jr.json()["task_id"]
            await wait_task(c, judge_task)
            judgments = (await c.get(
                "/eval/judgments", params={"evaluation_id": accepted["evaluation_id"]})).json()
            assert judgments and all(
                j["reasoning"] == "LIVE judge reasoning." for j in judgments)
            assert judge_task not in app.state.engine.live_keys
            assert scan_sqlite_for(app.state.db, KEY) == []

    run(case())
