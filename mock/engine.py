"""Task engine: lifecycle (queued→running→done/failed/cancelled, children),
SSE broker for GET /tasks/stream, and canned generation with trace spans."""

import asyncio
import json

from . import config, llm
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
    (openapi.yaml:789-806).

    Every event is published WITH the tree it belongs to so the endpoint can
    authorize it per subscriber: the stream is one global channel with no tree
    in its path, so without this it fanned every judgment (reasoning included),
    span and task result to every subscriber regardless of their permission
    matrix (docs/review-2026-08-05.md A2).

    tree_id None = "not resolvable from what the event references" (e.g. a
    judge task over standalone eval cases, which are global resources with no
    tree — feature-spec.md:115). Such events are DROPPED for a caller whose
    permissions are limited, never broadcast: omitting beats leaking.
    """

    def __init__(self):
        self.subs: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue()
        self.subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self.subs.discard(q)

    def publish(self, event: str, data: dict, tree_id: str | None = None):
        for q in list(self.subs):
            q.put_nowait((event, data, tree_id))


class Engine:
    def __init__(self, db: Db, broker: Broker, token_delay: float | None = None, step_delay: float | None = None):
        self.db = db
        self.broker = broker
        self.token_delay = config.TOKEN_DELAY if token_delay is None else token_delay
        self.step_delay = config.STEP_DELAY if step_delay is None else step_delay
        self._bg: set[asyncio.Task] = set()
        # BYOK key for batch children (replay/judge run server-side,
        # detached from the request that carried X-LLM-Key). Held IN-MEMORY
        # ONLY, keyed by parent task id — NEVER written to the tasks.payload
        # DB column or anywhere else (docs/deployment.md:27 "NEVER persisted").
        # Entries are popped when the parent reaches a terminal status; a
        # server restart loses them, so orphaned children fall back to canned
        # content — acceptable and documented for Phase 1.
        self.live_keys: dict[str, dict] = {}  # task_id -> {"key", "model"}
        # Resolved task -> tree, memoized for the SSE authorization filter
        # (see task_tree). Cache only, never the source of truth: a restart
        # re-resolves from the DB.
        self._task_trees: dict[str, str] = {}
        # Child ids already failed once by MOCK_FAIL_MARKER (config.fail_marker)
        # — in-memory so the RETRY of an injected failure succeeds.
        self._injected: set[str] = set()

    def spawn(self, coro):
        t = asyncio.get_running_loop().create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)

    # ------------------------------------------------- event authorization
    def turn_tree(self, turn_id: str | None) -> str | None:
        """Tree owning a turn — the scope span/judgment events are filtered on."""
        if not turn_id:
            return None
        row = self.db.one("SELECT tree_id FROM turns WHERE id = ?", (turn_id,))
        return row["tree_id"] if row else None

    def run_tree(self, run_id: str | None) -> str | None:
        if not run_id:
            return None
        row = self.db.one("SELECT tree_id FROM runs WHERE id = ?", (run_id,))
        return row["tree_id"] if row else None

    def task_tree(self, task_id: str) -> str | None:
        """Tree a task's events belong to (docs/review-2026-08-05.md A2).

        Resolution order, cheapest first: the tree stamped at creation, the
        payload's tree_id/run_id/turn_id, a turn the task produced, then the
        parent task. None = unresolvable → the event is withheld from any
        caller who does not hold every tree (Broker docstring)."""
        cached = self._task_trees.get(task_id)
        if cached:
            return cached
        task = self.get_task(task_id)
        if not task:
            return None
        payload = unj(task["payload"], {}) or {}
        result = payload.get("result") or {}
        tree = (payload.get("tree_id")
                or self.run_tree(payload.get("run_id") or result.get("run_id"))
                or self.turn_tree(payload.get("turn_id") or result.get("turn_id")))
        if not tree:
            row = self.db.one("SELECT tree_id FROM turns WHERE task_id = ? LIMIT 1", (task_id,))
            tree = row["tree_id"] if row else None
        if not tree and task["parent_id"]:
            tree = self.task_tree(task["parent_id"])
        if tree:
            self._task_trees[task_id] = tree
        return tree

    def _publish_task(self, event: str, data: dict, task_id: str):
        self.broker.publish(event, data, self.task_tree(task_id))

    # ------------------------------------------------------------- tasks
    def create_task(self, type_: str, parent_id: str | None = None, total: int = 1,
                    payload: dict | None = None, tree_id: str | None = None) -> dict:
        """`tree_id` scopes this task's /tasks/stream events (A2). Tasks whose
        work is not tree-scoped (judging standalone eval cases) pass None and
        their events reach holders of every tree only."""
        tid = new_id("task")
        self.db.run(
            "INSERT INTO tasks (id, type, status, done, total, parent_id, payload, created_at)"
            " VALUES (?, ?, 'queued', 0, ?, ?, ?, ?)",
            (tid, type_, total, parent_id, j(payload), now_iso()),
        )
        if tree_id:
            self._task_trees[tid] = tree_id
        task = self.get_task(tid)
        self._publish_task("task", task_dict(task), tid)
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
        if status in ("done", "failed", "cancelled"):
            # BYOK key lifetime ends with the task (docs/deployment.md:27).
            self.live_keys.pop(task_id, None)
        self._publish_task("task", task_dict(self.get_task(task_id)), task_id)

    def tick(self, task_id: str, stage: str | None = None):
        self.db.run("UPDATE tasks SET done = done + 1 WHERE id = ?", (task_id,))
        if stage is not None:
            self.db.run("UPDATE tasks SET stage = ? WHERE id = ?", (stage, task_id))
        task = self.get_task(task_id)
        self._publish_task("task", task_dict(task), task_id)
        self.progress(task_id, stage)

    def progress(self, task_id: str, stage: str | None = None):
        task = self.get_task(task_id)
        if stage is not None and stage != task["stage"]:
            self.db.run("UPDATE tasks SET stage = ? WHERE id = ?", (stage, task_id))
            task["stage"] = stage
        self._publish_task("progress", {
            "task_id": task_id,
            "progress": {"done": task["done"], "total": task["total"], "stage": task["stage"]},
        }, task_id)

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
        # Spans stream live on the tasks channel (feature-spec.md:150); the
        # span's turn carries the tree that may see it (A2).
        self.broker.publish("span", {"turn_id": turn_id, "span": span_dict(span)},
                            self.turn_tree(turn_id))
        return span

    def _close_span(self, span_id: str, turn_id: str, **fields):
        sets = ", ".join(f"{k} = ?" for k in fields)
        self.db.run(f"UPDATE spans SET {sets} WHERE id = ?", (*fields.values(), span_id))
        span = self.db.one("SELECT * FROM spans WHERE id = ?", (span_id,))
        self.broker.publish("span", {"turn_id": turn_id, "span": span_dict(span)},
                            self.turn_tree(turn_id))

    def _emit_trace(self, *, turn_id, agent, model, prompt_full, content, span_timing,
                    note=None):
        """Persist the agent→(tool)→llm span tree for one generated turn.

        `note`: live-provider fallback annotation on the llm span —
        stored in the span's error field while status STAYS "ok" (the turn
        succeeded with canned content; docs/deployment.md provider-error
        policy). Notes are built by mock/llm.py and never contain the key."""
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
            error=note, prompt=prompt_full, response=content,
        )

    # --------------------------------------------------------------- chat
    async def chat_events(self, ctx: dict, streaming: bool):
        """Yield ('token', delta)* then ('done', turn, 'completed'|'cancelled').

        One code path for both chat modes (cupel-phases.md:43); stream=false
        just consumes tokens without delay.
        """
        task_id = ctx["task_id"]
        self.set_status(task_id, "running", stage="generating…")
        start = now_iso()
        prompt_full = (ctx.get("system_prompt") or "") + ("\n\n" if ctx.get("system_prompt") else "") + ctx["prompt"]
        acc, cancelled, live_note = "", False, None

        # Live path (docs/deployment.md:18-20: "only the generation
        # call ... goes to a real provider when a key is present"). The key
        # exists only in ctx for this request — never persisted or logged.
        key = ctx.get("llm_key")
        live_model = (ctx.get("llm_model") or config.LIVE_DEFAULT_MODEL) if key else None
        served_live = False
        if key:
            try:
                if streaming:
                    async for delta in llm.stream(
                            key, live_model, ctx["prompt"],
                            system_prompt=ctx.get("system_prompt"),
                            temperature=ctx.get("temperature")):
                        if self.is_cancelled(task_id):
                            cancelled = True
                            break
                        acc += delta
                        yield ("token", delta)
                else:
                    acc = await llm.complete(
                        key, live_model, ctx["prompt"],
                        system_prompt=ctx.get("system_prompt"),
                        temperature=ctx.get("temperature"))
                served_live = True
            except llm.LiveUnavailable as exc:
                # Provider errors / rate limit never crash the turn: fall back
                # to canned; note lands on the llm span, status stays ok.
                live_note = f"live generation unavailable ({exc}); served canned fallback"
                # Mid-stream failure keeps the partial live content already
                # streamed to the client; failure before any delta → full
                # canned reply below.
                served_live = bool(acc)

        if not served_live and not cancelled:
            full = canned_reply(ctx["prompt"], ctx["agent"], ctx.get("model"),
                                salt=ctx.get("salt", ""))
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
        # Live turns record the live model on the llm span (docs/deployment.md
        # scope: "spans still recorded (llm span model = the live model)").
        self._emit_trace(turn_id=ctx["assistant_turn_id"], agent=ctx["agent"],
                         model=live_model or ctx.get("model"), prompt_full=prompt_full,
                         content=acc, span_timing=(start, end), note=live_note)
        result = {"conversation_id": ctx.get("conversation_id"), "turn_id": ctx["assistant_turn_id"]}
        if not cancelled:
            self.set_status(task_id, "done", result=result, stage=None)
        else:
            self.db.run("UPDATE tasks SET result = ? WHERE id = ?", (j(result), task_id))
        turn = self.db.one("SELECT * FROM turns WHERE id = ?", (ctx["assistant_turn_id"],))
        yield ("done", turn_dict(turn), "cancelled" if cancelled else "completed")

    # ------------------------------------------------------- regeneration
    def regenerate(self, *, tree_id, conversation_id, prompt, envelope, agent,
                   model, salt, task_id=None, content=None, trace_note=None) -> dict:
        """One replayed/forked assistant turn. Frozen context: the new turn
        reuses the source turn's envelope (openapi.yaml:1540-1546).

        `content` (live-generated text) overrides the canned reply;
        `trace_note` annotates the llm span on live fallback."""
        tid = new_id("turn")
        now = now_iso()
        if content is None:
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
                         prompt_full=prompt, content=content,
                         span_timing=(now, now_iso()), note=trace_note)
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
            self._inject_failure(child)
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

    def _inject_failure(self, child: dict):
        """Fail this child once if MOCK_FAIL_MARKER is set and its payload
        mentions the marker — see config.fail_marker for the contract."""
        marker = config.fail_marker()
        if not marker or marker not in (child["payload"] or ""):
            return
        if child["id"] in self._injected:
            return  # already failed once; the retry proceeds normally
        self._injected.add(child["id"])
        raise RuntimeError(f"injected failure (MOCK_FAIL_MARKER '{marker}')")

    async def _live_generation(self, parent_id, prompt, cfg):
        """(content, model, note) for one batch child generation. The key is
        looked up in self.live_keys (in-memory, parent task id) — a restart
        loses it and this returns the canned path (None content), documented
        in docs/deployment.md scope. Provider errors → canned + span note."""
        live = self.live_keys.get(parent_id)
        if not live:
            return None, None, None
        model = live.get("model") or config.LIVE_DEFAULT_MODEL
        try:
            text = await llm.complete(live["key"], model, prompt,
                                      temperature=(cfg or {}).get("temperature"))
            return text, model, None
        except llm.LiveUnavailable as exc:
            return None, model, f"live generation unavailable ({exc}); served canned fallback"

    async def _run_replay_unit(self, child, payload):
        run_id, col_idx = payload["run_id"], payload["col_idx"]
        rows, cfg = payload["rows"], payload.get("config") or {}
        for i, row in enumerate(rows):
            if self.is_cancelled(child["id"]) or self.is_cancelled(child["parent_id"]):
                return
            self._update_cell(run_id, row["row_idx"], col_idx, status="running")
            await asyncio.sleep(self.step_delay)
            content, live_model, note = await self._live_generation(
                child["parent_id"], row["prompt"], cfg)
            turn = self.regenerate(
                tree_id=payload["tree_id"], conversation_id=None,
                prompt=row["prompt"], envelope=row.get("envelope"),
                agent=payload["agent"], model=live_model or cfg.get("model"),
                salt=f"{run_id}:{col_idx}", task_id=child["id"],
                content=content, trace_note=note,
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
        content, live_model, note = await self._live_generation(
            child["parent_id"], payload["prompt"], cfg)
        turn = self.regenerate(
            tree_id=payload["tree_id"], conversation_id=payload["fork_conversation_id"],
            prompt=payload["prompt"], envelope=payload.get("envelope"),
            agent=payload["agent"], model=live_model or cfg.get("model"),
            salt=f"{run_id}:{payload['endpoint_id']}", task_id=child["id"],
            content=content, trace_note=note,
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
        # With a BYOK key on the parent judge task, the judge's
        # GENERATION (its reasoning text) comes from the live provider
        # (docs/deployment.md:18-20). The SCORE stays canned-deterministic —
        # parsing scores out of arbitrary cheap models is unreliable and the
        # append-only judgment store must stay well-formed. Provider errors →
        # canned reasoning, never a failed task.
        live = self.live_keys.get(child["parent_id"])
        if live:
            # eval_cases is versioned (id, version) — judge the LATEST
            # content, matching GET /eval/cases/{id} (openapi.yaml:1441-1442).
            case = self.db.one(
                "SELECT * FROM eval_cases WHERE id = ? ORDER BY version DESC LIMIT 1",
                (case_id,))
            rubric = self.db.one(
                "SELECT prompt FROM rubrics WHERE id = ? AND version = ?",
                (payload["rubric_id"], payload["rubric_version"]))
            judge_prompt = (
                f"You are a strict evaluator. Rubric: "
                f"{rubric['prompt'] if rubric else payload['rubric_name']}\n\n"
                f"Prompt:\n{case['prompt'] if case else ''}\n\n"
                f"Response:\n{case['output'] if case else ''}\n\n"
                "In 2-3 sentences, explain how well the response satisfies the rubric."
            )
            try:
                reasoning = await llm.complete(
                    live["key"], live.get("model") or config.LIVE_DEFAULT_MODEL,
                    judge_prompt)
            except llm.LiveUnavailable:
                pass  # canned reasoning stands
        self.db.run(
            "INSERT INTO judgments (id, case_id, run_id, turn_id, conversation_id, type,"
            " judge_model, rubric_id, rubric_version, score, reasoning, created_at)"
            " VALUES (?, ?, ?, ?, ?, 'llm', ?, ?, ?, ?, ?, ?)",
            (jid, case_id, payload.get("run_id"), payload.get("turn_id"),
             payload.get("conversation_id"), payload["judge_model"],
             payload["rubric_id"], payload["rubric_version"], score, reasoning, now),
        )
        # A judgment scores ONE run's cell. Unscoped, this overwrote
        # latest_score on every other run's cell sharing the case
        # (docs/review-2026-08-05.md A1). Judging standalone eval cases
        # (openapi.yaml:1865-1867 case_ids) carries no run — there the case is
        # the only addressable scope, so that path keeps the case-wide update.
        run_id = payload.get("run_id")
        if run_id:
            self.db.run(
                "UPDATE run_cells SET latest_score = ? WHERE case_id = ? AND run_id = ?",
                (score, case_id, run_id))
        else:
            self.db.run("UPDATE run_cells SET latest_score = ? WHERE case_id = ?",
                        (score, case_id))
        judgment = self.db.one("SELECT * FROM judgments WHERE id = ?", (jid,))
        # Scores stream into the grid live (feature-spec.md:64), to the tree
        # holding the judged run/turn only (A2).
        self.broker.publish(
            "judgment", {"judgment": judgment_dict(judgment)},
            self.run_tree(run_id) or self.turn_tree(payload.get("turn_id")))
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
        self._publish_task("task", task_dict(self.get_task(parent_id)), parent_id)
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
