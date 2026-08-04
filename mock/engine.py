"""Task engine: lifecycle (queued→running→done/failed/cancelled, children),
SSE broker for GET /tasks/stream, and canned generation with trace spans."""

import asyncio
import json

from . import config
from .db import Db, j, unj
from .util import canned_reply, det_hash, new_id, now_iso, stamp_envelope, tokenize

COST_IN, COST_OUT = 2e-6, 6e-6


def task_dict(t: dict, children: list[dict] | None = None) -> dict:
    d = {
        "id": t["id"],
        "type": t["type"],
        "status": t["status"],
        "progress": {"done": t["done"], "total": t["total"], "stage": t["stage"]},
        "parent_id": t["parent_id"],
        "result": unj(t["result"]),
        "error": t["error"],
        "created_at": t["created_at"],
        "started_at": t["started_at"],
        "finished_at": t["finished_at"],
    }
    if children is not None:
        d["children"] = children
    return d


def turn_dict(t: dict) -> dict:
    return {
        "id": t["id"],
        "role": t["role"],
        "author": t["author"],
        "content": t["content"],
        "content_type": t["content_type"],
        "created_at": t["created_at"],
        "attachments": unj(t["attachments"], []),
        "envelope": unj(t["envelope"]),
    }


def span_dict(s: dict) -> dict:
    return {
        "id": s["id"],
        "parent_id": s["parent_id"],
        "type": s["type"],
        "name": s["name"],
        "start": s["start_ts"],
        "end": s["end_ts"],
        "tokens_in": s["tokens_in"],
        "tokens_out": s["tokens_out"],
        "cost": s["cost"],
        "model": s["model"],
        "status": s["status"],
        "error": s["error"],
        "payload_ref": s["id"],
    }


class Broker:
    """Fan-out for /tasks/stream events: task | progress | span | judgment
    (openapi.yaml:789-806)."""

    def __init__(self):
        self.subs: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue()
        self.subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self.subs.discard(q)

    def publish(self, event: str, data: dict):
        for q in list(self.subs):
            q.put_nowait((event, data))


class Engine:
    def __init__(self, db: Db, broker: Broker, token_delay: float | None = None, step_delay: float | None = None):
        self.db = db
        self.broker = broker
        self.token_delay = config.TOKEN_DELAY if token_delay is None else token_delay
        self.step_delay = config.STEP_DELAY if step_delay is None else step_delay
        self._bg: set[asyncio.Task] = set()

    def spawn(self, coro):
        t = asyncio.get_running_loop().create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    # ------------------------------------------------------------- tasks
    def create_task(self, type_: str, parent_id: str | None = None, total: int = 1,
                    payload: dict | None = None) -> dict:
        tid = new_id("task")
        self.db.run(
            "INSERT INTO tasks (id, type, status, done, total, parent_id, payload, created_at)"
            " VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)",
            (tid, type_, total, parent_id, j(payload), now_iso()),
        )
        task = self.get_task(tid)
        self.broker.publish("task", task_dict(task))
        return task

    def get_task(self, task_id: str) -> dict | None:
        return self.db.one("SELECT * FROM tasks WHERE id = ?", (task_id,))

    def set_status(self, task_id: str, status: str, *, result: dict | None = None,
                   error: str | None = None, stage: str | None = None):
        now = now_iso()
        sets, params = ["status = ?"], [status]
        if status == "running":
            sets.append("started_at = COALESCE(started_at, ?)")
            params.append(now)
        if status in ("done", "failed", "cancelled"):
            sets.append("finished_at = ?")
            params.append(now)
        if result is not None:
            sets.append("result = ?")
            params.append(j(result))
        if error is not None:
            sets.append("error = ?")
            params.append(error)
        if stage is not None:
            sets.append("stage = ?")
            params.append(stage)
        if status == "done":
            sets.append("done = total")
        params.append(task_id)
        self.db.run(f"UPDATE tasks SET {', '.join(sets)} WHERE id = ?", params)
        self.broker.publish("task", task_dict(self.get_task(task_id)))

    def tick(self, task_id: str, stage: str | None = None):
        self.db.run("UPDATE tasks SET done = done + 1 WHERE id = ?", (task_id,))
        if stage is not None:
            self.db.run("UPDATE tasks SET stage = ? WHERE id = ?", (stage, task_id))
        task = self.get_task(task_id)
        self.broker.publish("task", task_dict(task))
        self.progress(task_id, stage)

    def progress(self, task_id: str, stage: str | None = None):
        task = self.get_task(task_id)
        if stage is not None and stage != task["stage"]:
            self.db.run("UPDATE tasks SET stage = ? WHERE id = ?", (stage, task_id))
            task["stage"] = stage
        self.broker.publish("progress", {
            "task_id": task_id,
            "progress": {"done": task["done"], "total": task["total"], "stage": task["stage"]},
        })

    def is_cancelled(self, task_id: str) -> bool:
        task = self.get_task(task_id)
        return task is None or task["status"] == "cancelled"

    def cancel(self, task_id: str) -> dict:
        """DELETE /tasks/{id}: cancel, cascades to children (openapi.yaml:835-839)."""
        for child in self.db.all("SELECT id, status FROM tasks WHERE parent_id = ?", (task_id,)):
            if child["status"] in ("queued", "running"):
                self.set_status(child["id"], "cancelled")
        task = self.get_task(task_id)
        if task["status"] in ("queued", "running"):
            self.set_status(task_id, "cancelled")
        return self.get_task(task_id)

    # -------------------------------------------------------------- spans
    def _insert_span(self, *, turn_id, parent_id, type_, name, start, end,
                     tokens_in=None, tokens_out=None, cost=None, model=None,
                     status="ok", error=None, prompt=None, response=None,
                     args=None, result=None) -> dict:
        sid = new_id("span")
        self.db.run(
            "INSERT INTO spans (id, turn_id, parent_id, type, name, start_ts, end_ts,"
            " tokens_in, tokens_out, cost, model, status, error, prompt, response, args, result)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (sid, turn_id, parent_id, type_, name, start, end, tokens_in, tokens_out,
             cost, model, status, error, prompt, response, j(args), j(result)),
        )
        span = self.db.one("SELECT * FROM spans WHERE id = ?", (sid,))
        # Spans stream live on the tasks channel (feature-spec.md:150).
        self.broker.publish("span", {"turn_id": turn_id, "span": span_dict(span)})
        return span

    def _close_span(self, span_id: str, turn_id: str, **fields):
        sets = ", ".join(f"{k} = ?" for k in fields)
        self.db.run(f"UPDATE spans SET {sets} WHERE id = ?", (*fields.values(), span_id))
        span = self.db.one("SELECT * FROM spans WHERE id = ?", (span_id,))
        self.broker.publish("span", {"turn_id": turn_id, "span": span_dict(span)})

    def _emit_trace(self, *, turn_id, agent, model, prompt_full, content, span_timing):
        """Persist the agent→(tool)→llm span tree for one generated turn."""
        start, end = span_timing
        tokens_in = max(1, len(prompt_full) // 4)
        tokens_out = max(1, len(tokenize(content)))
        cost = round(tokens_in * COST_IN + tokens_out * COST_OUT, 8)
        root = self._insert_span(
            turn_id=turn_id, parent_id=None, type_="agent", name=agent,
            start=start, end=end, status="ok",
        )
        if det_hash(turn_id) % 3 == 0:
            self._insert_span(
                turn_id=turn_id, parent_id=root["id"], type_="tool", name="search_kb",
                start=start, end=start, status="ok",
                args={"query": prompt_full[:60]}, result={"hits": det_hash(turn_id) % 5},
            )
        self._insert_span(
            turn_id=turn_id, parent_id=root["id"], type_="llm", name=model or "claude-sonnet-5",
            start=start, end=end, tokens_in=tokens_in, tokens_out=tokens_out,
            cost=cost, model=model or "claude-sonnet-5", status="ok",
            prompt=prompt_full, response=content,
        )

    # --------------------------------------------------------------- chat
    async def chat_events(self, ctx: dict, streaming: bool):
        """Yield ('token', delta)* then ('done', turn, 'completed'|'cancelled').

        One code path for both chat modes (loom-phases.md:43); stream=false
        just consumes tokens without delay.
        """
        task_id = ctx["task_id"]
        self.set_status(task_id, "running", stage="generating…")
        start = now_iso()
        full = canned_reply(ctx["prompt"], ctx["agent"], ctx.get("model"), salt=ctx.get("salt", ""))
        prompt_full = (ctx.get("system_prompt") or "") + ("\n\n" if ctx.get("system_prompt") else "") + ctx["prompt"]
        acc, cancelled = "", False
        for chunk in tokenize(full):
            if self.is_cancelled(task_id):
                cancelled = True
                break
            acc += chunk
            if streaming:
                yield ("token", chunk)
                if self.token_delay:
                    await asyncio.sleep(self.token_delay)
        end = now_iso()
        self.db.run(
            "UPDATE turns SET content = ?, created_at = ? WHERE id = ?",
            (acc, end, ctx["assistant_turn_id"]),
        )
        if ctx.get("conversation_id"):
            self.db.run("UPDATE conversations SET last_activity_at = ? WHERE id = ?",
                        (end, ctx["conversation_id"]))
        self._emit_trace(turn_id=ctx["assistant_turn_id"], agent=ctx["agent"],
                         model=ctx.get("model"), prompt_full=prompt_full,
                         content=acc, span_timing=(start, end))
        result = {"conversation_id": ctx.get("conversation_id"), "turn_id": ctx["assistant_turn_id"]}
        if not cancelled:
            self.set_status(task_id, "done", result=result, stage=None)
        else:
            self.db.run("UPDATE tasks SET result = ? WHERE id = ?", (j(result), task_id))
        turn = self.db.one("SELECT * FROM turns WHERE id = ?", (ctx["assistant_turn_id"],))
        yield ("done", turn_dict(turn), "cancelled" if cancelled else "completed")

    # ------------------------------------------------------- regeneration
    def regenerate(self, *, tree_id, conversation_id, prompt, envelope, agent,
                   model, salt, task_id=None) -> dict:
        """One replayed/forked assistant turn. Frozen context: the new turn
        reuses the source turn's envelope (openapi.yaml:1540-1546)."""
        tid = new_id("turn")
        now = now_iso()
        content = canned_reply(prompt, agent, model, salt=salt)
        self.db.run(
            "INSERT INTO turns (id, conversation_id, tree_id, invocation_id, role, author,"
            " content, content_type, created_at, envelope, task_id)"
            " VALUES (?, ?, ?, ?, 'assistant', ?, ?, 'text', ?, ?, ?)",
            (tid, conversation_id, tree_id, new_id("inv"), agent, content, now,
             j(envelope or stamp_envelope()), task_id),
        )
        if conversation_id:
            self.db.run("UPDATE conversations SET last_activity_at = ? WHERE id = ?",
                        (now, conversation_id))
        self._emit_trace(turn_id=tid, agent=agent, model=model,
                         prompt_full=prompt, content=content, span_timing=(now, now_iso()))
        return self.db.one("SELECT * FROM turns WHERE id = ?", (tid,))

    def _update_cell(self, run_id, row_idx, col_idx, **fields):
        sets = ", ".join(f"{k} = ?" for k in fields)
        self.db.run(
            f"UPDATE run_cells SET {sets} WHERE run_id = ? AND row_idx = ? AND col_idx = ?",
            (*fields.values(), run_id, row_idx, col_idx),
        )

    # ------------------------------------------------------------ batches
    async def run_batch(self, parent_id: str):
        """Drive queued children of a batch sequentially; cells fill
        incrementally (feature-spec.md:112)."""
        self.set_status(parent_id, "running")
        children = self.db.all(
            "SELECT * FROM tasks WHERE parent_id = ? ORDER BY rowid", (parent_id,))
        for child in children:
            if self.is_cancelled(parent_id):
                return
            if child["status"] != "queued":
                continue
            await self.run_child(child["id"])
            self.tick(parent_id)
        parent = self.get_task(parent_id)
        if parent["status"] == "running":
            self.set_status(parent_id, "done", result=unj(parent["result"]) or unj(parent["payload"], {}).get("result"))

    async def run_child(self, child_id: str):
        child = self.get_task(child_id)
        payload = unj(child["payload"], {})
        kind = payload.get("kind")
        self.set_status(child_id, "running")
        try:
            if kind == "replay_unit":
                await self._run_replay_unit(child, payload)
            elif kind == "fork_unit":
                await self._run_fork_unit(child, payload)
            elif kind == "judge_case":
                await self._run_judge_case(child, payload)
            else:
                raise ValueError(f"unknown child payload kind: {kind}")
            if not self.is_cancelled(child["id"]):
                self.set_status(child["id"], "done", result=payload.get("result"))
        except Exception as exc:  # child failure must not kill the batch (feature-spec.md:110)
            self.set_status(child["id"], "failed", error=str(exc))

    async def _run_replay_unit(self, child, payload):
        run_id, col_idx = payload["run_id"], payload["col_idx"]
        rows, cfg = payload["rows"], payload.get("config") or {}
        for i, row in enumerate(rows):
            if self.is_cancelled(child["id"]) or self.is_cancelled(child["parent_id"]):
                return
            self._update_cell(run_id, row["row_idx"], col_idx, status="running")
            await asyncio.sleep(self.step_delay)
            turn = self.regenerate(
                tree_id=payload["tree_id"], conversation_id=None,
                prompt=row["prompt"], envelope=row.get("envelope"),
                agent=payload["agent"], model=cfg.get("model"),
                salt=f"{run_id}:{col_idx}", task_id=child["id"],
            )
            self._update_cell(run_id, row["row_idx"], col_idx,
                              status="done", content=turn["content"], turn_id=turn["id"],
                              task_id=child["id"])
            self.progress(
                child["parent_id"],
                f"Conversation {payload['conv_index']}/{payload['conv_total']} · turn {i + 1}/{len(rows)}",
            )
        payload["result"] = {"run_id": run_id}
        self.db.run("UPDATE tasks SET payload = ? WHERE id = ?", (j(payload), child["id"]))

    async def _run_fork_unit(self, child, payload):
        run_id, col_idx = payload["run_id"], payload["col_idx"]
        if self.is_cancelled(child["id"]) or self.is_cancelled(child["parent_id"]):
            return
        self._update_cell(run_id, payload["row_idx"], col_idx, status="running")
        await asyncio.sleep(self.step_delay)
        cfg = payload.get("config") or {}
        turn = self.regenerate(
            tree_id=payload["tree_id"], conversation_id=payload["fork_conversation_id"],
            prompt=payload["prompt"], envelope=payload.get("envelope"),
            agent=payload["agent"], model=cfg.get("model"),
            salt=f"{run_id}:{payload['endpoint_id']}", task_id=child["id"],
        )
        self._update_cell(run_id, payload["row_idx"], col_idx,
                          status="done", content=turn["content"], turn_id=turn["id"],
                          conversation_id=payload["fork_conversation_id"], task_id=child["id"])
        payload["result"] = {
            "run_id": run_id,
            "conversation_id": payload["fork_conversation_id"],
            "turn_id": turn["id"],
        }
        self.db.run("UPDATE tasks SET payload = ? WHERE id = ?", (j(payload), child["id"]))
        self.set_status(child["id"], "running", result=payload["result"])
        self.progress(child["parent_id"], f"Endpoint {payload['endpoint_name']}")

    async def _run_judge_case(self, child, payload):
        await asyncio.sleep(self.step_delay)
        case_id = payload["case_id"]
        h = det_hash(case_id, payload["rubric_id"], payload["rubric_version"], payload["judge_model"])
        score = round(0.35 + (h % 66) / 100, 2)
        jid = new_id("judg")
        now = now_iso()
        reasoning = (
            f"Scored {score} against rubric '{payload['rubric_name']}' "
            f"v{payload['rubric_version']}: the response addresses the prompt and "
            f"{'cites supporting detail' if h % 2 == 0 else 'stays on topic, with minor gaps'}."
        )
        self.db.run(
            "INSERT INTO judgments (id, case_id, run_id, turn_id, conversation_id, type,"
            " judge_model, rubric_id, rubric_version, score, reasoning, created_at)"
            " VALUES (?, ?, ?, ?, ?, 'llm', ?, ?, ?, ?, ?, ?)",
            (jid, case_id, payload.get("run_id"), payload.get("turn_id"),
             payload.get("conversation_id"), payload["judge_model"],
             payload["rubric_id"], payload["rubric_version"], score, reasoning, now),
        )
        self.db.run("UPDATE run_cells SET latest_score = ? WHERE case_id = ?", (score, case_id))
        judgment = self.db.one("SELECT * FROM judgments WHERE id = ?", (jid,))
        # Scores stream into the grid live (feature-spec.md:64).
        self.broker.publish("judgment", {"judgment": judgment_dict(judgment)})
        payload["result"] = {"run_id": payload.get("run_id"), "turn_id": payload.get("turn_id")}
        self.db.run("UPDATE tasks SET payload = ? WHERE id = ?", (j(payload), child["id"]))
        self.progress(child["parent_id"], f"Case {payload['case_index']}/{payload['case_total']}")

    async def retry_failed(self, parent_id: str):
        failed = self.db.all(
            "SELECT * FROM tasks WHERE parent_id = ? AND status = 'failed' ORDER BY rowid",
            (parent_id,))
        for child in failed:
            self.db.run("UPDATE tasks SET status = 'queued', error = NULL, finished_at = NULL"
                        " WHERE id = ?", (child["id"],))
        done = self.db.one(
            "SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status = 'done'",
            (parent_id,))["n"]
        self.db.run("UPDATE tasks SET done = ?, error = NULL, finished_at = NULL,"
                    " status = 'running' WHERE id = ?", (done, parent_id))
        self.broker.publish("task", task_dict(self.get_task(parent_id)))
        for child in failed:
            if self.is_cancelled(parent_id):
                return
            await self.run_child(child["id"])
            self.tick(parent_id)
        parent = self.get_task(parent_id)
        if parent["status"] == "running":
            still_failed = self.db.one(
                "SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status = 'failed'",
                (parent_id,))["n"]
            self.set_status(parent_id, "failed" if still_failed else "done")


def judgment_dict(row: dict) -> dict:
    return {
        "id": row["id"],
        "case_id": row["case_id"],
        "run_id": row["run_id"],
        "turn_id": row["turn_id"],
        "conversation_id": row["conversation_id"],
        "type": row["type"],
        "judge_model": row["judge_model"],
        "rubric_id": row["rubric_id"],
        "rubric_version": row["rubric_version"],
        "score": row["score"],
        "reasoning": row["reasoning"],
        "created_at": row["created_at"],
    }
