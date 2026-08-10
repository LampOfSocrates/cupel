"""Financial Advisor demo tree (mock/agents/financial_advisor):
- gated at bootstrap by config.live_env_key (server-side key), never seeded
  without one;
- runs a REAL multi-step tool-calling loop against a fake OpenRouter
  transport — never the real provider;
- no BYOK key on the request still falls back to canned content, but with NO
  fabricated tool span (that's the whole point of this tree).
"""

import json

import httpx
import pytest

from mock import config, llm
from mock.agents.financial_advisor.tools import lookup_tax_rule, parse_statement
from mock.main import create_app
from mock.tests import with_turns
from mock.tests.test_mock import StreamingASGITransport, parse_sse, run, wait_task

KEY = "sk-or-test-fa-key-0451"
HEADERS = {"X-LLM-Key": KEY, "X-LLM-Model": "deepseek/deepseek-chat"}

STATEMENT = "2026-01-05  Whole Foods Market  -$45.20\n2026-01-06  Payroll Deposit  2000.00"


def make_app(*, seeded=True):
    app = create_app(db_path=":memory:", token_delay=0.0, step_delay=0.0)
    client = httpx.AsyncClient(transport=StreamingASGITransport(app), base_url="http://t")
    return app, client


def fake_tool_provider(responses):
    """OpenRouter stand-in for a scripted multi-step tool-calling exchange.
    `responses` is one assistant message dict per call, in order — the last
    is repeated if the loop runs longer than scripted. Never the real
    provider (mock/llm.py TRANSPORT injection point)."""
    calls: list[dict] = []

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        calls.append({"auth": request.headers.get("authorization"), "body": body})
        msg = responses[min(len(calls) - 1, len(responses) - 1)]
        return httpx.Response(200, json={"choices": [{"message": msg}]})

    return httpx.MockTransport(handler), calls


TOOL_CALL_STEP = {
    "content": None,
    "tool_calls": [{
        "id": "call_1", "type": "function",
        "function": {"name": "parse_statement", "arguments": json.dumps({"text": STATEMENT})},
    }],
}
FINAL_STEP = {"content": "You spent $45.20 and received $2000.00 — net +$1954.80.",
             "tool_calls": None}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("CUPEL_LLM_KEY", raising=False)
    llm.reset_rate_limit()
    yield
    llm.TRANSPORT = None
    llm.reset_rate_limit()


async def chat(c, tree, message, *, stream, headers=None, **extra):
    body = {"message": message, "stream": stream, **extra}
    if not stream:
        r = await c.post(f"/agenttrees/{tree}/chat", json=body, headers=headers or {})
        assert r.status_code == 200, r.text
        payload = r.json()
        await wait_task(c, payload["task_id"])
        return payload
    async with c.stream("POST", f"/agenttrees/{tree}/chat", json=body,
                        headers=headers or {}) as r:
        assert r.status_code == 200
        raw = "".join([chunk.decode() async for chunk in r.aiter_bytes()])
    return parse_sse(raw)


async def span_payload(c, span_id):
    r = await c.get(f"/spans/{span_id}/payload")
    assert r.status_code == 200
    return r.json()


# ------------------------------------------------------------------ tools
def test_parse_statement_builds_local_table():
    result = parse_statement(STATEMENT)
    assert result["row_count"] == 2
    assert result["rows"][0] == {"date": "2026-01-05", "description": "Whole Foods Market",
                                 "amount": -45.20, "category": "groceries"}
    assert result["rows"][1]["category"] == "income"
    assert result["total"] == 1954.80


def test_lookup_tax_rule_marginal_bracket():
    result = lookup_tax_rule(50_000, "single")
    assert result["marginal_rate"] == 0.22
    assert result["estimated_tax"] > 0
    assert result["filing_status"] == "single"


# ---------------------------------------------------------------- gating
def test_tree_absent_without_a_server_side_key(monkeypatch):
    monkeypatch.setattr(config, "live_env_key", lambda: None)

    async def case():
        app, c = make_app()
        async with c:
            trees = {t["id"] for t in (await c.get("/agenttrees")).json()}
            assert "financial_advisor" not in trees

    run(case())


def test_tree_seeded_with_a_server_side_key(monkeypatch):
    monkeypatch.setattr(config, "live_env_key", lambda: "sk-or-server-side-key")

    async def case():
        app, c = make_app()
        async with c:
            trees = {t["id"] for t in (await c.get("/agenttrees")).json()}
            assert "financial_advisor" in trees
            agents = (await c.get("/agenttrees/financial_advisor/agents")).json()
            by_id = {a["id"]: a for a in agents}
            assert by_id["ag_advisor"]["tools"] == ["parse_statement", "lookup_tax_rule"]
            assert by_id["ag_tax"]["parent_id"] == "ag_advisor"

    run(case())


# ----------------------------------------------------------- the tool loop
def test_multi_step_tool_call_loop_produces_a_real_trace(monkeypatch):
    monkeypatch.setattr(config, "live_env_key", lambda: "sk-or-server-side-key")
    llm.TRANSPORT, calls = fake_tool_provider([TOOL_CALL_STEP, FINAL_STEP])

    async def case():
        app, c = make_app()
        async with c:
            body = await chat(c, "financial_advisor", f"Parse this:\n{STATEMENT}",
                              stream=False, headers=HEADERS)
            conv = await with_turns(
                c, f"/agenttrees/financial_advisor/conversations/{body['conversation_id']}")
            turn = conv["turns"][1]
            assert turn["content"] == FINAL_STEP["content"]

            trace = (await c.get(
                f"/agenttrees/financial_advisor/turns/{turn['id']}/trace")).json()
            spans = trace["spans"]
            kinds = [s["type"] for s in spans]
            assert kinds == ["agent", "llm", "tool", "llm"]
            assert spans[0]["status"] == "ok"  # root closed, not left "running"
            assert spans[2]["name"] == "parse_statement"
            assert spans[2]["status"] == "ok"

            tool_payload = await span_payload(c, spans[2]["id"])
            assert tool_payload["args"] == {"text": STATEMENT}
            assert tool_payload["result"]["row_count"] == 2
            assert tool_payload["result"]["total"] == 1954.80

            # two real round trips to the fake provider, second one carries
            # the tool result back as a 'tool' role message
            assert len(calls) == 2
            second_messages = calls[1]["body"]["messages"]
            assert any(m["role"] == "tool" for m in second_messages)

    run(case())


def test_no_key_falls_back_to_canned_with_no_fabricated_tool_span(monkeypatch):
    monkeypatch.setattr(config, "live_env_key", lambda: "sk-or-server-side-key")
    llm.TRANSPORT, calls = fake_tool_provider([TOOL_CALL_STEP, FINAL_STEP])

    async def case():
        app, c = make_app()
        async with c:
            body = await chat(c, "financial_advisor", "What's my spending look like?",
                              stream=False)  # no X-LLM-Key
            conv = await with_turns(
                c, f"/agenttrees/financial_advisor/conversations/{body['conversation_id']}")
            turn = conv["turns"][1]
            assert turn["content"]  # canned, non-empty
            trace = (await c.get(
                f"/agenttrees/financial_advisor/turns/{turn['id']}/trace")).json()
            assert [s["type"] for s in trace["spans"]] == ["agent", "llm"]  # no tool span
            assert calls == []  # provider never called

    run(case())


def test_provider_error_mid_loop_falls_back_to_canned(monkeypatch):
    monkeypatch.setattr(config, "live_env_key", lambda: "sk-or-server-side-key")

    def handler(request: httpx.Request):
        return httpx.Response(401, json={"error": {"message": "denied"}})
    llm.TRANSPORT = httpx.MockTransport(handler)

    async def case():
        app, c = make_app()
        async with c:
            body = await chat(c, "financial_advisor", "Any advice?", stream=False, headers=HEADERS)
            conv = await with_turns(
                c, f"/agenttrees/financial_advisor/conversations/{body['conversation_id']}")
            turn = conv["turns"][1]
            assert turn["content"]
            trace = (await c.get(
                f"/agenttrees/financial_advisor/turns/{turn['id']}/trace")).json()
            kinds = [s["type"] for s in trace["spans"]]
            assert "tool" not in kinds  # never fabricated
            assert any(s["status"] == "error" for s in trace["spans"])

    run(case())
