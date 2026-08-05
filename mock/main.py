"""Skein Phase-1 mock server — implements openapi.yaml v0.2.0 exactly.

Run: npm run mock  (uvicorn mock.main:app --port 4010, openapi.yaml:46)
"""

import asyncio
import json

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse

from . import config
from .db import Db, j, unj
from .engine import Broker, Engine, judgment_dict, span_dict, task_dict, turn_dict
from .seed import bootstrap
from .util import canned_title, new_id, now_iso, sse, stamp_envelope


def err(status: int, code: str, message: str):
    raise HTTPException(status, {"code": code, "message": message})


async def body_json(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        err(422, "invalid", "Request body must be valid JSON.")
    if not isinstance(body, dict):
        err(422, "invalid", "Request body must be a JSON object.")
    return body


def create_app(db_path: str | None = None, token_delay: float | None = None,
               step_delay: float | None = None) -> FastAPI:
    app = FastAPI(title="Skein mock", version=config.VERSION, openapi_url=None, docs_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

    db = Db(db_path or config.DB_PATH)
    seed_label = bootstrap(db)
    broker = Broker()
    engine = Engine(db, broker, token_delay=token_delay, step_delay=step_delay)
    app.state.db, app.state.engine, app.state.seed = db, engine, seed_label

    @app.exception_handler(HTTPException)
    async def http_exc(request, exc):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
        return JSONResponse(detail, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_exc(request, exc):
        return JSONResponse({"code": "invalid", "message": str(exc)}, status_code=422)

    # ------------------------------------------------------------- helpers
    def live_headers(request: Request) -> tuple[str | None, str | None]:
        """P1-T18c: (key, model) from X-LLM-Key / X-LLM-Model. The headers are
        transport-level BY DESIGN (docs/deployment.md:26) — deliberately
        outside the openapi.yaml contract. The key is returned into the
        caller's stack frame only: never stored on app.state or the DB, never
        logged (docs/deployment.md:27). MOCK_LIVE_DISABLED=1 kills the
        feature entirely."""
        if config.live_disabled():
            return None, None
        return (request.headers.get("x-llm-key") or None,
                request.headers.get("x-llm-model") or None)

    def register_live(parent_id: str, request: Request) -> None:
        """Replay/judge children run server-side, detached from this request,
        so the key is held on the engine's in-memory dict for the lifetime of
        the enqueued work only — never in the tasks.payload DB column; cleared
        when the parent task terminates (see Engine.live_keys)."""
        key, model = live_headers(request)
        if key:
            engine.live_keys[parent_id] = {"key": key, "model": model}

    def need_tree(tree: str) -> dict:
        row = db.one("SELECT * FROM trees WHERE id = ?", (tree,))
        if not row:
            err(404, "not_found", f"Agent tree '{tree}' not found.")
        return row

    def need_agent(tree: str, agent_id: str) -> dict:
        row = db.one("SELECT * FROM agents WHERE id = ? AND tree_id = ?", (agent_id, tree))
        if not row:
            err(404, "not_found", f"Agent '{agent_id}' not found in tree '{tree}'.")
        return row

    def live_version(agent_id: str) -> int:
        row = db.one("SELECT MAX(version) AS v FROM instruction_versions WHERE agent_id = ?", (agent_id,))
        return row["v"] or 0

    def agent_dict(a: dict) -> dict:
        return {
            "id": a["id"], "name": a["name"], "parent_id": a["parent_id"],
            "live_version": live_version(a["id"]), "tools": unj(a["tools"], []),
            "enabled": bool(a["enabled"]), "format": a["format"],
        }

    def root_agent(tree: str) -> dict | None:
        return db.one("SELECT * FROM agents WHERE tree_id = ? AND parent_id IS NULL ORDER BY rowid", (tree,))

    def fork_count(conversation_id: str) -> int:
        return db.one(
            "SELECT COUNT(*) AS n FROM conversations WHERE deleted = 0"
            " AND json_extract(lineage, '$.parent_conversation_id') = ?",
            (conversation_id,))["n"]

    def conv_turns(conversation_id: str) -> list[dict]:
        return db.all("SELECT * FROM turns WHERE conversation_id = ? ORDER BY rowid", (conversation_id,))

    def conversation_dict(c: dict, include_turns: bool = True) -> dict:
        d = {
            "id": c["id"], "tree_id": c["tree_id"], "title": c["title"],
            "origin": c["origin"], "channel": c["channel"], "agent_id": c["agent_id"],
            "created_at": c["created_at"], "last_activity_at": c["last_activity_at"],
            "lineage": unj(c["lineage"]), "fork_count": fork_count(c["id"]),
        }
        if include_turns:
            d["turns"] = [turn_dict(t) for t in conv_turns(c["id"])]
        return d

    def need_conversation(tree: str, conversation_id: str) -> dict:
        row = db.one(
            "SELECT * FROM conversations WHERE id = ? AND tree_id = ? AND deleted = 0",
            (conversation_id, tree))
        if not row:
            err(404, "not_found", f"Conversation '{conversation_id}' not found.")
        return row

    def config_label(cfg: dict, index: int) -> str:
        if cfg.get("snapshot_id"):
            snap = db.one("SELECT label FROM snapshots WHERE snapshot_id = ?", (cfg["snapshot_id"],))
            if snap:
                return snap["label"]
        if cfg.get("instruction_version") is not None:
            return f"v{cfg['instruction_version']}"
        if cfg.get("model"):
            return cfg["model"]
        return f"config {index + 1}"

    def run_dict(r: dict) -> dict:
        task = engine.get_task(r["task_id"])
        rows = db.all("SELECT * FROM run_rows WHERE run_id = ? ORDER BY row_idx", (r["id"],))
        out_rows = []
        for row in rows:
            cells = db.all(
                "SELECT * FROM run_cells WHERE run_id = ? AND row_idx = ? ORDER BY col_idx",
                (r["id"], row["row_idx"]))
            out_rows.append({
                "source": {"conversation_id": row["conversation_id"], "turn_id": row["turn_id"]},
                "cells": [{
                    "status": c["status"], "content": c["content"],
                    "conversation_id": c["conversation_id"], "turn_id": c["turn_id"],
                    "task_id": c["task_id"], "case_id": c["case_id"],
                    "latest_score": c["latest_score"], "error": c["error"],
                } for c in cells],
            })
        return {
            "id": r["id"], "tree_id": r["tree_id"], "status": task["status"],
            "created_at": r["created_at"], "task_id": r["task_id"],
            "columns": unj(r["columns"], []), "rows": out_rows,
        }

    def assistant_rows(conversation: dict, turn_ids: list | None) -> list[dict]:
        """Grid rows: one per assistant turn (feature-spec.md:49), each with the
        prompt of its nearest preceding user turn and its frozen envelope."""
        rows, prompt = [], ""
        for t in conv_turns(conversation["id"]):
            if t["role"] == "user":
                prompt = t["content"]
            elif turn_ids is None or t["id"] in turn_ids:
                rows.append({
                    "conversation_id": conversation["id"], "turn_id": t["id"],
                    "prompt": prompt or conversation["title"],
                    "envelope": unj(t["envelope"]), "content": t["content"],
                })
        return rows

    # ------------------------------------------------------- identity/meta
    @app.get("/me")
    async def me():
        trees = db.all("SELECT id FROM trees")
        return {
            "user": {"id": "dev", "name": "Dev User", "email": "dev@skein.local"},
            "permissions": {t["id"]: ["view", "tune", "evaluate"] for t in trees},
        }

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok", "version": config.VERSION, "seed": app.state.seed}

    @app.get("/models")
    async def models(request: Request):
        # "/models is populated from a curated cheap-model list in live mode"
        # (docs/deployment.md:22-23); without a key, the static list as before.
        key, _ = live_headers(request)
        return config.LIVE_MODELS if key else config.MODELS

    # --------------------------------------------------------------- trees
    @app.get("/agenttrees")
    async def list_trees():
        return [{"id": t["id"], "name": t["name"], "enabled": bool(t["enabled"])}
                for t in db.all("SELECT * FROM trees ORDER BY rowid")]

    @app.post("/agenttrees", status_code=201)
    async def create_tree(request: Request):
        body = await body_json(request)
        if not body.get("name"):
            err(422, "invalid", "name is required.")
        tid = body.get("id") or new_id("tree")
        if db.one("SELECT 1 AS x FROM trees WHERE id = ?", (tid,)):
            err(422, "invalid", f"Tree '{tid}' already exists.")
        db.run("INSERT INTO trees (id, name, enabled, created_at) VALUES (?, ?, 1, ?)",
               (tid, body["name"], now_iso()))
        return {"id": tid, "name": body["name"], "enabled": True}

    @app.get("/agenttrees/{tree}/endpoints")
    async def list_endpoints(tree: str):
        need_tree(tree)
        return [{"id": e["id"], "name": e["name"], "description": e["description"]}
                for e in db.all("SELECT * FROM endpoints WHERE tree_id = ? ORDER BY rowid", (tree,))]

    # -------------------------------------------------------------- agents
    @app.get("/agenttrees/{tree}/agents")
    async def list_agents(tree: str):
        need_tree(tree)
        return [agent_dict(a) for a in db.all(
            "SELECT * FROM agents WHERE tree_id = ? ORDER BY rowid", (tree,))]

    @app.post("/agenttrees/{tree}/agents", status_code=201)
    async def create_agent(tree: str, request: Request):
        need_tree(tree)
        body = await body_json(request)
        if not body.get("name"):
            err(422, "invalid", "name is required.")
        parent_id = body.get("parent_id")
        if parent_id:
            need_agent(tree, parent_id)
        aid = new_id("ag")
        db.run(
            "INSERT INTO agents (id, tree_id, name, parent_id, tools, enabled, format)"
            " VALUES (?, ?, ?, ?, ?, 1, ?)",
            (aid, tree, body["name"], parent_id, j(body.get("tools") or []),
             body.get("format") or "text"))
        return agent_dict(db.one("SELECT * FROM agents WHERE id = ?", (aid,)))

    @app.get("/agenttrees/{tree}/agents/{agentId}/instructions")
    async def get_instructions(tree: str, agentId: str):
        agent = need_agent(tree, agentId)
        versions = db.all(
            "SELECT * FROM instruction_versions WHERE agent_id = ? ORDER BY version", (agentId,))
        return {
            "agent_id": agentId, "format": agent["format"], "live_version": live_version(agentId),
            "versions": [{
                "version": v["version"], "content": v["content"], "format": v["format"],
                "created_at": v["created_at"],
                "promoted_from_snapshot_id": v["promoted_from_snapshot_id"],
            } for v in versions],
        }

    @app.put("/agenttrees/{tree}/agents/{agentId}/instructions", status_code=201)
    async def save_instructions(tree: str, agentId: str, request: Request):
        agent = need_agent(tree, agentId)
        body = await body_json(request)
        if body.get("content") is None:
            err(422, "invalid", "content is required.")
        snapshot_id = body.get("snapshot_id")
        if snapshot_id:
            snap = db.one("SELECT * FROM snapshots WHERE snapshot_id = ? AND agent_id = ?",
                          (snapshot_id, agentId))
            if not snap:
                err(404, "not_found", f"Snapshot '{snapshot_id}' not found for this agent.")
        version = live_version(agentId) + 1
        fmt = body.get("format") or agent["format"]
        now = now_iso()
        db.run(
            "INSERT INTO instruction_versions (agent_id, version, content, format, created_at,"
            " promoted_from_snapshot_id) VALUES (?, ?, ?, ?, ?, ?)",
            (agentId, version, body["content"], fmt, now, snapshot_id))
        if snapshot_id:
            # Runs referencing the snapshot relabel to the new version (openapi.yaml:246-248).
            for r in db.all("SELECT id, columns FROM runs"):
                cols, changed = unj(r["columns"], []), False
                for col in cols:
                    if (col.get("config") or {}).get("snapshot_id") == snapshot_id:
                        col["label"], changed = f"v{version}", True
                if changed:
                    db.run("UPDATE runs SET columns = ? WHERE id = ?", (j(cols), r["id"]))
        return {"version": version, "content": body["content"], "format": fmt,
                "created_at": now, "promoted_from_snapshot_id": snapshot_id}

    @app.post("/agenttrees/{tree}/agents/{agentId}/snapshots", status_code=201)
    async def create_snapshot(tree: str, agentId: str, request: Request):
        need_agent(tree, agentId)
        body = await body_json(request)
        if body.get("content") is None:
            err(422, "invalid", "content is required.")
        sid = new_id("snap")[-4:]
        base = body.get("base_version")
        base = live_version(agentId) if base is None else base
        label = f"v{base}-draft ({sid})"
        now = now_iso()
        db.run(
            "INSERT INTO snapshots (snapshot_id, agent_id, content, base_version, label, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (sid, agentId, body["content"], base, label, now))
        return {"snapshot_id": sid, "agent_id": agentId, "label": label, "created_at": now}

    @app.get("/agenttrees/{tree}/agents/{agentId}/last-selection")
    async def get_last_selection(tree: str, agentId: str):
        need_agent(tree, agentId)
        row = db.one("SELECT items FROM selections WHERE agent_id = ?", (agentId,))
        return {"items": unj(row["items"], []) if row else []}

    @app.put("/agenttrees/{tree}/agents/{agentId}/last-selection")
    async def put_last_selection(tree: str, agentId: str, request: Request):
        need_agent(tree, agentId)
        body = await body_json(request)
        items = body.get("items")
        if not isinstance(items, list):
            err(422, "invalid", "items must be an array.")
        db.run("INSERT INTO selections (agent_id, items) VALUES (?, ?)"
               " ON CONFLICT(agent_id) DO UPDATE SET items = excluded.items",
               (agentId, j(items)))
        return {"items": items}

    # ------------------------------------------------------- conversations
    @app.get("/agenttrees/{tree}/conversations")
    async def list_conversations(tree: str, search: str | None = None, page: int = 1,
                                 page_size: int = 20, forks_of: str | None = None,
                                 agent_id: str | None = None, origin: str | None = None):
        need_tree(tree)
        page, page_size = max(1, page), min(max(1, page_size), 100)
        where, params = ["c.tree_id = ?", "c.deleted = 0"], [tree]
        if forks_of:
            where.append("json_extract(c.lineage, '$.parent_conversation_id') = ?")
            params.append(forks_of)
        else:
            # Roots only, so the sidebar nests forks without duplicates (openapi.yaml:346-349).
            where.append("c.lineage IS NULL")
        if agent_id:
            where.append("c.agent_id = ?")
            params.append(agent_id)
        if origin:
            where.append("c.origin = ?")
            params.append(origin)
        if search:
            like = f"%{search.lower()}%"
            where.append("(LOWER(c.title) LIKE ? OR EXISTS (SELECT 1 FROM turns t"
                         " WHERE t.conversation_id = c.id AND LOWER(t.content) LIKE ?))")
            params += [like, like]
        base = f"FROM conversations c WHERE {' AND '.join(where)}"
        total = db.one(f"SELECT COUNT(*) AS n {base}", params)["n"]
        rows = db.all(
            f"SELECT c.* {base} ORDER BY c.last_activity_at DESC, c.rowid DESC LIMIT ? OFFSET ?",
            [*params, page_size, (page - 1) * page_size])
        return {"items": [conversation_dict(c) for c in rows],
                "page": page, "page_size": page_size, "total": total}

    @app.get("/agenttrees/{tree}/conversations/{conversationId}")
    async def get_conversation(tree: str, conversationId: str):
        need_tree(tree)
        return conversation_dict(need_conversation(tree, conversationId))

    @app.patch("/agenttrees/{tree}/conversations/{conversationId}")
    async def rename_conversation(tree: str, conversationId: str, request: Request):
        need_tree(tree)
        conv = need_conversation(tree, conversationId)
        body = await body_json(request)
        if body.get("title"):
            db.run("UPDATE conversations SET title = ? WHERE id = ?", (body["title"], conv["id"]))
        return conversation_dict(db.one("SELECT * FROM conversations WHERE id = ?", (conv["id"],)),
                                 include_turns=False)

    @app.delete("/agenttrees/{tree}/conversations/{conversationId}", status_code=204)
    async def delete_conversation(tree: str, conversationId: str):
        need_tree(tree)
        conv = need_conversation(tree, conversationId)
        # Tombstone: judgments, eval cases and fork lineage survive (openapi.yaml:438-443).
        db.run("UPDATE conversations SET deleted = 1 WHERE id = ?", (conv["id"],))
        return Response(status_code=204)

    # ---------------------------------------------------------------- chat
    @app.post("/agenttrees/{tree}/chat")
    async def chat(tree: str, request: Request):
        need_tree(tree)
        body = await body_json(request)
        message = body.get("message")
        if not message:
            err(422, "invalid", "message is required.")
        stream = body.get("stream", True)

        # Idempotent retries for machine callers (openapi.yaml:1400-1407).
        cmid = body.get("client_message_id")
        if cmid:
            prior = db.one(
                "SELECT * FROM turns WHERE client_message_id = ? AND tree_id = ? AND role = 'user'",
                (cmid, tree))
            if prior:
                assistant = db.one(
                    "SELECT * FROM turns WHERE invocation_id = ? AND role = 'assistant'",
                    (prior["invocation_id"],))
                payload = {
                    "task_id": assistant["task_id"] if assistant else prior["task_id"],
                    "conversation_id": prior["conversation_id"],
                    "turn": turn_dict(assistant) if assistant else None,
                }
                if not stream:
                    return JSONResponse(payload)

                async def replay_gen():
                    yield sse("task", {
                        "task_id": payload["task_id"], "conversation_id": payload["conversation_id"],
                        "user_turn_id": prior["id"],
                        "assistant_turn_id": assistant["id"] if assistant else None,
                    })
                    yield sse("done", {"turn": payload["turn"], "status": "completed"})
                return StreamingResponse(replay_gen(), media_type="text/event-stream",
                                         headers={"Cache-Control": "no-cache"})

        conversation_id = body.get("conversation_id")
        if conversation_id:
            conv = need_conversation(tree, conversation_id)
        else:
            conv_id = new_id("conv")
            root = root_agent(tree)
            now = now_iso()
            db.run(
                "INSERT INTO conversations (id, tree_id, title, origin, channel, agent_id,"
                " created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (conv_id, tree, canned_title(message), body.get("origin") or "interactive",
                 body.get("channel"), root["id"] if root else None, now, now))
            conv = db.one("SELECT * FROM conversations WHERE id = ?", (conv_id,))

        agent_row = (db.one("SELECT * FROM agents WHERE id = ?", (conv["agent_id"],))
                     if conv["agent_id"] else None) or root_agent(tree)
        agent_name = agent_row["name"] if agent_row else "assistant"

        attachments = []
        for att_id in body.get("attachments") or []:
            att = db.one("SELECT * FROM attachments WHERE id = ?", (att_id,))
            if not att:
                err(404, "not_found", f"Attachment '{att_id}' not found.")
            attachments.append({"id": att["id"], "filename": att["filename"],
                                "content_type": att["content_type"], "size": att["size"],
                                "url": None})

        task = engine.create_task("chat")
        inv, now = new_id("inv"), now_iso()
        user_turn_id, assistant_turn_id = new_id("turn"), new_id("turn")
        # Envelope stamped at receipt for inbound turns (openapi.yaml:31, :1322-1324).
        db.run(
            "INSERT INTO turns (id, conversation_id, tree_id, invocation_id, role, author,"
            " content, created_at, envelope, attachments, client_message_id, task_id)"
            " VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?)",
            (user_turn_id, conv["id"], tree, inv, body.get("author") or "user", message,
             now, j(stamp_envelope()), j(attachments), cmid, task["id"]))
        db.run(
            "INSERT INTO turns (id, conversation_id, tree_id, invocation_id, role, author,"
            " content, created_at, envelope, task_id)"
            " VALUES (?, ?, ?, ?, 'assistant', ?, '', ?, ?, ?)",
            (assistant_turn_id, conv["id"], tree, inv, agent_name, now,
             j(stamp_envelope()), task["id"]))
        db.run("UPDATE conversations SET last_activity_at = ? WHERE id = ?", (now, conv["id"]))

        # P1-T18c: BYOK key rides in ctx for THIS request's generation only —
        # never persisted, never logged (docs/deployment.md:26-27).
        llm_key, llm_model = live_headers(request)
        ctx = {
            "task_id": task["id"], "conversation_id": conv["id"],
            "assistant_turn_id": assistant_turn_id, "prompt": message,
            "agent": agent_name, "model": body.get("model"),
            "system_prompt": body.get("system_prompt"),
            "temperature": body.get("temperature"),
            "llm_key": llm_key, "llm_model": llm_model,
        }

        if not stream:
            turn, status = None, "completed"
            async for kind, *data in engine.chat_events(ctx, streaming=False):
                if kind == "done":
                    turn, status = data
            return {"task_id": task["id"], "conversation_id": conv["id"], "turn": turn}

        async def stream_gen():
            # First event carries the task_id for stop = DELETE /tasks/{id} (openapi.yaml:467-470).
            yield sse("task", {"task_id": task["id"], "conversation_id": conv["id"],
                               "user_turn_id": user_turn_id,
                               "assistant_turn_id": assistant_turn_id})
            try:
                async for kind, *data in engine.chat_events(ctx, streaming=True):
                    if kind == "token":
                        yield sse("token", {"delta": data[0]})
                    else:
                        yield sse("done", {"turn": data[0], "status": data[1]})
            except Exception as exc:
                yield sse("error", {"code": "generation_failed", "message": str(exc)})

        return StreamingResponse(stream_gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/upload", status_code=201)
    async def upload(file: UploadFile = File(...)):
        data = await file.read()
        if len(data) > config.MAX_UPLOAD_BYTES:
            err(413, "too_large",
                f"File exceeds the {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit.")
        aid = new_id("att")
        db.run("INSERT INTO attachments (id, filename, content_type, size, data, created_at)"
               " VALUES (?, ?, ?, ?, ?, ?)",
               (aid, file.filename or "upload", file.content_type or "application/octet-stream",
                len(data), data, now_iso()))
        return {"id": aid, "filename": file.filename or "upload",
                "content_type": file.content_type or "application/octet-stream",
                "size": len(data), "url": None}

    @app.post("/feedback", status_code=201)
    async def feedback(request: Request):
        body = await body_json(request)
        rating = body.get("rating")
        if rating not in ("up", "down") or not body.get("message_id"):
            err(422, "invalid", "message_id and rating (up|down) are required.")
        turn = db.one("SELECT * FROM turns WHERE id = ?", (body["message_id"],))
        if not turn:
            err(404, "not_found", f"Turn '{body['message_id']}' not found.")
        jid, now = new_id("judg"), now_iso()
        # Thumbs persist as type:human judgments in the single store (openapi.yaml:562-571).
        db.run(
            "INSERT INTO judgments (id, turn_id, conversation_id, type, score, created_at)"
            " VALUES (?, ?, ?, 'human', ?, ?)",
            (jid, turn["id"], turn["conversation_id"], 1.0 if rating == "up" else 0.0, now))
        return judgment_dict(db.one("SELECT * FROM judgments WHERE id = ?", (jid,)))

    # ---------------------------------------------------------------- runs
    def build_run(tree: str, task_id: str, label: str, columns: list, rows: list) -> str:
        run_id = new_id("run")
        db.run("INSERT INTO runs (id, tree_id, task_id, label, created_at, columns)"
               " VALUES (?, ?, ?, ?, ?, ?)",
               (run_id, tree, task_id, label, now_iso(), j(columns)))
        for idx, row in enumerate(rows):
            db.run("INSERT INTO run_rows (run_id, row_idx, conversation_id, turn_id, prompt, envelope)"
                   " VALUES (?, ?, ?, ?, ?, ?)",
                   (run_id, idx, row["conversation_id"], row["turn_id"], row["prompt"],
                    j(row.get("envelope"))))
        return run_id

    @app.post("/agenttrees/{tree}/replay", status_code=202)
    async def replay(tree: str, request: Request):
        need_tree(tree)
        body = await body_json(request)
        selection, configs = body.get("selection"), body.get("configs")
        if not selection or not isinstance(selection, list):
            err(422, "invalid", "selection must be a non-empty array.")
        if not configs or not isinstance(configs, list):
            err(422, "invalid", "configs must be a non-empty array.")
        if body.get("context_policy", "frozen") != "frozen":
            err(422, "invalid", "Phase 1 replays always run frozen (openapi.yaml:1540-1546).")

        units, all_rows = [], []
        for item in selection:
            conv = need_conversation(tree, item.get("conversation_id"))
            rows = assistant_rows(conv, item.get("turn_ids"))
            if not rows:
                continue
            units.append((conv, rows))
        if not units:
            err(422, "invalid", "Selection contains no assistant turns to replay.")

        baseline = {}
        if body.get("baseline_run_id"):
            prior = db.one("SELECT * FROM runs WHERE id = ? AND tree_id = ?",
                           (body["baseline_run_id"], tree))
            if not prior:
                err(404, "not_found", f"Run '{body['baseline_run_id']}' not found.")
            last_col = len(unj(prior["columns"], [])) - 1
            for rr in db.all("SELECT * FROM run_rows WHERE run_id = ?", (prior["id"],)):
                cell = db.one(
                    "SELECT * FROM run_cells WHERE run_id = ? AND row_idx = ? AND col_idx = ?"
                    " AND status = 'done'", (prior["id"], rr["row_idx"], last_col))
                if cell and cell["content"]:
                    baseline[rr["turn_id"]] = cell["content"]

        columns = [{"label": "baseline", "config": {}}] + [
            {"label": config_label(cfg, i), "config": cfg} for i, cfg in enumerate(configs)]

        parent = engine.create_task("replay", total=len(units) * len(configs),
                                    payload={"result": None})
        register_live(parent["id"], request)
        row_specs = []
        for conv, rows in units:
            for row in rows:
                row["row_idx"] = len(row_specs)
                row_specs.append(row)
        run_id = build_run(tree, parent["id"], f"Replay · {len(configs)} config(s)",
                           columns, row_specs)
        db.run("UPDATE tasks SET payload = ? WHERE id = ?",
               (j({"result": {"run_id": run_id}}), parent["id"]))

        for row in row_specs:
            db.run("INSERT INTO run_cells (run_id, row_idx, col_idx, status, content,"
                   " conversation_id, turn_id) VALUES (?, ?, 0, 'done', ?, ?, ?)",
                   (run_id, row["row_idx"], baseline.get(row["turn_id"], row["content"]),
                    row["conversation_id"], row["turn_id"]))
            for col_idx in range(1, len(columns)):
                db.run("INSERT INTO run_cells (run_id, row_idx, col_idx, status)"
                       " VALUES (?, ?, ?, 'pending')", (run_id, row["row_idx"], col_idx))

        for col_idx, cfg in enumerate(configs, start=1):
            for ci, (conv, rows) in enumerate(units, start=1):
                agent_row = (db.one("SELECT * FROM agents WHERE id = ?", (cfg.get("agent_id"),))
                             if cfg.get("agent_id") else None)
                if not agent_row and conv["agent_id"]:
                    agent_row = db.one("SELECT * FROM agents WHERE id = ?", (conv["agent_id"],))
                engine.create_task("replay", parent_id=parent["id"], payload={
                    "kind": "replay_unit", "run_id": run_id, "tree_id": tree,
                    "col_idx": col_idx, "config": cfg,
                    "agent": agent_row["name"] if agent_row else "assistant",
                    "conv_index": ci, "conv_total": len(units),
                    "rows": [{"row_idx": r["row_idx"], "prompt": r["prompt"],
                              "envelope": r.get("envelope")} for r in rows],
                })
        engine.spawn(engine.run_batch(parent["id"]))
        return JSONResponse({"task_id": parent["id"], "run_id": run_id}, status_code=202)

    @app.post("/agenttrees/{tree}/replay/turn", status_code=202)
    async def replay_turn(tree: str, request: Request):
        need_tree(tree)
        body = await body_json(request)
        endpoints = body.get("endpoints")
        if not body.get("conversation_id") or not body.get("turn_id"):
            err(422, "invalid", "conversation_id and turn_id are required.")
        if not endpoints or not isinstance(endpoints, list):
            err(422, "invalid", "endpoints must be a non-empty array.")
        if body.get("context_policy", "frozen") != "frozen":
            err(422, "invalid", "Phase 1 replays always run frozen (openapi.yaml:1570-1574).")
        conv = need_conversation(tree, body["conversation_id"])
        turns = conv_turns(conv["id"])
        fork_turn = next((t for t in turns if t["id"] == body["turn_id"]), None)
        if not fork_turn:
            err(404, "not_found", f"Turn '{body['turn_id']}' not found in conversation.")
        ep_rows = []
        for eid in endpoints:
            ep = db.one("SELECT * FROM endpoints WHERE id = ? AND tree_id = ?", (eid, tree))
            if not ep:
                err(404, "not_found", f"Endpoint '{eid}' not found in tree '{tree}'.")
            ep_rows.append(ep)

        cfg = body.get("config") or {}
        # Prompt = last user turn strictly before the re-fired turn.
        prompt = None
        for t in turns:
            if t["id"] == fork_turn["id"]:
                break
            if t["role"] == "user":
                prompt = t["content"]
        prompt = prompt or fork_turn["content"]

        agent_row = (db.one("SELECT * FROM agents WHERE id = ?", (conv["agent_id"],))
                     if conv["agent_id"] else None) or root_agent(tree)
        agent_name = agent_row["name"] if agent_row else "assistant"

        columns = [{"label": "baseline", "config": {}}] + [
            {"label": ep["name"], "config": {**cfg, "endpoint_ids": [ep["id"]]}} for ep in ep_rows]
        parent = engine.create_task("replay_turn", total=len(ep_rows), payload={"result": None})
        register_live(parent["id"], request)
        row = {"conversation_id": conv["id"], "turn_id": fork_turn["id"], "prompt": prompt,
               "envelope": unj(fork_turn["envelope"])}
        run_id = build_run(tree, parent["id"], f"Re-fire · {len(ep_rows)} endpoint(s)",
                           columns, [row])
        db.run("UPDATE tasks SET payload = ? WHERE id = ?",
               (j({"result": {"run_id": run_id}}), parent["id"]))
        db.run("INSERT INTO run_cells (run_id, row_idx, col_idx, status, content,"
               " conversation_id, turn_id) VALUES (?, 0, 0, 'done', ?, ?, ?)",
               (run_id, fork_turn["content"], conv["id"], fork_turn["id"]))

        results = []
        now = now_iso()
        for col_idx, ep in enumerate(ep_rows, start=1):
            db.run("INSERT INTO run_cells (run_id, row_idx, col_idx, status)"
                   " VALUES (?, 0, ?, 'pending')", (run_id, col_idx))
            # Fork: copy history up to the re-fired turn, lineage attached
            # (openapi.yaml:631-639, feature-spec.md:68-69).
            fork_id = new_id("conv")
            lineage = {"parent_conversation_id": conv["id"], "fork_turn_id": fork_turn["id"],
                       "endpoint_id": ep["id"], "config": cfg or None}
            db.run(
                "INSERT INTO conversations (id, tree_id, title, origin, channel, agent_id,"
                " created_at, last_activity_at, lineage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (fork_id, tree, f"{conv['title']} · fork ({ep['name']})", conv["origin"],
                 conv["channel"], conv["agent_id"], now, now, j(lineage)))
            for t in turns:
                if t["id"] == fork_turn["id"]:
                    break
                db.run(
                    "INSERT INTO turns (id, conversation_id, tree_id, invocation_id, role,"
                    " author, content, content_type, created_at, envelope, attachments)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (new_id("turn"), fork_id, tree, t["invocation_id"], t["role"], t["author"],
                     t["content"], t["content_type"], t["created_at"], t["envelope"],
                     t["attachments"]))
            child = engine.create_task("replay_turn", parent_id=parent["id"], payload={
                "kind": "fork_unit", "run_id": run_id, "tree_id": tree, "row_idx": 0,
                "col_idx": col_idx, "config": cfg, "agent": agent_name,
                "fork_conversation_id": fork_id, "endpoint_id": ep["id"],
                "endpoint_name": ep["name"], "prompt": prompt,
                "envelope": unj(fork_turn["envelope"]),
            })
            results.append({"endpoint_id": ep["id"], "task_id": child["id"],
                            "conversation_id": fork_id})
        engine.spawn(engine.run_batch(parent["id"]))
        return JSONResponse({"run_id": run_id, "results": results}, status_code=202)

    @app.get("/agenttrees/{tree}/runs")
    async def list_runs(tree: str):
        need_tree(tree)
        out = []
        for r in db.all("SELECT * FROM runs WHERE tree_id = ? ORDER BY rowid DESC", (tree,)):
            task = engine.get_task(r["task_id"])
            out.append({"id": r["id"], "tree_id": r["tree_id"], "status": task["status"],
                        "created_at": r["created_at"], "task_id": r["task_id"],
                        "label": r["label"]})
        return out

    @app.get("/agenttrees/{tree}/runs/{runId}")
    async def get_run(tree: str, runId: str):
        need_tree(tree)
        r = db.one("SELECT * FROM runs WHERE id = ? AND tree_id = ?", (runId, tree))
        if not r:
            err(404, "not_found", f"Run '{runId}' not found.")
        return run_dict(r)

    # --------------------------------------------------------------- trace
    @app.get("/agenttrees/{tree}/turns/{turnId}/trace")
    async def get_trace(tree: str, turnId: str):
        need_tree(tree)
        turn = db.one("SELECT * FROM turns WHERE id = ? AND tree_id = ?", (turnId, tree))
        if not turn:
            err(404, "not_found", f"Turn '{turnId}' not found in tree '{tree}'.")
        spans = db.all("SELECT * FROM spans WHERE turn_id = ? ORDER BY rowid", (turnId,))
        tokens_in = sum(s["tokens_in"] or 0 for s in spans)
        tokens_out = sum(s["tokens_out"] or 0 for s in spans)
        cost = round(sum(s["cost"] or 0 for s in spans), 8)
        wall = 0
        if spans:
            from datetime import datetime
            starts = [datetime.fromisoformat(s["start_ts"].replace("Z", "+00:00")) for s in spans]
            ends = [datetime.fromisoformat((s["end_ts"] or s["start_ts"]).replace("Z", "+00:00"))
                    for s in spans]
            wall = int((max(ends) - min(starts)).total_seconds() * 1000)
        return {
            "turn_id": turnId, "envelope": unj(turn["envelope"]),
            "totals": {"wall_time_ms": wall, "tokens_in": tokens_in,
                       "tokens_out": tokens_out, "cost": cost},
            "spans": [span_dict(s) for s in spans],
        }

    @app.get("/spans/{spanId}/payload")
    async def get_span_payload(spanId: str):
        s = db.one("SELECT * FROM spans WHERE id = ?", (spanId,))
        if not s:
            err(404, "not_found", f"Span '{spanId}' not found.")
        return {"span_id": s["id"], "prompt": s["prompt"], "response": s["response"],
                "args": unj(s["args"]), "result": unj(s["result"])}

    # --------------------------------------------------------------- tasks
    @app.get("/tasks")
    async def list_tasks(status: str | None = None, parent_id: str | None = None,
                         limit: int = 50):
        where, params = [], []
        if parent_id:
            where.append("parent_id = ?")
            params.append(parent_id)
        else:
            where.append("parent_id IS NULL")
        if status:
            where.append("status = ?")
            params.append(status)
        rows = db.all(
            f"SELECT * FROM tasks WHERE {' AND '.join(where)} ORDER BY rowid DESC LIMIT ?",
            [*params, min(max(1, limit), 200)])
        return [task_dict(t) for t in rows]

    @app.get("/tasks/stream")
    async def stream_tasks():
        async def gen():
            q = broker.subscribe()
            try:
                yield ": connected\n\n"
                while True:
                    try:
                        event, data = await asyncio.wait_for(q.get(), timeout=15)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    yield sse(event, data)
            finally:
                broker.unsubscribe(q)
        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/tasks/{taskId}")
    async def get_task(taskId: str):
        task = engine.get_task(taskId)
        if not task:
            err(404, "not_found", f"Task '{taskId}' not found.")
        children = db.all("SELECT * FROM tasks WHERE parent_id = ? ORDER BY rowid", (taskId,))
        return task_dict(task, children=[task_dict(c) for c in children])

    @app.delete("/tasks/{taskId}")
    async def cancel_task(taskId: str):
        if not engine.get_task(taskId):
            err(404, "not_found", f"Task '{taskId}' not found.")
        task = engine.cancel(taskId)
        children = db.all("SELECT * FROM tasks WHERE parent_id = ? ORDER BY rowid", (taskId,))
        return task_dict(task, children=[task_dict(c) for c in children])

    @app.post("/tasks/{taskId}/retry-failed", status_code=202)
    async def retry_failed(taskId: str):
        task = engine.get_task(taskId)
        if not task:
            err(404, "not_found", f"Task '{taskId}' not found.")
        engine.spawn(engine.retry_failed(taskId))
        children = db.all("SELECT * FROM tasks WHERE parent_id = ? ORDER BY rowid", (taskId,))
        return JSONResponse(task_dict(engine.get_task(taskId),
                                      children=[task_dict(c) for c in children]),
                            status_code=202)

    # ---------------------------------------------------------------- eval
    @app.get("/eval/rubrics")
    async def list_rubrics():
        rows = db.all(
            "SELECT r.* FROM rubrics r WHERE r.version ="
            " (SELECT MAX(version) FROM rubrics WHERE id = r.id) ORDER BY r.rowid")
        return [{"id": r["id"], "name": r["name"], "version": r["version"],
                 "prompt": r["prompt"], "created_at": r["created_at"]} for r in rows]

    @app.post("/eval/rubrics", status_code=201)
    async def create_rubric(request: Request):
        body = await body_json(request)
        if not body.get("name") or not body.get("prompt"):
            err(422, "invalid", "name and prompt are required.")
        existing = db.one(
            "SELECT id, MAX(version) AS v FROM rubrics WHERE name = ? GROUP BY id",
            (body["name"],))
        if existing:
            rid, version = existing["id"], existing["v"] + 1
        else:
            rid, version = new_id("rub"), 1
        now = now_iso()
        db.run("INSERT INTO rubrics (id, name, version, prompt, created_at) VALUES (?, ?, ?, ?, ?)",
               (rid, body["name"], version, body["prompt"], now))
        return {"id": rid, "name": body["name"], "version": version,
                "prompt": body["prompt"], "created_at": now}

    @app.get("/eval/cases/{caseId}")
    async def get_case(caseId: str):
        c = db.one("SELECT * FROM eval_cases WHERE id = ?", (caseId,))
        if not c:
            err(404, "not_found", f"Eval case '{caseId}' not found.")
        return {"id": c["id"],
                "input": {"prompt": c["prompt"], "envelope": unj(c["envelope"])},
                "output": c["output"], "reference": c["reference"],
                "source": unj(c["source"]), "created_at": c["created_at"]}

    @app.post("/eval/judge", status_code=202)
    async def judge(request: Request):
        body = await body_json(request)
        if not body.get("judge_model") or not body.get("rubric_id"):
            err(422, "invalid", "judge_model and rubric_id are required.")
        run_id, case_ids = body.get("run_id"), body.get("case_ids")
        if bool(run_id) == bool(case_ids):
            err(422, "invalid", "Exactly one of run_id / case_ids is required (openapi.yaml:1865-1867).")
        versions = db.all("SELECT * FROM rubrics WHERE id = ? ORDER BY version", (body["rubric_id"],))
        if not versions:
            err(404, "not_found", f"Rubric '{body['rubric_id']}' not found.")
        if body.get("rubric_version") is not None:
            rubric = next((v for v in versions if v["version"] == body["rubric_version"]), None)
            if not rubric:
                err(404, "not_found",
                    f"Rubric '{body['rubric_id']}' has no version {body['rubric_version']}.")
        else:
            rubric = versions[-1]

        cases = []  # (case_id, run_id, turn_id, conversation_id)
        if run_id:
            r = db.one("SELECT * FROM runs WHERE id = ?", (run_id,))
            if not r:
                err(404, "not_found", f"Run '{run_id}' not found.")
            cells = db.all(
                "SELECT * FROM run_cells WHERE run_id = ? AND col_idx > 0 AND status = 'done'",
                (run_id,))
            for cell in cells:
                case_id = cell["case_id"]
                if not case_id:
                    # Auto-create cases from conversation turns (openapi.yaml:938-941).
                    row = db.one("SELECT * FROM run_rows WHERE run_id = ? AND row_idx = ?",
                                 (run_id, cell["row_idx"]))
                    case_id = new_id("case")
                    db.run(
                        "INSERT INTO eval_cases (id, prompt, envelope, output, source, created_at)"
                        " VALUES (?, ?, ?, ?, ?, ?)",
                        (case_id, row["prompt"], row["envelope"], cell["content"] or "",
                         j({"tree": r["tree_id"], "conversation_id": row["conversation_id"],
                            "turn_id": row["turn_id"]}), now_iso()))
                    db.run("UPDATE run_cells SET case_id = ? WHERE run_id = ? AND row_idx = ?"
                           " AND col_idx = ?", (case_id, run_id, cell["row_idx"], cell["col_idx"]))
                cases.append((case_id, run_id, cell["turn_id"], cell["conversation_id"]))
            if not cases:
                err(422, "invalid", "Run has no finished cells to judge yet.")
        else:
            for cid in case_ids:
                c = db.one("SELECT * FROM eval_cases WHERE id = ?", (cid,))
                if not c:
                    err(404, "not_found", f"Eval case '{cid}' not found.")
                source = unj(c["source"]) or {}
                cases.append((cid, None, source.get("turn_id"), source.get("conversation_id")))

        parent = engine.create_task("judge", total=len(cases),
                                    payload={"result": {"run_id": run_id}})
        register_live(parent["id"], request)
        for i, (case_id, rid_, turn_id, conversation_id) in enumerate(cases, start=1):
            engine.create_task("judge", parent_id=parent["id"], payload={
                "kind": "judge_case", "case_id": case_id, "run_id": rid_,
                "turn_id": turn_id, "conversation_id": conversation_id,
                "judge_model": body["judge_model"], "rubric_id": rubric["id"],
                "rubric_version": rubric["version"], "rubric_name": rubric["name"],
                "case_index": i, "case_total": len(cases),
            })
        engine.spawn(engine.run_batch(parent["id"]))
        return JSONResponse({"task_id": parent["id"]}, status_code=202)

    @app.get("/eval/judgments")
    async def list_judgments(case_id: str | None = None, run_id: str | None = None,
                             rubric_id: str | None = None, turn_id: str | None = None,
                             conversation_id: str | None = None,
                             page: int = 1, page_size: int = 50):
        where, params = ["1=1"], []
        for col, val in (("case_id", case_id), ("run_id", run_id), ("rubric_id", rubric_id),
                         ("turn_id", turn_id), ("conversation_id", conversation_id)):
            if val:
                where.append(f"{col} = ?")
                params.append(val)
        page, page_size = max(1, page), min(max(1, page_size), 200)
        rows = db.all(
            f"SELECT * FROM judgments WHERE {' AND '.join(where)}"
            " ORDER BY rowid DESC LIMIT ? OFFSET ?",
            [*params, page_size, (page - 1) * page_size])
        return [judgment_dict(r) for r in rows]

    @app.get("/eval/runs/{runId}/summary")
    async def run_summary(runId: str):
        if not db.one("SELECT 1 AS x FROM runs WHERE id = ?", (runId,)):
            err(404, "not_found", f"Run '{runId}' not found.")
        groups = db.all(
            "SELECT rubric_id, rubric_version, AVG(score) AS mean, COUNT(*) AS count"
            " FROM judgments WHERE run_id = ? AND type = 'llm'"
            " GROUP BY rubric_id, rubric_version", (runId,))
        rubrics = []
        for g in groups:
            scores = db.all(
                "SELECT score FROM judgments WHERE run_id = ? AND type = 'llm'"
                " AND rubric_id = ? AND rubric_version = ?",
                (runId, g["rubric_id"], g["rubric_version"]))
            distribution = [0, 0, 0, 0, 0]
            for s in scores:
                distribution[min(int(s["score"] * 5), 4)] += 1
            rubrics.append({"rubric_id": g["rubric_id"], "rubric_version": g["rubric_version"],
                            "mean": round(g["mean"], 4), "count": g["count"],
                            "distribution": distribution})
        return {"run_id": runId, "rubrics": rubrics}

    return app


app = create_app()
