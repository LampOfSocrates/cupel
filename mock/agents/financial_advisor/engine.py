"""Genuine multi-step LLM + tool-use loop for the Financial Advisor demo tree
(mock/agents/financial_advisor/tree.py) — the ONE tree in this mock whose
trace is produced by actually running tools and feeding results back to the
model, rather than being synthesized (mock/engine.py's _emit_trace, used by
every other tree's canned agent/tool/llm spans). Kept out of mock/engine.py:
that engine's chat_events is a single-shot generation (canned, or one live
call), and every other tree is happy paying nothing for a tool round-trip
loop only this one uses.

The tree's mere EXISTENCE is gated by a server-side env var at bootstrap
(mock/seed.py, config.live_env_key) — that is a seeding-time decision, not a
substitute for BYOK. Each chat request here still needs its OWN X-LLM-Key
(docs/deployment.md:24-27, mock/llm.py), exactly like every other tree's live
path. No key -> the same canned single-shot fallback the rest of the mock
uses, but WITHOUT a fabricated tool span: inventing a fake multi-step trace
here would be exactly the kind of invented data this feature exists to
demonstrate the absence of.
"""

import asyncio
import json

from ... import config, llm
from ...db import unj
from ...util import canned_reply, now_iso, tokenize
from .tools import IMPLEMENTATIONS, TOOL_SPECS

MAX_STEPS = 4
COST_IN, COST_OUT = 2e-6, 6e-6
TOOLS = list(TOOL_SPECS.values())


def _turn_dict(t: dict) -> dict:
    # Mirrors mock.engine.turn_dict, duplicated rather than imported so this
    # module's only dependency on the shared Engine is the instance passed
    # into run() — it never touches mock.engine's own canned/live code path.
    return {
        "id": t["id"], "role": t["role"], "author": t["author"],
        "content": t["content"], "content_type": t["content_type"],
        "created_at": t["created_at"], "attachments": unj(t["attachments"], []),
        "envelope": unj(t["envelope"]),
    }


def _finish(engine, ctx: dict, content: str, cancelled: bool) -> dict:
    end = now_iso()
    engine.db.run("UPDATE turns SET content = ?, created_at = ? WHERE id = ?",
                  (content, end, ctx["assistant_turn_id"]))
    if ctx.get("conversation_id"):
        engine.db.run("UPDATE conversations SET last_activity_at = ? WHERE id = ?",
                      (end, ctx["conversation_id"]))
    result = {"conversation_id": ctx.get("conversation_id"), "turn_id": ctx["assistant_turn_id"]}
    if not cancelled:
        engine.set_status(ctx["task_id"], "done", result=result, stage=None)
    else:
        engine.db.run("UPDATE tasks SET result = ? WHERE id = ?",
                      (json.dumps(result), ctx["task_id"]))
    return engine.db.one("SELECT * FROM turns WHERE id = ?", (ctx["assistant_turn_id"],))


async def _fallback(engine, ctx: dict, streaming: bool, note: str):
    """Single canned reply, agent+llm spans only — no tool span, so a
    no-key/provider-error turn never LOOKS like it ran a tool it didn't."""
    task_id, start = ctx["task_id"], now_iso()
    full = canned_reply(ctx["prompt"], ctx["agent"], ctx.get("model"), salt=ctx.get("salt", ""))
    acc, cancelled = "", False
    for chunk in tokenize(full):
        if engine.is_cancelled(task_id):
            cancelled = True
            break
        acc += chunk
        if streaming:
            yield ("token", chunk)
            if engine.token_delay:
                await asyncio.sleep(engine.token_delay)
    end = now_iso()
    root = engine._insert_span(turn_id=ctx["assistant_turn_id"], parent_id=None,
                               type_="agent", name=ctx["agent"], start=start, end=end, status="ok")
    tin, tout = max(1, len(ctx["prompt"]) // 4), max(1, len(tokenize(acc)))
    engine._insert_span(turn_id=ctx["assistant_turn_id"], parent_id=root["id"], type_="llm",
                        name=ctx.get("model") or "claude-sonnet-5", start=start, end=end,
                        tokens_in=tin, tokens_out=tout,
                        cost=round(tin * COST_IN + tout * COST_OUT, 8),
                        model=ctx.get("model") or "claude-sonnet-5", status="ok", error=note,
                        prompt=ctx["prompt"], response=acc)
    turn = _finish(engine, ctx, acc, cancelled)
    yield ("done", _turn_dict(turn), "cancelled" if cancelled else "completed")


async def run(engine, ctx: dict, streaming: bool):
    """Yield the same ('token', delta)* / ('done', turn, status) events as
    mock.engine.Engine.chat_events, so mock/main.py's chat route needs no
    special-casing beyond choosing which coroutine to drive."""
    task_id = ctx["task_id"]
    engine.set_status(task_id, "running", stage="generating…")
    key = ctx.get("llm_key")
    if not key:
        async for evt in _fallback(engine, ctx, streaming,
                                   "no BYOK key on the request; served canned fallback"):
            yield evt
        return

    start = now_iso()
    model = ctx.get("llm_model") or config.LIVE_DEFAULT_MODEL
    messages = []
    if ctx.get("system_prompt"):
        messages.append({"role": "system", "content": ctx["system_prompt"]})
    messages.append({"role": "user", "content": ctx["prompt"]})

    root = engine._insert_span(turn_id=ctx["assistant_turn_id"], parent_id=None,
                               type_="agent", name=ctx["agent"], start=start, end=None,
                               status="running")

    try:
        final_text = ""
        for _ in range(MAX_STEPS):
            if engine.is_cancelled(task_id):
                engine._close_span(root["id"], ctx["assistant_turn_id"], status="ok", end_ts=now_iso())
                turn = _finish(engine, ctx, final_text, True)
                yield ("done", _turn_dict(turn), "cancelled")
                return
            llm_start = now_iso()
            msg = await llm.complete_with_tools(key, model, messages, TOOLS,
                                                temperature=ctx.get("temperature"))
            llm_end = now_iso()
            tin = max(1, sum(len(m.get("content") or "") for m in messages) // 4)
            tout = max(1, len(tokenize(msg.get("content") or "")))
            engine._insert_span(turn_id=ctx["assistant_turn_id"], parent_id=root["id"], type_="llm",
                                name=model, start=llm_start, end=llm_end, tokens_in=tin,
                                tokens_out=tout, cost=round(tin * COST_IN + tout * COST_OUT, 8),
                                model=model, status="ok",
                                prompt=json.dumps(messages), response=msg.get("content") or "")
            tool_calls = msg.get("tool_calls") or []
            if not tool_calls:
                final_text = msg.get("content") or ""
                break
            messages.append({"role": "assistant", "content": msg.get("content"),
                             "tool_calls": tool_calls})
            for call in tool_calls:
                fn = call.get("function") or {}
                name = fn.get("name")
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                impl = IMPLEMENTATIONS.get(name)
                tool_start = now_iso()
                try:
                    result = impl(**args) if impl else {"error": f"unknown tool '{name}'"}
                except Exception as exc:  # bad/partial args from the model — surface, don't crash
                    result = {"error": str(exc)}
                tool_end = now_iso()
                engine._insert_span(turn_id=ctx["assistant_turn_id"], parent_id=root["id"],
                                    type_="tool", name=name or "unknown", start=tool_start,
                                    end=tool_end, status="ok" if impl else "error",
                                    args=args, result=result)
                messages.append({"role": "tool", "tool_call_id": call.get("id"),
                                 "content": json.dumps(result)})
        else:
            final_text = final_text or "Reached the tool-call step limit without a final answer."
    except llm.LiveUnavailable as exc:
        note = f"live generation unavailable ({exc}); served canned fallback"
        engine._close_span(root["id"], ctx["assistant_turn_id"], status="error", error=note,
                           end_ts=now_iso())
        async for evt in _fallback(engine, ctx, streaming, note):
            yield evt
        return

    if streaming:
        acc, cancelled = "", False
        for chunk in tokenize(final_text):
            if engine.is_cancelled(task_id):
                cancelled = True
                break
            acc += chunk
            yield ("token", chunk)
            if engine.token_delay:
                await asyncio.sleep(engine.token_delay)
    else:
        acc, cancelled = final_text, engine.is_cancelled(task_id)

    engine._close_span(root["id"], ctx["assistant_turn_id"], status="ok", end_ts=now_iso())
    turn = _finish(engine, ctx, acc, cancelled)
    yield ("done", _turn_dict(turn), "cancelled" if cancelled else "completed")
