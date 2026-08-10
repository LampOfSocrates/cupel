"""Cupel Phase-1 mock server — implements openapi.yaml v0.2.0 exactly.

Run: npm run mock  (uvicorn mock.main:app --port 4010, openapi.yaml:46)
"""

import asyncio
import hashlib
import json

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from starlette.datastructures import MutableHeaders

from . import auth, capabilities, config, llm, permissions, storage, tabular
from .db import Db, j, unj
from .engine import Broker, Engine, judgment_dict, span_dict, task_dict, turn_dict
from .seed import bootstrap
from .static import mount_spa, resolve_static_dir
from .util import (canned_title, clamp_page, like_term, new_id, now_iso, page_of, request_id,
                   sse, stamp_envelope)


def err(status: int, code: str, message: str, details: list[dict] | None = None):
    """Raise the ONE error body (openapi.yaml Error).

    `request_id` is NOT set here: this function has no request in scope, and
    threading one through every call site would be forty arguments to say the
    same thing. The exception handlers below stamp it from the scope the
    RequestId middleware put it on, so every error body carries it whether it
    came from a route, a validator or a gate.

    `details` is the machine-readable half — a list of ErrorDetail
    {field?, row?, message}. Omitted when there is nothing to point at (most
    404s); supplied when the caller can fix the input, which is what makes a
    422 actionable instead of a sentence.
    """
    body = {"code": code, "message": message}
    if details:
        body["details"] = details
    raise HTTPException(status, body)


def field_error(field: str, message: str) -> list[dict]:
    """The common case: one complaint about one named field."""
    return [{"field": field, "message": message}]


REQUEST_ID_HEADER = "x-request-id"


class RequestId:
    """Correlation id on EVERY response (openapi.yaml components.headers
    .XRequestId), and on every error body.

    Outermost middleware on purpose: the auth gate answers requests without
    ever reaching a route, and a 401 is exactly the response a user is most
    likely to be reporting. The id is put on the ASGI scope so that gate and
    the exception handlers can read it without a request object being passed
    around.

    Pure ASGI, not BaseHTTPMiddleware, for the same reason the auth gate is:
    BaseHTTPMiddleware buffers, which would break the two SSE endpoints.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        inbound = dict(scope["headers"]).get(REQUEST_ID_HEADER.encode(), b"").decode(
            "latin-1", "ignore")
        rid = request_id(inbound or None)
        scope.setdefault("state", {})["request_id"] = rid

        async def send_with_id(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["X-Request-Id"] = rid
            await send(message)

        return await self.app(scope, receive, send_with_id)


def scope_request_id(scope) -> str:
    return (scope.get("state") or {}).get("request_id", "")


def error_body(scope, body: dict) -> dict:
    """Stamp request_id onto an error body. Key order is deliberate — code,
    message, request_id, details — so a human reading raw JSON in a terminal
    sees the two things they need first."""
    out = {"code": body.get("code", "error"), "message": body.get("message", ""),
           "request_id": scope_request_id(scope)}
    if body.get("details"):
        out["details"] = body["details"]
    return out


def error_response(request, status: int, body: dict, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(error_body(request.scope, body), status_code=status, headers=headers)


class AuthGate:
    """AUTH_MODE=on enforcement (openapi.yaml:21-36). Pure ASGI, not
    BaseHTTPMiddleware, so SSE streaming/cancellation semantics are untouched.

    AUTH_MODE unset/"off" (the default — local dev, tests, the deployed
    Render demo): completely inert, zero behavior change. AUTH_MODE=on: a
    valid bearer JWT (mock/auth.py) is required on API paths; the verified
    users-table row is stashed in scope["state"]["cupel_user"] for handlers
    (/me) to read.

    What is gated (decision, documented): only paths whose FIRST SEGMENT is a
    known API root (API_ROOTS below). Everything else — the SPA catch-all
    (/, /login, /chat/..., index.html), bundle assets, favicons — stays open
    so the login screen can render before any token exists. Explicitly open
    even within API roots: GET /healthz and POST /auth/token, the contract's
    only two security:[] operations (openapi.yaml:23-25), plus OPTIONS (CORS
    preflight carries no credentials). /openapi.json is not an API root and
    thus open: it is the contract itself, probed by cupel-ready/switcher
    tooling before login, and carries no data.

    Tree permission enforcement is centralized HERE: /agenttrees/{tree}/...
    without "view" on {tree} → 404 not_found — "unpermitted trees never
    render" (openapi.yaml:1948 NotFound: "Resource not found (or tree not
    permitted)"). Handlers keep their existing need_tree checks unchanged.
    """

    OPEN_PATHS = {"/healthz", "/auth/token"}
    API_ROOTS = {"me", "auth", "models", "agenttrees", "upload", "feedback",
                 "tasks", "eval", "spans", "admin", "settings"}

    def __init__(self, app, db: Db):
        self.app = app
        self.db = db

    async def _reject(self, scope, receive, send, status, code, message):
        response = JSONResponse(error_body(scope, {"code": code, "message": message}),
                                status_code=status)
        await response(scope, receive, send)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not auth.auth_on():
            return await self.app(scope, receive, send)
        path = scope["path"]
        segment = path.split("/", 2)[1] if "/" in path else ""
        if (path in self.OPEN_PATHS or scope["method"] == "OPTIONS"
                or segment not in self.API_ROOTS):
            return await self.app(scope, receive, send)

        header = dict(scope["headers"]).get(b"authorization", b"").decode()
        token = header[7:] if header.lower().startswith("bearer ") else ""
        claims = auth.decode_jwt(token) if token else None
        user = auth.user_by_id(self.db, claims["sub"]) if claims else None
        if not user:
            return await self._reject(scope, receive, send, 401, "unauthorized",
                                      "Missing, invalid or expired bearer token.")

        parts = path.split("/")
        if segment == "agenttrees" and len(parts) > 2 and parts[2]:
            permissions = unj(user["permissions"], {})
            if "view" not in permissions.get(parts[2], []):
                # Unpermitted tree = not_found, indistinguishable from absent
                # (openapi.yaml:1948) — message mirrors need_tree's.
                return await self._reject(
                    scope, receive, send, 404, "not_found",
                    f"Agent tree '{parts[2]}' not found.")

        scope.setdefault("state", {})["cupel_user"] = user
        return await self.app(scope, receive, send)


class PermissionGate:
    """Per-operation permission enforcement — openapi.yaml `x-requires`, table
    in mock/permissions.py.

    Runs in BOTH auth modes, which is the whole design. The AuthGate above is
    inert with AUTH_MODE=off; this one is not, because the answer does not come
    from the mode, it comes from the permission matrix: a verified user brings
    their own, and an unverified caller IS the dev user, who holds every
    permission on every tree and both roles (feature-spec.md:17, same rule
    request_roles/permitted_trees follow). So an off-mode request runs this
    code and is allowed, rather than skipping it — no branch, and the path that
    matters is exercised by every local test run.

    What it does NOT do, deliberately: anything about `view`. A caller without
    view on {tree} was already answered 404 by the AuthGate, and that 404 is a
    security property — an unpermitted tree must stay indistinguishable from an
    absent one. Adding a 403 here for view would undo it, so `view` and `none`
    are pass-through and permissions.ENFORCED contains neither.

    Placement: innermost gate (registered first, so it ends up nearest the
    app), because it needs the users row the AuthGate stashed on the scope.
    Pure ASGI like the other two, so SSE streaming is untouched — and it runs
    before routing, which is why permissions.py matches path TEMPLATES with
    regexes rather than reading a resolved route.
    """

    def __init__(self, app, db: Db):
        self.app = app
        self.db = db

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] == "OPTIONS":
            return await self.app(scope, receive, send)
        found = permissions.requirement(scope["method"], scope["path"])
        if found is None:
            return await self.app(scope, receive, send)
        requires, _template = found
        user = scope.get("state", {}).get("cupel_user")
        if user is not None:
            if requires in permissions.ROLES:
                held = requires in unj(user["roles"], [])
            else:
                tree = permissions.tree_of(scope["path"])
                held = requires in unj(user["permissions"], {}).get(tree, [])
            if not held:
                response = JSONResponse(
                    error_body(scope, {
                        "code": "forbidden",
                        "message": permissions.refusal(
                            requires, permissions.tree_of(scope["path"])),
                    }),
                    status_code=403)
                return await response(scope, receive, send)
        return await self.app(scope, receive, send)


async def body_json(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        err(422, "invalid", "Request body must be valid JSON.")
    if not isinstance(body, dict):
        err(422, "invalid", "Request body must be a JSON object.")
    return body


def create_app(db_path: str | None = None, token_delay: float | None = None,
               step_delay: float | None = None, static_dir: str | None = None) -> FastAPI:
    # cupel-phases.md:98: the mock "ships its own OpenAPI file —
    # which the readiness script validates against Cupel's contract as the
    # first conformance test". FastAPI auto-generates the spec from the
    # routes; handlers have no response_model, so schemas are loose ({}) and
    # conformance sees path/method/param presence (documented in
    # docs/readiness.md). Docs UI stays off.
    app = FastAPI(title="Cupel mock", version=config.VERSION,
                  openapi_url="/openapi.json", docs_url=None, redoc_url=None)
    db = Db(db_path or config.DB_PATH)
    # add_middleware PREPENDS, so registration order is inner→outer. Final
    # stack: RequestId (outermost — so even a gate's 401 is traceable) → CORS
    # (preflight answered early; every 401 still carries CORS headers) →
    # AuthGate (per-user JWT when AUTH_MODE=on) → PermissionGate
    # (per-operation x-requires, BOTH modes) → app. PermissionGate is
    # innermost because it reads the user the AuthGate resolved. The hosted
    # demo's own access control is a mount, not a gate — see mock/root.py.
    app.add_middleware(PermissionGate, db=db)
    app.add_middleware(AuthGate, db=db)
    # expose_headers: without it a browser cannot READ ETag or X-Request-Id off
    # a cross-origin response, so the evaluation grid's conditional poll would
    # never send an If-None-Match (the 304 path dead), and the request id a
    # user is meant to quote would be invisible to the UI — in the one
    # deployment (UI on :5173, API on :4010) that this mock exists for.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                       allow_headers=["*"], expose_headers=["ETag", "X-Request-Id"])
    app.add_middleware(RequestId)

    seed_label = bootstrap(db)
    broker = Broker()
    engine = Engine(db, broker, token_delay=token_delay, step_delay=step_delay)
    app.state.db, app.state.engine, app.state.seed = db, engine, seed_label

    @app.exception_handler(HTTPException)
    async def http_exc(request, exc):
        detail = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
        # exc.headers survives: the 429 door carries Retry-After, which is the
        # only actionable half of a rate-limit answer.
        return error_response(request, exc.status_code, detail, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_exc(request, exc):
        """FastAPI's own 422 — a query parameter outside its declared type
        (?page=abc), or a missing multipart field. Its errors carry a `loc`
        tuple, which is exactly ErrorDetail.field once flattened, so the
        machine-readable half comes for free rather than being thrown away
        into str(exc)."""
        details = []
        for e in exc.errors():
            loc = [str(p) for p in e.get("loc", []) if p not in ("query", "body", "path", "header")]
            details.append({"field": ".".join(loc) or None, "message": e.get("msg", "invalid")})
        summary = "; ".join(
            f"{d['field']}: {d['message']}" if d["field"] else d["message"] for d in details)
        return error_response(request, 422, {
            "code": "invalid",
            "message": summary or "Request could not be validated.",
            "details": details,
        })

    # ------------------------------------------------------------- helpers
    def live_headers(request: Request) -> tuple[str | None, str | None]:
        """(key, model) from X-LLM-Key / X-LLM-Model. The headers are
        transport-level BY DESIGN (docs/deployment.md:26) — deliberately
        outside the openapi.yaml contract. The key is returned into the
        caller's stack frame only: never stored on app.state or the DB, never
        logged (docs/deployment.md:27). MOCK_LIVE_DISABLED=1 kills the
        feature entirely."""
        if config.live_disabled():
            return None, None
        return (request.headers.get("x-llm-key") or None,
                request.headers.get("x-llm-model") or None)

    def need_live_budget(request: Request) -> None:
        """The 429 DOOR (openapi.yaml responses.TooManyRequests).

        Called first by the five operations that can start live generation,
        before a turn row, a task or an evaluation exists. Only a request
        actually carrying a BYOK key is limited — a canned-content request
        costs nothing and has never been limited. The check does not consume
        budget, so asking is free and a 429 leaves the caller's allowance
        exactly where it was.

        Why at the door rather than where the limit is enforced: generation
        happens after the response has been committed (a 200 SSE stream, or a
        202 with a task id), so the deep call site CANNOT answer 429 — which
        is why it used to serve canned content instead and tell the caller
        nothing. Retry-After is advisory and derived from the oldest entry in
        the window."""
        key, _ = live_headers(request)
        if not key:
            return
        seconds = llm.retry_after(key)
        if seconds is None:
            return
        raise HTTPException(429, {
            "code": "rate_limited",
            "message": f"Live generation rate limit reached — retry in {seconds}s.",
        }, headers={"Retry-After": str(seconds)})

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

    def turn_count(conversation_id: str) -> int:
        return db.one("SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?",
                      (conversation_id,))["n"]

    def conversation_dict(c: dict) -> dict:
        """The conversation RESOURCE — metadata only.

        Turns are their own paged collection (listTurns). This function used
        to take include_turns and default it True, which is why the sidebar
        listing carried every turn of every row; the flag is gone rather than
        flipped, so no caller can reintroduce the unbounded body."""
        return {
            "id": c["id"], "tree_id": c["tree_id"], "title": c["title"],
            "origin": c["origin"], "channel": c["channel"], "agent_id": c["agent_id"],
            "created_at": c["created_at"], "last_activity_at": c["last_activity_at"],
            "lineage": unj(c["lineage"]), "fork_count": fork_count(c["id"]),
            "turn_count": turn_count(c["id"]), "deleted": bool(c["deleted"]),
        }

    def need_conversation(tree: str, conversation_id: str) -> dict:
        """A conversation INCLUDING a tombstone — the READ path.

        Deletion is soft and the tombstone answers: Conversation.deleted says
        so, and the row keeps answering because a fork's lineage, an eval-set
        reference item, an eval case's source and a judgment's subject all
        point INTO it. 404 keeps meaning what it says — no such conversation,
        or not in this tree. Writers call need_live_conversation instead."""
        row = db.one(
            "SELECT * FROM conversations WHERE id = ? AND tree_id = ?",
            (conversation_id, tree))
        if not row:
            err(404, "not_found", f"Conversation '{conversation_id}' not found.")
        return row

    def need_live_conversation(tree: str, conversation_id: str) -> dict:
        """need_conversation + the tombstone gate for WRITE work: a deleted
        conversation answers 409 conversation_deleted on rename, chat, replay
        and fork, exactly as a disabled tree answers 409 tree_disabled. 404
        (absent) wins over 409 (deleted), the same precedence need_enabled_tree
        uses."""
        row = need_conversation(tree, conversation_id)
        if row["deleted"]:
            err(409, "conversation_deleted",
                f"Conversation '{conversation_id}' is deleted — it reads, but takes no new work.")
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

    def evaluation_dict(r: dict, page: int = 1, page_size: int = 50) -> dict:
        """One PAGE of the grid. The body is a product — rows × columns ×
        cells — and clients poll it while the evaluation fills, so the whole
        grid was the wrong unit. Rows page safely because an evaluation's row
        set is written once at creation and never grows; only the cells
        change."""
        page, page_size = clamp_page(page, page_size, 200)
        total = db.one("SELECT COUNT(*) AS n FROM evaluation_rows WHERE evaluation_id = ?",
                       (r["id"],))["n"]
        rows = db.all(
            "SELECT * FROM evaluation_rows WHERE evaluation_id = ?"
            " ORDER BY row_idx LIMIT ? OFFSET ?",
            (r["id"], page_size, (page - 1) * page_size))
        out_rows = []
        for row in rows:
            cells = db.all(
                "SELECT * FROM evaluation_cells WHERE evaluation_id = ? AND row_idx = ? ORDER BY col_idx",
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
            # status is DERIVED from the owning task, never stored
            # (engine.evaluation_status; openapi.yaml Evaluation.status is
            # readOnly). Task is the single writer of execution state.
            "id": r["id"], "tree_id": r["tree_id"],
            "status": engine.evaluation_status(r["id"], r["task_id"]),
            "created_at": r["created_at"], "task_id": r["task_id"],
            "columns": unj(r["columns"], []),
            "rows": page_of(out_rows, page, page_size, total),
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

    # ---------------------------------------------------------------- auth
    def request_user(request: Request) -> dict | None:
        """The AuthGate-verified users row (AUTH_MODE=on), else None —
        handlers never read AUTH_MODE themselves."""
        return request.scope.get("state", {}).get("cupel_user")

    def request_roles(request: Request) -> list:
        """Global roles of the caller. No verified user (an off-mode backend
        never populates one) = the dev user, who IS admin+inspect
        (feature-spec.md:17 "default admin = all trees, all rights") — same
        roles GET /me advertises, so the UI and the gate agree."""
        user = request_user(request)
        return unj(user["roles"], []) if user else ["admin", "inspect"]

    def permitted_trees(request: Request) -> set[str] | None:
        """Trees the caller may view, or None for "every tree, present and
        future". Same matrix GET /me and GET /agenttrees (:454-457) answer
        with — a verified user gets their own permissions, an unverified
        caller is the dev user, who holds view everywhere
        (feature-spec.md:17). One code path, not a mode branch: the answer
        comes from the permission matrix in both modes.

        Used by the endpoints that address data OUTSIDE /agenttrees/{tree}/…,
        where the AuthGate has no tree in the path to enforce on:
        /tasks/stream and /spans/{id}/payload."""
        user = request_user(request)
        if not user:
            return None
        return {t for t, perms in unj(user["permissions"], {}).items() if "view" in perms}

    # need_admin/need_inspect USED TO LIVE HERE. The admin role on /admin/* and
    # the inspect role on the Inspector are now enforced by PermissionGate from
    # the contract's own `x-requires`, alongside the per-tree permissions — one
    # gate, one table, one place a new operation's requirement is written. Two
    # enforcement points would mean a handler and a declaration that can
    # disagree, which is the drift this stage exists to remove. The 403s are
    # unchanged (code forbidden, same message) and mock/tests/test_admin.py
    # still pins them.

    def conversation_owner(request: Request, body: dict) -> str:
        """The owning user stamped on a new conversation
        (AdminConversationItem.user_id, openapi.yaml:3139).

        Resolution order (documented, one code path — never a mode branch):
        1. the AuthGate-verified user — a real signed-in owner;
        2. else the chat body's `author`, which is how machine callers name the
           end user they act for (mock/generator.py:43 seeds six personas, so
           the Inspector's cross-user filter has real variety in the demo);
        3. else "dev", the off-mode identity GET /me already advertises.
        Forks inherit the parent conversation's owner."""
        user = request_user(request)
        if user:
            return user["id"]
        author = (body or {}).get("author")
        if isinstance(author, str) and author.strip() and author != "user":
            return author
        return "dev"

    def audit_inspect(request: Request, filters: dict, result_count: int) -> None:
        """"EVERY access is audit-logged server-side" (openapi.yaml:308-309).

        Chosen mechanism (documented): a durable `inspect_audit` row (who,
        the exact filters, how many rows came back, when) PLUS one stdout line
        so it also lands in the container log. The contract declares no
        endpoint that reads audit records back, and inventing one would break
        the "implement the contract exactly" rule — so the trail is
        server-side only: `sqlite3 mock/cupel-mock.sqlite 'SELECT * FROM inspect_audit'`
        or the server log. A real backend would ship these to its SIEM."""
        user = request_user(request)
        uid = user["id"] if user else "dev"
        email = user["email"] if user else "dev@cupel.local"
        db.run(
            "INSERT INTO inspect_audit (id, user_id, email, filters, result_count,"
            " created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (new_id("audit"), uid, email, j(filters), result_count, now_iso()))
        print(f"[audit] inspect user={uid} email={email} "
              f"filters={json.dumps(filters, sort_keys=True)} results={result_count}",
              flush=True)

    def need_enabled_tree(tree: str) -> dict:
        """need_tree + the disable gate for WRITE work: a disabled
        tree answers 409 tree_disabled (openapi.yaml:1974-1979) on new work,
        while every GET keeps working — "new chat/replay/judge against it
        return 409 tree_disabled; existing conversations stay READABLE"
        (feature-spec.md:20). Blocked writes (documented set): chat, replay,
        replay/turn, judge-on-an-evaluation-of-this-tree, create agent, POST
        instruction versions, POST snapshots, PUT last-selection, and conversation
        rename/delete (history is read-only, not just readable). Feedback
        stays allowed — a thumb annotates existing history, it creates no
        new work. 404 (absent tree) wins over 409."""
        row = need_tree(tree)
        if not row["enabled"]:
            err(409, "tree_disabled",
                f"Agent tree '{tree}' is disabled — history is read-only.")
        return row

    @app.post("/auth/token")
    async def create_token(request: Request):
        """POST /auth/token (openapi.yaml:96-128): open endpoint (security: [])
        — "a client cannot hold a token before logging in" (:105-106).
        Credentials are validated against the seeded users in BOTH modes
        ("With AUTH_MODE=off the endpoint still answers ... so the login flow
        stays testable", :109-111); bad credentials → 401 invalid_credentials
        (:124-125)."""
        body = await body_json(request)
        email, password = body.get("email"), body.get("password")
        if not email or not password:
            err(422, "invalid", "email and password are required.",
                field_error("email", "email and password are required."))
        # First-auth-request seeding for pre-existing DBs (mock/auth.py).
        auth.ensure_users(db)
        user = auth.find_user(db, email)
        if not user or not auth.verify_password(password, user["password_hash"]):
            err(401, "invalid_credentials", "Invalid email or password.")
        token, expires_in = auth.issue_token(user)
        return {"access_token": token, "token_type": "bearer",
                "expires_in": expires_in, "me": auth.me_payload(user)}

    @app.post("/auth/logout", status_code=204)
    async def logout():
        """POST /auth/logout (openapi.yaml:130-144). The mock's JWTs are
        STATELESS — there is no server-side session to invalidate, so this is
        a 204 no-op in both modes; the endpoint exists for contract parity
        and the client discards its token ("the client then drops it and
        returns to login", :138-139). In auth-on mode the AuthGate already
        401s a missing/invalid token before this handler runs."""
        return Response(status_code=204)

    # ------------------------------------------------------- identity/meta
    @app.get("/me")
    async def me(request: Request):
        """GET /me (openapi.yaml:147-166): "answers in both auth modes".
        AUTH_MODE=on → the token's user with their roles+permissions;
        off → the dev user, which advertises roles
        [admin, inspect] — "off = instant dev as a chosen user ... default
        admin = all trees, all rights" (feature-spec.md:17), and roles is
        the additive-optional v0.3.0 Me field (openapi.yaml:2004-2012) that
        gates the Settings → Members / Agent trees UI role-driven, never
        mode-driven."""
        user = request_user(request)
        if user:
            return auth.me_payload(user)
        trees = db.all("SELECT id FROM trees")
        return {
            "user": {"id": "dev", "name": "Dev User", "email": "dev@cupel.local"},
            "roles": ["admin", "inspect"],
            "permissions": {t["id"]: ["view", "tune", "evaluate"] for t in trees},
        }

    @app.get("/healthz")
    async def healthz():
        """`storage` reports the EFFECTIVE storage mode and, in s3
        mode, whether this boot restored the database from the replica
        (openapi.yaml Health.storage — optional, additive; backends that omit
        it stay conformant). Read from the env per call, like
        config.live_disabled(), so it reflects what mock/boot.py actually
        decided rather than what was requested at import time."""
        return {"status": "ok", "version": config.VERSION,
                # Which contract, and how much of it this backend really
                # serves — openapi.yaml Health.contract_version /
                # capabilities. Declared in mock/capabilities.py and guarded
                # against the contract by test_ready.py, so `full` is never a
                # claim nobody checked.
                "contract_version": capabilities.CONTRACT_VERSION,
                "capabilities": capabilities.CAPABILITIES,
                "seed": app.state.seed,
                "storage": storage.health_storage()}

    @app.get("/models")
    async def models(request: Request):
        # "/models is populated from a curated cheap-model list in live mode"
        # (docs/deployment.md:22-23); without a key, the static list as before.
        key, _ = live_headers(request)
        return config.LIVE_MODELS if key else config.MODELS

    # --------------------------------------------------------------- trees
    @app.get("/agenttrees")
    async def list_trees(request: Request):
        """GET /agenttrees (openapi.yaml:437-454): "Permitted agent trees".
        AUTH_MODE=on filters to trees the token's user can view — "GET
        /agent-trees returns only permitted trees; unpermitted trees never
        render" (feature-spec.md:32). Also "permitted + enabled; admins
        also see disabled" (feature-spec.md:117) — non-admins additionally
        lose disabled trees; admins get them with enabled:false
        (openapi.yaml:443-446). Off mode: the dev user is admin, so all
        trees, disabled included."""
        rows = db.all("SELECT * FROM trees ORDER BY rowid")
        user = request_user(request)
        if user:
            permissions = unj(user["permissions"], {})
            rows = [t for t in rows if "view" in permissions.get(t["id"], [])]
        if "admin" not in request_roles(request):
            rows = [t for t in rows if t["enabled"]]
        return [{"id": t["id"], "name": t["name"], "enabled": bool(t["enabled"])}
                for t in rows]

    @app.post("/agenttrees", status_code=201)
    async def create_tree(request: Request):
        body = await body_json(request)
        if not body.get("name"):
            err(422, "invalid", "name is required.",
                field_error("name", "name is required."))
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

    # --------------------------------------------------------------- admin
    # Users, permission matrices, tree enable/disable
    # (openapi.yaml:168-296). Every operation is admin-gated (403 forbidden
    # otherwise); in off mode the dev user IS admin (request_roles above).
    # Permission updates take effect on the target user's NEXT request — the
    # AuthGate re-reads the users row per request, so their next GET /me
    # reflects it (openapi.yaml:246-250 "Takes effect on the user's next
    # request"); there is no live push.
    def admin_user_dict(u: dict) -> dict:
        """AdminUser (openapi.yaml:3009-3025) — roles only; per-tree rights
        live in the permission matrix endpoint."""
        return {"id": u["id"], "name": u["name"], "email": u["email"],
                "roles": unj(u["roles"], []), "invited": bool(u["invited"]),
                "created_at": u["created_at"]}

    @app.get("/admin/users")
    async def list_users(request: Request, page: int = 1, page_size: int = 50):
        """listUsers — a page of users, cross-user (admin-only). Ordered by
        email so the page boundary is stable while invites are being created;
        rowid order would reshuffle the tail on every invite."""
        auth.ensure_users(db)
        page, page_size = clamp_page(page, page_size, 100)
        total = db.one("SELECT COUNT(*) AS n FROM users")["n"]
        rows = db.all("SELECT * FROM users ORDER BY email LIMIT ? OFFSET ?",
                      (page_size, (page - 1) * page_size))
        return page_of([admin_user_dict(u) for u in rows], page, page_size, total)

    @app.put("/admin/users")
    async def put_users(request: Request):
        """PUT /admin/users (openapi.yaml:190-218): "upsert keyed by email: a
        new email creates an invited user ...; an existing email updates
        name/roles. Users absent from the body are untouched, and there is
        no user delete". Invited users carry an unusable password hash (the
        mock has no set-password flow — they exist for the Members list and
        permission assignment until a real IdP takes over)."""
        try:
            body = await request.json()
        except Exception:
            err(422, "invalid", "Request body must be valid JSON.")
        if not isinstance(body, list) or not body:
            err(422, "invalid", "Body must be a non-empty array of user upserts.")
        out = []
        for item in body:
            if not isinstance(item, dict) or not item.get("email"):
                err(422, "invalid", "Each upsert requires an email.")
            existing = auth.find_user(db, item["email"])
            if existing:
                # Null name/roles = leave unchanged (openapi.yaml:3033).
                name = item.get("name") or existing["name"]
                roles = item["roles"] if item.get("roles") is not None \
                    else unj(existing["roles"], [])
                db.run("UPDATE users SET name = ?, roles = ? WHERE id = ?",
                       (name, j(roles), existing["id"]))
                uid = existing["id"]
            else:
                uid = new_id("u")
                db.run(
                    "INSERT INTO users (id, email, name, password_hash, roles,"
                    " permissions, invited, created_at) VALUES (?, ?, ?, '', ?,"
                    " '{}', 1, ?)",
                    (uid, item["email"], item.get("name") or item["email"],
                     j(item.get("roles") or []), now_iso()))
            out.append(admin_user_dict(auth.user_by_id(db, uid)))
        return out

    @app.get("/admin/users/{userId}/permissions")
    async def get_user_permissions(userId: str, request: Request):
        """GET /admin/users/{userId}/permissions (openapi.yaml:220-240):
        "Same shape as Me.permissions so the admin UI and /me agree"."""
        user = auth.user_by_id(db, userId)
        if not user:
            err(404, "not_found", f"User '{userId}' not found.")
        return {"user_id": user["id"], "permissions": unj(user["permissions"], {})}

    @app.put("/admin/users/{userId}/permissions")
    async def put_user_permissions(userId: str, request: Request):
        """PUT (openapi.yaml:241-265): "Full replacement of the matrix ...
        Takes effect on the user's next request — their GET /me reflects it,
        and unpermitted trees stop rendering"."""
        user = auth.user_by_id(db, userId)
        if not user:
            err(404, "not_found", f"User '{userId}' not found.")
        body = await body_json(request)
        permissions = body.get("permissions")
        if not isinstance(permissions, dict) or not all(
                isinstance(v, list) and set(v) <= {"view", "tune", "evaluate"}
                for v in permissions.values()):
            err(422, "invalid",
                "permissions must map tree ids to arrays of view|tune|evaluate.")
        db.run("UPDATE users SET permissions = ? WHERE id = ?",
               (j(permissions), userId))
        return {"user_id": userId, "permissions": permissions}

    @app.patch("/admin/agenttrees/{treeId}")
    async def toggle_tree(treeId: str, request: Request):
        """PATCH /admin/agenttrees/{treeId} {enabled} (openapi.yaml:267-296):
        toggles availability, never data. Disabling also cancels this tree's
        queued/running batch work — "queued tasks on it are cancelled"
        (feature-spec.md:20): every evaluation-owning task (replay/replay_turn via
        evaluations.task_id, judge via its payload's result.evaluation_id) is cancelled;
        chat tasks are sub-second in the mock and simply drain."""
        row = db.one("SELECT * FROM trees WHERE id = ?", (treeId,))
        if not row:
            err(404, "not_found", f"Agent tree '{treeId}' not found.")
        body = await body_json(request)
        enabled = body.get("enabled")
        if not isinstance(enabled, bool):
            err(422, "invalid", "enabled (boolean) is required.",
                field_error("enabled", "enabled (boolean) is required."))
        db.run("UPDATE trees SET enabled = ? WHERE id = ?",
               (1 if enabled else 0, treeId))
        if not enabled:
            stale = db.all(
                "SELECT id FROM tasks WHERE status IN ('queued', 'running')"
                " AND parent_id IS NULL AND (id IN (SELECT task_id FROM evaluations"
                " WHERE tree_id = ?) OR json_extract(payload,"
                " '$.result.evaluation_id') IN (SELECT id FROM evaluations WHERE tree_id = ?))",
                (treeId, treeId))
            for t in stale:
                engine.cancel(t["id"])
        return {"id": row["id"], "name": row["name"], "enabled": enabled}

    # --------------------------------------------------- Inspector (admin)
    # GET /admin/conversations (openapi.yaml:298-348) — "Inspector — every
    # conversation, cross-user … filter by user, tree, date, or score …
    # requires the inspect role, audit-logged".
    #
    # Latest-judgment score per conversation, as SQL so score_min/score_max can
    # filter on it. A judgment counts if it is scoped to the conversation (the
    # denormalized column, mock/db.py judgments) or if its SUBJECT is one of
    # the conversation's turns — both count (AdminConversationItem.latest_score,
    # "Latest judgment score across the conversation's turns"). Newest wins:
    # judgments are append-only, so MAX(rowid).
    LATEST_SCORE_SQL = (
        "(SELECT jg.score FROM judgments jg WHERE jg.conversation_id = c.id"
        "  OR (jg.subject_kind = 'turn' AND jg.subject_id IN"
        "      (SELECT t.id FROM turns t WHERE t.conversation_id = c.id))"
        " ORDER BY jg.rowid DESC LIMIT 1)")

    @app.get("/admin/conversations")
    async def list_admin_conversations(
            request: Request, user_id: str | None = None, tree: str | None = None,
            date_from: str | None = None, date_to: str | None = None,
            score_min: float | None = None, score_max: float | None = None,
            page: int = 1, page_size: int = 50):
        """Cross-user conversation listing behind the inspect role.

        Two scoping decisions, documented because the contract leaves them
        open:

        1. The inspect role widens the USER dimension, not the TREE dimension.
           A caller still sees only trees their permission matrix grants
           (permitted_trees) — the same "omitting beats leaking" rule the
           /tasks/stream filter follows (Broker docstring) and the same rule
           eval-set reference items follow below. In off mode the dev user holds every
           tree, so the demo shows everything.
        2. Rows are ALL conversations, forks included (unlike the sidebar
           listing, which is roots-only, openapi.yaml:346-349) — "Inspect
           every conversation in the system" (cupel-phases.md:78). Deleted
           conversations stay hidden; a tombstone is not history to browse.
        """
        page, page_size = clamp_page(page, page_size, 100)
        where, params = ["c.deleted = 0"], []
        allowed = permitted_trees(request)
        if allowed is not None:
            if not allowed:
                where.append("0")
            else:
                where.append(f"c.tree_id IN ({','.join('?' * len(allowed))})")
                params += sorted(allowed)
        if user_id:
            where.append("c.user_id = ?")
            params.append(user_id)
        if tree:
            where.append("c.tree_id = ?")
            params.append(tree)
        # Date filters compare the DATE part of last_activity_at — "activity
        # on/after this date" (openapi.yaml:323); substr, not SQLite's DATE(),
        # so the stored ISO-8601-with-Z stamps need no timezone parsing.
        if date_from:
            where.append("substr(c.last_activity_at, 1, 10) >= ?")
            params.append(date_from)
        if date_to:
            where.append("substr(c.last_activity_at, 1, 10) <= ?")
            params.append(date_to)

        # c.rowid is projected as `ord` because a subquery's rows have no
        # implicit rowid — it is the stable tiebreaker for equal timestamps.
        inner = (f"SELECT c.*, c.rowid AS ord, {LATEST_SCORE_SQL} AS latest_score"
                 f" FROM conversations c WHERE {' AND '.join(where)}")
        outer, outer_params = ["1=1"], []
        # Unscored conversations are outside any score range, not silently
        # included — a score filter is a triage tool (feature-spec.md:64).
        if score_min is not None:
            outer.append("latest_score IS NOT NULL AND latest_score >= ?")
            outer_params.append(score_min)
        if score_max is not None:
            outer.append("latest_score IS NOT NULL AND latest_score <= ?")
            outer_params.append(score_max)
        base = f"FROM ({inner}) WHERE {' AND '.join(outer)}"
        total = db.one(f"SELECT COUNT(*) AS n {base}", [*params, *outer_params])["n"]
        rows = db.all(
            f"SELECT * {base} ORDER BY last_activity_at DESC, ord DESC LIMIT ? OFFSET ?",
            [*params, *outer_params, page_size, (page - 1) * page_size])

        emails = {u["id"]: u["email"] for u in db.all("SELECT id, email FROM users")}
        items = []
        for row in rows:
            # The Inspector table is a dense INDEX; the inline reader fetches
            # the selected row's transcript from listTurns. That used to be a
            # local include_turns=False; it is now the shape of every
            # conversation row everywhere.
            d = conversation_dict(row)
            d["user_id"] = row["user_id"] or "dev"
            d["user_email"] = emails.get(row["user_id"])
            d["latest_score"] = row["latest_score"]
            items.append(d)
        audit_inspect(request, {
            "user_id": user_id, "tree": tree, "date_from": date_from,
            "date_to": date_to, "score_min": score_min, "score_max": score_max,
            "page": page, "page_size": page_size,
        }, len(items))
        return page_of(items, page, page_size, total)

    # -------------------------------------------------------------- agents
    @app.get("/agenttrees/{tree}/agents")
    async def list_agents(tree: str):
        need_tree(tree)
        return [agent_dict(a) for a in db.all(
            "SELECT * FROM agents WHERE tree_id = ? ORDER BY rowid", (tree,))]

    @app.post("/agenttrees/{tree}/agents", status_code=201)
    async def create_agent(tree: str, request: Request):
        need_enabled_tree(tree)  # write — blocked on a disabled tree
        body = await body_json(request)
        if not body.get("name"):
            err(422, "invalid", "name is required.",
                field_error("name", "name is required."))
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

    @app.post("/agenttrees/{tree}/agents/{agentId}/instructions/versions",
              status_code=201)
    async def create_instruction_version(tree: str, agentId: str, request: Request):
        """createInstructionVersion — appends the next version, never
        overwrites, which is why the write is a POST to the version
        sub-collection and the parent GET stays the history."""
        need_enabled_tree(tree)  # write — blocked on a disabled tree
        agent = need_agent(tree, agentId)
        body = await body_json(request)
        if body.get("content") is None:
            err(422, "invalid", "content is required.",
                field_error("content", "content is required."))
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
            # Evaluations referencing the snapshot relabel to the new version (openapi.yaml:246-248).
            for r in db.all("SELECT id, columns FROM evaluations"):
                cols, changed = unj(r["columns"], []), False
                for col in cols:
                    if (col.get("config") or {}).get("snapshot_id") == snapshot_id:
                        col["label"], changed = f"v{version}", True
                if changed:
                    db.run("UPDATE evaluations SET columns = ? WHERE id = ?", (j(cols), r["id"]))
        return {"version": version, "content": body["content"], "format": fmt,
                "created_at": now, "promoted_from_snapshot_id": snapshot_id}

    @app.post("/agenttrees/{tree}/agents/{agentId}/snapshots", status_code=201)
    async def create_snapshot(tree: str, agentId: str, request: Request):
        need_enabled_tree(tree)  # write — blocked on a disabled tree
        need_agent(tree, agentId)
        body = await body_json(request)
        if body.get("content") is None:
            err(422, "invalid", "content is required.",
                field_error("content", "content is required."))
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
        need_enabled_tree(tree)  # write — blocked on a disabled tree
        need_agent(tree, agentId)
        body = await body_json(request)
        items = body.get("items")
        if not isinstance(items, list):
            err(422, "invalid", "items must be an array.",
                field_error("items", "items must be an array."))
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
        page, page_size = clamp_page(page, page_size, 100)
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
        term = like_term(search)
        if term:
            # Title OR any turn's content, either role (openapi.yaml
            # listConversations ?search=): the sidebar's search is how a user
            # finds "the conversation where I asked about parcels", and a
            # canned title cannot answer that. ci_lower folds both sides
            # through the same Unicode rule (mock/db.py) — SQLite's own
            # lower() is ASCII-only and left non-ASCII titles unfindable.
            where.append(
                "(ci_lower(c.title) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM turns t"
                " WHERE t.conversation_id = c.id AND ci_lower(t.content) LIKE ? ESCAPE '\\'))")
            params += [term, term]
        base = f"FROM conversations c WHERE {' AND '.join(where)}"
        total = db.one(f"SELECT COUNT(*) AS n {base}", params)["n"]
        rows = db.all(
            f"SELECT c.* {base} ORDER BY c.last_activity_at DESC, c.rowid DESC LIMIT ? OFFSET ?",
            [*params, page_size, (page - 1) * page_size])
        return page_of([conversation_dict(c) for c in rows], page, page_size, total)

    @app.get("/agenttrees/{tree}/conversations/{conversationId}")
    async def get_conversation(tree: str, conversationId: str):
        need_tree(tree)
        return conversation_dict(need_conversation(tree, conversationId))

    @app.get("/agenttrees/{tree}/conversations/{conversationId}/turns")
    async def list_turns(tree: str, conversationId: str, turn_ids: str | None = None,
                         page: int | None = None, page_size: int = 50):
        """listTurns — the transcript, oldest first, paged.

        Two deliberate departures from the other collections, both from the
        contract: rows are CHRONOLOGICAL (a transcript only grows at the tail,
        so page 1 is immutable and offset paging cannot drift here), and an
        OMITTED page means the LAST page — a reader opens a transcript at its
        end, and defaulting to 1 would cost them a second request to get
        there. turn_ids narrows to specific turns; unknown ids are ignored
        rather than 404ing, so a stale reference degrades to a missing row."""
        need_tree(tree)
        conv = need_conversation(tree, conversationId)
        rows = conv_turns(conv["id"])
        if turn_ids is not None:
            wanted = {t for t in turn_ids.split(",") if t}
            rows = [t for t in rows if t["id"] in wanted]
        total = len(rows)
        _, page_size = clamp_page(1, page_size, 200)
        last = max(1, -(-total // page_size))  # ceil; an empty transcript is page 1
        page = last if page is None else min(max(1, page), last)
        window = rows[(page - 1) * page_size:page * page_size]
        return page_of([turn_dict(t) for t in window], page, page_size, total)

    @app.patch("/agenttrees/{tree}/conversations/{conversationId}")
    async def rename_conversation(tree: str, conversationId: str, request: Request):
        need_enabled_tree(tree)  # history is read-only on a disabled tree
        conv = need_live_conversation(tree, conversationId)  # 409 on a tombstone
        body = await body_json(request)
        if body.get("title"):
            db.run("UPDATE conversations SET title = ? WHERE id = ?", (body["title"], conv["id"]))
        return conversation_dict(db.one("SELECT * FROM conversations WHERE id = ?", (conv["id"],)))

    @app.delete("/agenttrees/{tree}/conversations/{conversationId}", status_code=204)
    async def delete_conversation(tree: str, conversationId: str):
        """deleteConversation — soft, visible and IDEMPOTENT.

        The row is tombstoned, never removed: judgments, eval cases and fork
        lineage all point into it and survive. Deleting a tombstone is a no-op
        answering 204 again — the promise ("this conversation is deleted") is
        already kept, so need_conversation, not need_live_conversation."""
        need_enabled_tree(tree)  # history is read-only on a disabled tree
        conv = need_conversation(tree, conversationId)
        db.run("UPDATE conversations SET deleted = 1 WHERE id = ?", (conv["id"],))
        return Response(status_code=204)

    # Generated-spec truth for the two SSE endpoints: both really
    # serve text/event-stream, which FastAPI cannot infer from StreamingResponse.
    # Without this the mock's own OpenAPI failed conformance on /tasks/stream
    # (contract openapi.yaml:1207 declares text/event-stream only).
    SSE_RESPONSES = {200: {"content": {"text/event-stream": {}}}}

    # ---------------------------------------------------------------- chat
    @app.post("/agenttrees/{tree}/chat", responses=SSE_RESPONSES)
    async def chat(tree: str, request: Request):
        # "new chat ... against it return 409 tree_disabled" (feature-spec.md:20;
        # contract wires Conflict on chat, openapi.yaml:925).
        need_enabled_tree(tree)
        need_live_budget(request)  # 429 before a turn row exists
        body = await body_json(request)
        message = body.get("message")
        if not message:
            err(422, "invalid", "message is required.",
                field_error("message", "message is required."))
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
            conv = need_live_conversation(tree, conversation_id)  # 409 on a tombstone
        else:
            conv_id = new_id("conv")
            root = root_agent(tree)
            now = now_iso()
            db.run(
                "INSERT INTO conversations (id, tree_id, title, origin, channel, agent_id,"
                " created_at, last_activity_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (conv_id, tree, canned_title(message), body.get("origin") or "interactive",
                 body.get("channel"), root["id"] if root else None, now, now,
                 conversation_owner(request, body)))
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

        task = engine.create_task("chat", tree_id=tree)
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

        # BYOK key rides in ctx for THIS request's generation only —
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
                # The SSE error frame is the same Error schema as an error
                # BODY (openapi.yaml x-sse-events), so it carries the same
                # request id — a stream that dies half-way is the case where a
                # user most needs something to quote.
                yield sse("error", error_body(request.scope, {
                    "code": "generation_failed", "message": str(exc)}))

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
            err(422, "invalid", "message_id and rating (up|down) are required.",
                field_error("rating", "message_id and rating (up|down) are required."))
        turn = db.one("SELECT * FROM turns WHERE id = ?", (body["message_id"],))
        if not turn:
            err(404, "not_found", f"Turn '{body['message_id']}' not found.")
        jid, now = new_id("judg"), now_iso()
        # The optional comment rides on `reasoning` — the same field
        # the LLM judge explains itself in (FeedbackRequest.comment, openapi.yaml).
        # Empty/whitespace-only stays NULL so a bare thumb is byte-identical to
        # before. Append-only: a re-rating inserts a NEW row, never an UPDATE.
        comment = body.get("comment")
        reasoning = comment.strip() if isinstance(comment, str) and comment.strip() else None
        # Thumbs persist in the single judgment store: subject = the TURN that
        # was thumbed, scorer = {kind: human} with ref/version/model all null —
        # a thumb runs no rubric and no model, and nothing is invented to stand
        # in for one (openapi.yaml Scorer).
        db.run(
            "INSERT INTO judgments (id, subject_kind, subject_id, scorer_kind,"
            " conversation_id, score, reasoning, created_at)"
            " VALUES (?, 'turn', ?, 'human', ?, ?, ?, ?)",
            (jid, turn["id"], turn["conversation_id"], 1.0 if rating == "up" else 0.0,
             reasoning, now))
        return judgment_dict(db.one("SELECT * FROM judgments WHERE id = ?", (jid,)))

    # --------------------------------------------------------- evaluations
    def build_evaluation(tree: str, task_id: str, label: str, columns: list, rows: list) -> str:
        evaluation_id = new_id("eval")
        db.run("INSERT INTO evaluations (id, tree_id, task_id, label, created_at, columns)"
               " VALUES (?, ?, ?, ?, ?, ?)",
               (evaluation_id, tree, task_id, label, now_iso(), j(columns)))
        for idx, row in enumerate(rows):
            db.run("INSERT INTO evaluation_rows (evaluation_id, row_idx, conversation_id, turn_id, prompt, envelope)"
                   " VALUES (?, ?, ?, ?, ?, ?)",
                   (evaluation_id, idx, row["conversation_id"], row["turn_id"], row["prompt"],
                    j(row.get("envelope"))))
        return evaluation_id

    @app.post("/agenttrees/{tree}/replay", status_code=202)
    async def replay(tree: str, request: Request):
        need_enabled_tree(tree)  # 409 on a disabled tree (openapi.yaml:1026)
        need_live_budget(request)  # 429 before the batch is enqueued
        body = await body_json(request)
        selection, configs = body.get("selection"), body.get("configs")
        if not selection or not isinstance(selection, list):
            err(422, "invalid", "selection must be a non-empty array.",
                field_error("selection", "selection must be a non-empty array."))
        if not configs or not isinstance(configs, list):
            err(422, "invalid", "configs must be a non-empty array.",
                field_error("configs", "configs must be a non-empty array."))
        if body.get("context_policy", "frozen") != "frozen":
            err(422, "invalid", "Phase 1 replays always run frozen (openapi.yaml:1540-1546).")

        units, all_rows = [], []
        for item in selection:
            conv = need_live_conversation(tree, item.get("conversation_id"))
            rows = assistant_rows(conv, item.get("turn_ids"))
            if not rows:
                continue
            units.append((conv, rows))
        if not units:
            err(422, "invalid", "Selection contains no assistant turns to replay.")

        baseline = {}
        if body.get("baseline_evaluation_id"):
            prior = db.one("SELECT * FROM evaluations WHERE id = ? AND tree_id = ?",
                           (body["baseline_evaluation_id"], tree))
            if not prior:
                err(404, "not_found", f"Evaluation '{body['baseline_evaluation_id']}' not found.")
            last_col = len(unj(prior["columns"], [])) - 1
            for rr in db.all("SELECT * FROM evaluation_rows WHERE evaluation_id = ?", (prior["id"],)):
                cell = db.one(
                    "SELECT * FROM evaluation_cells WHERE evaluation_id = ? AND row_idx = ? AND col_idx = ?"
                    " AND status = 'done'", (prior["id"], rr["row_idx"], last_col))
                if cell and cell["content"]:
                    baseline[rr["turn_id"]] = cell["content"]

        columns = [{"label": "baseline", "config": {}}] + [
            {"label": config_label(cfg, i), "config": cfg} for i, cfg in enumerate(configs)]

        parent = engine.create_task("replay", total=len(units) * len(configs),
                                    payload={"result": None}, tree_id=tree)
        register_live(parent["id"], request)
        row_specs = []
        for conv, rows in units:
            for row in rows:
                row["row_idx"] = len(row_specs)
                row_specs.append(row)
        evaluation_id = build_evaluation(tree, parent["id"], f"Replay · {len(configs)} config(s)",
                           columns, row_specs)
        db.run("UPDATE tasks SET payload = ? WHERE id = ?",
               (j({"result": {"evaluation_id": evaluation_id}}), parent["id"]))

        for row in row_specs:
            db.run("INSERT INTO evaluation_cells (evaluation_id, row_idx, col_idx, status, content,"
                   " conversation_id, turn_id) VALUES (?, ?, 0, 'done', ?, ?, ?)",
                   (evaluation_id, row["row_idx"], baseline.get(row["turn_id"], row["content"]),
                    row["conversation_id"], row["turn_id"]))
            for col_idx in range(1, len(columns)):
                db.run("INSERT INTO evaluation_cells (evaluation_id, row_idx, col_idx, status)"
                       " VALUES (?, ?, ?, 'pending')", (evaluation_id, row["row_idx"], col_idx))

        for col_idx, cfg in enumerate(configs, start=1):
            for ci, (conv, rows) in enumerate(units, start=1):
                agent_row = (db.one("SELECT * FROM agents WHERE id = ?", (cfg.get("agent_id"),))
                             if cfg.get("agent_id") else None)
                if not agent_row and conv["agent_id"]:
                    agent_row = db.one("SELECT * FROM agents WHERE id = ?", (conv["agent_id"],))
                engine.create_task("replay", parent_id=parent["id"], payload={
                    "kind": "replay_unit", "evaluation_id": evaluation_id, "tree_id": tree,
                    "col_idx": col_idx, "config": cfg,
                    "agent": agent_row["name"] if agent_row else "assistant",
                    "conv_index": ci, "conv_total": len(units),
                    "rows": [{"row_idx": r["row_idx"], "prompt": r["prompt"],
                              "envelope": r.get("envelope")} for r in rows],
                })
        engine.spawn(engine.run_batch(parent["id"]))
        return JSONResponse({"task_id": parent["id"], "evaluation_id": evaluation_id}, status_code=202)

    @app.post("/agenttrees/{tree}/replay/turn", status_code=202)
    async def replay_turn(tree: str, request: Request):
        need_enabled_tree(tree)  # 409 on a disabled tree (openapi.yaml:1058)
        need_live_budget(request)  # 429 before the batch is enqueued
        body = await body_json(request)
        endpoints = body.get("endpoints")
        if not body.get("conversation_id") or not body.get("turn_id"):
            err(422, "invalid", "conversation_id and turn_id are required.",
                field_error("turn_id", "conversation_id and turn_id are required."))
        if not endpoints or not isinstance(endpoints, list):
            err(422, "invalid", "endpoints must be a non-empty array.",
                field_error("endpoints", "endpoints must be a non-empty array."))
        if body.get("context_policy", "frozen") != "frozen":
            err(422, "invalid", "Phase 1 replays always run frozen (openapi.yaml:1570-1574).")
        conv = need_live_conversation(tree, body["conversation_id"])
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
        parent = engine.create_task("replay_turn", total=len(ep_rows),
                                    payload={"result": None}, tree_id=tree)
        register_live(parent["id"], request)
        row = {"conversation_id": conv["id"], "turn_id": fork_turn["id"], "prompt": prompt,
               "envelope": unj(fork_turn["envelope"])}
        evaluation_id = build_evaluation(tree, parent["id"], f"Re-fire · {len(ep_rows)} endpoint(s)",
                           columns, [row])
        db.run("UPDATE tasks SET payload = ? WHERE id = ?",
               (j({"result": {"evaluation_id": evaluation_id}}), parent["id"]))
        db.run("INSERT INTO evaluation_cells (evaluation_id, row_idx, col_idx, status, content,"
               " conversation_id, turn_id) VALUES (?, 0, 0, 'done', ?, ?, ?)",
               (evaluation_id, fork_turn["content"], conv["id"], fork_turn["id"]))

        results = []
        now = now_iso()
        for col_idx, ep in enumerate(ep_rows, start=1):
            db.run("INSERT INTO evaluation_cells (evaluation_id, row_idx, col_idx, status)"
                   " VALUES (?, 0, ?, 'pending')", (evaluation_id, col_idx))
            # Fork: copy history up to the re-fired turn, lineage attached
            # (openapi.yaml:631-639, feature-spec.md:68-69).
            fork_id = new_id("conv")
            lineage = {"parent_conversation_id": conv["id"], "fork_turn_id": fork_turn["id"],
                       "endpoint_id": ep["id"], "config": cfg or None}
            db.run(
                "INSERT INTO conversations (id, tree_id, title, origin, channel, agent_id,"
                " created_at, last_activity_at, lineage, user_id)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (fork_id, tree, f"{conv['title']} · fork ({ep['name']})", conv["origin"],
                 conv["channel"], conv["agent_id"], now, now, j(lineage),
                 conv["user_id"]))  # a fork belongs to the parent's owner
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
                "kind": "fork_unit", "evaluation_id": evaluation_id, "tree_id": tree, "row_idx": 0,
                "col_idx": col_idx, "config": cfg, "agent": agent_name,
                "fork_conversation_id": fork_id, "endpoint_id": ep["id"],
                "endpoint_name": ep["name"], "prompt": prompt,
                "envelope": unj(fork_turn["envelope"]),
            })
            results.append({"endpoint_id": ep["id"], "task_id": child["id"],
                            "conversation_id": fork_id})
        engine.spawn(engine.run_batch(parent["id"]))
        return JSONResponse({"evaluation_id": evaluation_id, "results": results}, status_code=202)

    @app.get("/agenttrees/{tree}/evaluations")
    async def list_evaluations(tree: str, page: int = 1, page_size: int = 20):
        need_tree(tree)
        page, page_size = clamp_page(page, page_size, 100)
        total = db.one("SELECT COUNT(*) AS n FROM evaluations WHERE tree_id = ?", (tree,))["n"]
        rows = db.all("SELECT * FROM evaluations WHERE tree_id = ?"
                      " ORDER BY rowid DESC LIMIT ? OFFSET ?",
                      (tree, page_size, (page - 1) * page_size))
        items = [{"id": r["id"], "tree_id": r["tree_id"],
                  "status": engine.evaluation_status(r["id"], r["task_id"]),
                  "created_at": r["created_at"], "task_id": r["task_id"],
                  "label": r["label"]} for r in rows]
        return page_of(items, page, page_size, total)

    @app.get("/agenttrees/{tree}/evaluations/{evaluationId}")
    async def get_evaluation(tree: str, evaluationId: str, request: Request,
                             page: int = 1, page_size: int = 50):
        """getEvaluation — one page of the grid, revalidatable.

        The ETag is a digest of the RESPONSE BODY, so it changes exactly when
        something a caller can see changes: a cell filling, the derived status
        moving, a column relabelling. That makes the common poll — an
        evaluation that has not advanced since the last tick, or has finished
        altogether — a 304 with no body. It is per (evaluation, page,
        page_size) because the body is, which is also what HTTP means by an
        entity tag being scoped to the URL."""
        need_tree(tree)
        r = db.one("SELECT * FROM evaluations WHERE id = ? AND tree_id = ?", (evaluationId, tree))
        if not r:
            err(404, "not_found", f"Evaluation '{evaluationId}' not found.")
        payload = evaluation_dict(r, page, page_size)
        etag = '"%s"' % hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()[:32]
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag})
        return JSONResponse(payload, headers={"ETag": etag})

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
    async def get_span_payload(spanId: str, request: Request):
        """Span payloads hold full prompts and responses, and the path carries
        no tree for the AuthGate to enforce on — so ownership is checked here
        (docs/review-2026-08-05.md A3): the span's turn must live in a tree the
        caller can view. Unpermitted answers 404, indistinguishable from
        absent, like every other tree-scoped resource (openapi.yaml:1948)."""
        s = db.one("SELECT * FROM spans WHERE id = ?", (spanId,))
        if not s:
            err(404, "not_found", f"Span '{spanId}' not found.")
        permitted = permitted_trees(request)
        if permitted is not None:
            turn = db.one("SELECT tree_id FROM turns WHERE id = ?", (s["turn_id"],))
            if not turn or turn["tree_id"] not in permitted:
                err(404, "not_found", f"Span '{spanId}' not found.")
        return {"span_id": s["id"], "prompt": s["prompt"], "response": s["response"],
                "args": unj(s["args"]), "result": unj(s["result"])}

    # --------------------------------------------------------------- tasks
    @app.get("/tasks")
    async def list_tasks(status: str | None = None, parent_id: str | None = None,
                         page: int = 1, page_size: int = 50):
        """listTasks — a page, not the old bare top-N `limit`. The queue is the
        clearest case for `total`: it grows while you watch it, and a client
        that only ever saw 50 rows could not tell a quiet queue from a
        truncated one."""
        where, params = [], []
        if parent_id:
            where.append("parent_id = ?")
            params.append(parent_id)
        else:
            where.append("parent_id IS NULL")
        if status:
            where.append("status = ?")
            params.append(status)
        page, page_size = clamp_page(page, page_size, 200)
        clause = " AND ".join(where)
        total = db.one(f"SELECT COUNT(*) AS n FROM tasks WHERE {clause}", params)["n"]
        rows = db.all(
            f"SELECT * FROM tasks WHERE {clause} ORDER BY rowid DESC LIMIT ? OFFSET ?",
            [*params, page_size, (page - 1) * page_size])
        return page_of([task_dict(t) for t in rows], page, page_size, total)

    @app.get("/tasks/stream", responses=SSE_RESPONSES)
    async def stream_tasks(request: Request):
        """One global channel (openapi.yaml:1183-1219 declares no parameters),
        so every event is authorized per subscriber here
        (docs/review-2026-08-05.md A2): judgments carry reasoning, spans carry
        turn ids and task results carry conversation ids, none of which may
        cross a permission boundary. Each event is published with its tree
        (Broker.publish); a subscriber sees an event only if its tree is one
        they hold view on. Events whose tree cannot be resolved are withheld
        from limited callers rather than leaked.

        Subscription-side filters (tree/evaluation_id/task_id query params) are a
        contract change and stay open for v0.4.0 (bucket C)."""
        permitted = permitted_trees(request)

        async def gen():
            q = broker.subscribe()
            try:
                yield ": connected\n\n"
                while True:
                    try:
                        event, data, tree_id = await asyncio.wait_for(q.get(), timeout=15)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                    if permitted is not None and (tree_id is None or tree_id not in permitted):
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
    async def list_rubrics(page: int = 1, page_size: int = 50):
        latest = ("FROM rubrics r WHERE r.version ="
                  " (SELECT MAX(version) FROM rubrics WHERE id = r.id)")
        page, page_size = clamp_page(page, page_size, 100)
        total = db.one(f"SELECT COUNT(*) AS n {latest}")["n"]
        rows = db.all(f"SELECT r.* {latest} ORDER BY r.rowid LIMIT ? OFFSET ?",
                      (page_size, (page - 1) * page_size))
        items = [{"id": r["id"], "name": r["name"], "version": r["version"],
                  "prompt": r["prompt"], "created_at": r["created_at"]} for r in rows]
        return page_of(items, page, page_size, total)

    @app.post("/eval/rubrics", status_code=201)
    async def create_rubric(request: Request):
        body = await body_json(request)
        if not body.get("name") or not body.get("prompt"):
            err(422, "invalid", "name and prompt are required.",
                field_error("prompt", "name and prompt are required."))
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

    @app.post("/eval/rubrics/{rubricId}/versions", status_code=201)
    async def create_rubric_version(rubricId: str, request: Request):
        """createRubricVersion — "Appends the next version of this rubric id
        — never overwrites"."""
        body = await body_json(request)
        prompt = body.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            err(422, "invalid", "prompt is required (openapi.yaml:3444-3450).",
                field_error("prompt", "prompt is required (openapi.yaml:3444-3450)."))
        latest = db.one("SELECT * FROM rubrics WHERE id = ? ORDER BY version DESC LIMIT 1",
                        (rubricId,))
        if not latest:
            err(404, "not_found", f"Rubric '{rubricId}' not found.")
        version, now = latest["version"] + 1, now_iso()
        db.run("INSERT INTO rubrics (id, name, version, prompt, created_at)"
               " VALUES (?, ?, ?, ?, ?)", (rubricId, latest["name"], version, prompt, now))
        return {"id": rubricId, "name": latest["name"], "version": version,
                "prompt": prompt, "created_at": now}

    # -------------------------------------------------------- eval cases
    def latest_case(case_id: str) -> dict | None:
        """GET "Returns the LATEST version" (openapi.yaml:1441-1442); the store
        is append-only so latest = MAX(version) (db.py eval_cases note)."""
        return db.one("SELECT * FROM eval_cases WHERE id = ? ORDER BY version DESC LIMIT 1",
                      (case_id,))

    def case_dict(c: dict) -> dict:
        return {"id": c["id"],
                "input": {"prompt": c["prompt"], "envelope": unj(c["envelope"])},
                "output": c["output"], "reference": c["reference"],
                "source": unj(c["source"]), "version": c["version"],
                "created_at": c["created_at"]}

    def insert_case(case_id: str, version: int, prompt: str, envelope,
                    output: str, reference, source) -> dict:
        db.run("INSERT INTO eval_cases (id, version, prompt, envelope, output,"
               " reference, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
               (case_id, version, prompt, envelope, output, reference, source, now_iso()))
        return case_dict(db.one("SELECT * FROM eval_cases WHERE id = ? AND version = ?",
                                (case_id, version)))

    def case_from_source(source: dict) -> tuple[str, str | None, str]:
        """(prompt, envelope_json, output) derived from a stored turn —
        "sourced = the server derives input (the turn's prompt + envelope) and
        output (its response) from the referenced turn" (openapi.yaml:3322-3326).
        A turn row is one message (db.py:53 "~ ADK events"), so the pair is
        rejoined via invocation_id whichever half was referenced."""
        for field in ("tree", "conversation_id", "turn_id"):
            if not source.get(field):
                err(422, "invalid",
                    "source requires tree, conversation_id and turn_id "
                    "(openapi.yaml:3345-3353).")
        need_tree(source["tree"])
        turn = db.one("SELECT * FROM turns WHERE id = ? AND tree_id = ? AND conversation_id = ?",
                      (source["turn_id"], source["tree"], source["conversation_id"]))
        if not turn:
            err(404, "not_found",
                f"Turn '{source['turn_id']}' not found in conversation "
                f"'{source['conversation_id']}'.")
        sibling_role = "user" if turn["role"] == "assistant" else "assistant"
        sibling = db.one(
            "SELECT * FROM turns WHERE invocation_id = ? AND role = ? ORDER BY rowid LIMIT 1",
            (turn["invocation_id"], sibling_role))
        prompt_turn = turn if turn["role"] == "user" else sibling
        answer_turn = turn if turn["role"] == "assistant" else sibling
        if prompt_turn is None:
            err(422, "invalid",
                f"Turn '{turn['id']}' has no prompt half to use as the case input.")
        envelope = (answer_turn or {}).get("envelope") or prompt_turn["envelope"]
        return prompt_turn["content"], envelope, (answer_turn or {}).get("content") or ""

    @app.post("/eval/cases", status_code=201)
    async def create_case(request: Request):
        """POST /eval/cases (openapi.yaml:1340-1369) — "Exactly one creation
        mode (request oneOf): handcrafted = input + output supplied; sourced =
        source supplied and the server derives input … and output"."""
        body = await body_json(request)
        source = body.get("source")
        handcrafted = body.get("input") is not None or body.get("output") is not None
        if bool(source) == bool(handcrafted):
            err(422, "invalid",
                "Exactly one of (input + output) / source is required "
                "(openapi.yaml:3328-3330).")
        if source:
            if not isinstance(source, dict):
                err(422, "invalid", "source must be an object.",
                    field_error("source", "source must be an object."))
            prompt, envelope, output = case_from_source(source)
            source_json = j({"tree": source["tree"],
                             "conversation_id": source["conversation_id"],
                             "turn_id": source["turn_id"]})
        else:
            data = body.get("input")
            if not isinstance(data, dict) or not isinstance(data.get("prompt"), str) \
                    or not data["prompt"].strip():
                err(422, "invalid", "input.prompt is required (openapi.yaml:3334-3341).",
                    field_error("input.prompt", "input.prompt is required (openapi.yaml:3334-3341)."))
            if not isinstance(body.get("output"), str):
                err(422, "invalid", "output is required (openapi.yaml:3328-3329).",
                    field_error("output", "output is required (openapi.yaml:3328-3329)."))
            prompt, envelope, output = data["prompt"], j(data.get("envelope")), body["output"]
            source_json = None
        reference = body.get("reference")
        if reference is not None and not isinstance(reference, str):
            err(422, "invalid", "reference must be a string or null.",
                field_error("reference", "reference must be a string or null."))
        return insert_case(new_id("case"), 1, prompt, envelope, output,
                           reference, source_json)

    @app.post("/eval/cases/import")
    async def import_cases(request: Request, file: UploadFile = File(...),
                           mapping: str = Form(...),
                           set_id: str | None = Form(None),
                           set_name: str | None = Form(None)):
        """POST /eval/cases/import (openapi.yaml:1370-1429) — "Failed rows
        never abort the import; valid rows land". 422 is reserved for
        WHOLE-file failures ("Unparseable file or invalid mapping", :1421);
        per-row problems travel in the report instead."""
        data = await file.read()
        if len(data) > config.MAX_UPLOAD_BYTES:
            err(413, "too_large",
                f"File exceeds the {config.MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit.")
        try:
            spec = json.loads(mapping)
        except Exception:
            err(422, "invalid", "mapping must be a JSON object string "
                                "(openapi.yaml:3392-3399).")
        if not isinstance(spec, dict) or not isinstance(spec.get("input"), str) \
                or not isinstance(spec.get("output"), str):
            err(422, "invalid",
                "mapping must name the columns feeding input and output "
                "(reference optional) — openapi.yaml:1409-1414.")
        if set_id and set_name:
            err(422, "invalid", "Pass set_id (extend) or set_name (create), not both.")
        if set_id and not db.one("SELECT 1 AS x FROM eval_sets WHERE id = ?", (set_id,)):
            err(404, "not_found", f"Eval set '{set_id}' not found.")
        try:
            header, rows = tabular.parse_table(file.filename or "", data)
        except tabular.TableError as exc:
            err(422, "invalid", str(exc))

        columns = {name: i for i, name in enumerate(header)}
        missing = [spec[k] for k in ("input", "output", "reference")
                   if spec.get(k) and spec[k] not in columns]
        if missing:
            err(422, "invalid",
                f"Mapped column(s) not present in the file header: {', '.join(missing)}. "
                f"Header is: {', '.join(header)}.")

        if len(rows) > config.IMPORT_SYNC_MAX_ROWS:
            # "Above the server's size threshold: 202 TaskRef — an 'import'
            # task whose result.import_report carries the identical report
            # shape on completion" (openapi.yaml:1386-1389). Cases are global,
            # so the task carries no tree (Broker docstring).
            task = engine.create_task("import", total=len(rows))
            engine.spawn(run_import(task["id"], header, rows, spec, set_id, set_name))
            return JSONResponse({"task_id": task["id"]}, status_code=202)
        return JSONResponse(apply_import(header, rows, spec, set_id, set_name),
                            status_code=200)

    def apply_import(header, rows, spec, set_id, set_name) -> dict:
        """The one report builder both paths use, so a 200 body and a finished
        task's result.import_report are byte-identical in shape
        (openapi.yaml:1386-1389, 2795-2802)."""
        columns = {name: i for i, name in enumerate(header)}
        created, errors = [], []
        for number, row in enumerate(rows, start=1):
            def cell(field):
                idx = columns.get(spec.get(field) or "")
                return (row[idx].strip() if idx is not None and idx < len(row) else "")
            prompt, output, reference = cell("input"), cell("output"), cell("reference")
            # ErrorDetail {field?, row?, message} — the SAME shape Error
            # .details carries (openapi.yaml ErrorDetail). `field` is the
            # spreadsheet column here; the old private `column` key is gone.
            if not prompt:
                errors.append({"row": number, "field": spec["input"],
                               "message": "input is empty — a case needs a prompt."})
                continue
            if not output:
                errors.append({"row": number, "field": spec["output"],
                               "message": "output is empty — a case needs a candidate response."})
                continue
            case = insert_case(new_id("case"), 1, prompt, None, output,
                               reference or None, None)
            created.append(case["id"])

        target_set = None
        if set_id or set_name:
            # Imported cases join a set as FROZEN items: they were never turns
            # in a conversation, so a reference to one could not exist.
            new_items = [{"id": new_id("esi"), "kind": "frozen", "source": None,
                          "case_id": cid, "note": None, "added_at": now_iso()}
                         for cid in created]
            if set_id:
                if db.one("SELECT 1 AS x FROM eval_sets WHERE id = ?", (set_id,)):
                    # "extend an existing set — new membership version".
                    version = latest_version(set_id)
                    insert_version(set_id, version + 1,
                                   set_items(set_id, version) + new_items)
                    target_set = set_id
            else:
                target_set = new_id("set")
                db.run("INSERT INTO eval_sets (id, name, description, created_by,"
                       " created_at) VALUES (?, ?, NULL, 'dev', ?)",
                       (target_set, set_name, now_iso()))
                insert_version(target_set, 1, new_items)
        return {"set_id": target_set,
                "rows_total": len(rows), "rows_imported": len(created),
                "created_case_ids": created, "errors": errors}

    async def run_import(task_id, header, rows, spec, set_id, set_name):
        """Large-file path: the SAME report, delivered as task result. Defined
        here (not in engine.py) so the engine keeps no eval knowledge."""
        engine.set_status(task_id, "running")
        try:
            await asyncio.sleep(engine.step_delay)
            report = apply_import(header, rows, spec, set_id, set_name)
            engine.progress(task_id, f"Imported {report['rows_imported']}/{len(rows)} rows")
            # set_status("done") sets done = total (engine.set_status).
            engine.set_status(task_id, "done", result={"import_report": report})
        except Exception as exc:  # a broken import must not wedge the queue
            engine.set_status(task_id, "failed", error=str(exc))

    @app.get("/eval/cases/{caseId}")
    async def get_case(caseId: str):
        c = latest_case(caseId)
        if not c:
            err(404, "not_found", f"Eval case '{caseId}' not found.")
        return case_dict(c)

    @app.post("/eval/cases/{caseId}/versions", status_code=201)
    async def create_case_version(caseId: str, request: Request):
        """createEvalCaseVersion — "each save appends the next version, never
        overwrites. Prior versions stay readable and existing judgments keep
        pointing at the content they actually judged"."""
        body = await body_json(request)
        latest = latest_case(caseId)
        if not latest:
            err(404, "not_found", f"Eval case '{caseId}' not found.")
        data = body.get("input")
        if not isinstance(data, dict) or not isinstance(data.get("prompt"), str) \
                or not data["prompt"].strip():
            err(422, "invalid", "input.prompt is required (openapi.yaml:3354-3372).",
                field_error("input.prompt", "input.prompt is required (openapi.yaml:3354-3372)."))
        if not isinstance(body.get("output"), str):
            err(422, "invalid", "output is required (openapi.yaml:3356).",
                field_error("output", "output is required (openapi.yaml:3356)."))
        reference = body.get("reference")
        if reference is not None and not isinstance(reference, str):
            err(422, "invalid", "reference must be a string or null.",
                field_error("reference", "reference must be a string or null."))
        return insert_case(caseId, latest["version"] + 1, data["prompt"],
                           j(data.get("envelope")), body["output"], reference,
                           latest["source"])

    # --------------------------------------------------------- eval sets
    # THE MERGED NOUN. Casebook and EvalSet were one concept modelled twice;
    # the only real difference — reference vs frozen — is now EvalSetItem.kind,
    # and POST /casebooks/{id}/to-eval-set is gone because there is nothing to
    # convert between. Metadata is mutable, membership is append-only, which is
    # why db.py stores them in two tables.
    #
    # CROSS-TREE VISIBILITY (a set may reference turns across trees; per-item
    # visibility follows the viewer's tree permissions — the contract notes
    # this is under-specified). Decision, carried over from the casebooks it
    # replaces: REFERENCE items in trees the viewer cannot view are OMITTED
    # from every response, and every derived action (freeze, replay) operates
    # on the visible subset only. Omitting beats leaking — the same rule the
    # SSE broker follows (mock/engine.py Broker docstring). Frozen items are
    # never gated: they name an eval case, and cases are global
    # (feature-spec.md:111).
    #
    # The one place omission would be destructive is the full-membership save
    # (createEvalSetVersion): a partially-permitted caller cannot send back
    # what they were never shown. So a new version PRESERVES the items it hid
    # — omitting must not become deleting.
    def visible_trees(request: Request) -> set[str] | None:
        return permitted_trees(request)

    def item_visible(item: dict, allowed: set[str] | None) -> bool:
        if allowed is None or item["kind"] != "reference":
            return True
        return (item.get("source") or {}).get("tree") in allowed

    def need_visible_turn(request: Request, tree: str, conversation_id: str,
                          turn_id: str) -> dict:
        """The referenced turn, or 404 — including when the viewer may not view
        the tree (unpermitted = indistinguishable from absent, the NotFound
        response's "or tree not permitted")."""
        allowed = visible_trees(request)
        if allowed is not None and tree not in allowed:
            err(404, "not_found", f"Turn '{turn_id}' not found.")
        need_tree(tree)
        turn = db.one(
            "SELECT * FROM turns WHERE id = ? AND tree_id = ? AND conversation_id = ?",
            (turn_id, tree, conversation_id))
        if not turn:
            err(404, "not_found",
                f"Turn '{turn_id}' not found in conversation '{conversation_id}'.")
        return turn

    def referent(item: dict) -> tuple:
        """What an item POINTS AT, which is what its id follows across
        membership versions (openapi.yaml EvalSetItem.id "Stable across
        membership versions for as long as the item's referent stays in the
        set") and what makes POST …/items idempotent."""
        if item["kind"] == "frozen":
            return ("case", item["case_id"])
        s = item["source"]
        return ("turn", s["tree"], s["conversation_id"], s["turn_id"])

    def set_items(set_id: str, version: int) -> list[dict]:
        row = db.one("SELECT items FROM eval_set_versions WHERE set_id = ? AND version = ?",
                     (set_id, version))
        return unj(row["items"], []) if row else []

    def set_dict(s: dict, version: int, request: Request | None = None) -> dict:
        row = db.one("SELECT * FROM eval_set_versions WHERE set_id = ? AND version = ?",
                     (s["id"], version))
        items = unj(row["items"], []) if row else []
        allowed = visible_trees(request) if request is not None else None
        return {"id": s["id"], "name": s["name"], "description": s["description"],
                "version": version,
                "items": [i for i in items if item_visible(i, allowed)],
                "created_at": row["created_at"] if row else s["created_at"]}

    def latest_version(set_id: str) -> int:
        row = db.one("SELECT MAX(version) AS v FROM eval_set_versions WHERE set_id = ?",
                     (set_id,))
        return (row or {}).get("v") or 0

    def need_set(set_id: str) -> dict:
        row = db.one("SELECT * FROM eval_sets WHERE id = ?", (set_id,))
        if not row:
            err(404, "not_found", f"Eval set '{set_id}' not found.")
        return row

    def insert_version(set_id: str, version: int, items: list) -> None:
        db.run("INSERT INTO eval_set_versions (set_id, version, items, created_at)"
               " VALUES (?, ?, ?, ?)", (set_id, version, j(items), now_iso()))

    def build_items(inputs, previous: list[dict], request: Request) -> list[dict]:
        """Membership inputs -> stored items, carrying an id forward whenever
        the previous version already held the same referent."""
        if not isinstance(inputs, list):
            err(422, "invalid", "items must be an array (openapi.yaml EvalSetUpdate).",
                field_error("items", "items must be an array (openapi.yaml EvalSetUpdate)."))
        by_referent = {referent(i): i for i in previous}
        built, seen = [], set()
        for raw in inputs:
            if not isinstance(raw, dict):
                err(422, "invalid", "each item must be an object.")
            source, case_id = raw.get("source"), raw.get("case_id")
            if bool(source) == bool(case_id):
                err(422, "invalid",
                    "Exactly one of source / case_id is required per item "
                    "(openapi.yaml EvalSetItemCreate).")
            if case_id:
                if not isinstance(case_id, str) or not latest_case(case_id):
                    err(404, "not_found", f"Eval case '{case_id}' not found.")
                item = {"kind": "frozen", "source": None, "case_id": case_id}
            else:
                if not isinstance(source, dict) or not all(
                        source.get(f) for f in ("tree", "conversation_id", "turn_id")):
                    err(422, "invalid",
                        "source requires tree, conversation_id and turn_id.")
                need_visible_turn(request, source["tree"], source["conversation_id"],
                                  source["turn_id"])
                item = {"kind": "reference", "case_id": None,
                        "source": {"tree": source["tree"],
                                   "conversation_id": source["conversation_id"],
                                   "turn_id": source["turn_id"]}}
            key = referent(item)
            if key in seen:  # a set is a SET; re-listing a member is not two members
                continue
            seen.add(key)
            kept = by_referent.get(key)
            item["id"] = kept["id"] if kept else new_id("esi")
            item["note"] = raw.get("note") if raw.get("note") is not None else (
                kept["note"] if kept else None)
            item["added_at"] = kept["added_at"] if kept else now_iso()
            built.append(item)
        return built

    @app.get("/eval/sets")
    async def list_sets(request: Request, page: int = 1, page_size: int = 20):
        """"Returns the latest version of each set, membership included" — a
        page of them. Every row carries its full item list, so this is the
        listing whose unpaged size was the product of set count and set
        size."""
        page, page_size = clamp_page(page, page_size, 100)
        total = db.one("SELECT COUNT(*) AS n FROM eval_sets")["n"]
        rows = db.all("SELECT * FROM eval_sets ORDER BY rowid DESC LIMIT ? OFFSET ?",
                      (page_size, (page - 1) * page_size))
        items = [set_dict(s, latest_version(s["id"]), request) for s in rows]
        return page_of(items, page, page_size, total)

    @app.post("/eval/sets", status_code=201)
    async def create_set(request: Request):
        body = await body_json(request)
        name = body.get("name")
        if not isinstance(name, str) or not name.strip():
            err(422, "invalid", "name is required (openapi.yaml EvalSetCreate).",
                field_error("name", "name is required (openapi.yaml EvalSetCreate)."))
        sid, user = new_id("set"), request_user(request)
        items = build_items(body.get("items") or [], [], request)
        db.run("INSERT INTO eval_sets (id, name, description, created_by, created_at)"
               " VALUES (?, ?, ?, ?, ?)",
               (sid, name.strip(), body.get("description"),
                user["id"] if user else "dev", now_iso()))
        insert_version(sid, 1, items)
        return set_dict(db.one("SELECT * FROM eval_sets WHERE id = ?", (sid,)), 1, request)

    @app.get("/eval/sets/{setId}")
    async def get_set(setId: str, request: Request):
        return set_dict(need_set(setId), latest_version(setId), request)

    @app.patch("/eval/sets/{setId}")
    async def update_set_metadata(setId: str, request: Request):
        """"Metadata only, and deliberately NOT versioned" — a rename leaves
        every recorded membership version untouched. Null/absent fields leave
        the value unchanged."""
        row = need_set(setId)
        body = await body_json(request)
        name = body.get("name")
        if name is not None and (not isinstance(name, str) or not name.strip()):
            err(422, "invalid", "name must be a non-empty string when supplied.",
                field_error("name", "name must be a non-empty string when supplied."))
        description = body.get("description") if "description" in body else row["description"]
        db.run("UPDATE eval_sets SET name = ?, description = ? WHERE id = ?",
               (name.strip() if name else row["name"], description, setId))
        return set_dict(db.one("SELECT * FROM eval_sets WHERE id = ?", (setId,)),
                        latest_version(setId), request)

    @app.post("/eval/sets/{setId}/versions", status_code=201)
    async def create_set_version(setId: str, request: Request):
        """createEvalSetVersion — "each save is a new version carrying its
        FULL item list; earlier versions remain queryable"."""
        need_set(setId)
        body = await body_json(request)
        if body.get("items") is None:
            err(422, "invalid", "items is required — a set version carries its FULL"
                                " membership (openapi.yaml EvalSetUpdate).")
        version = latest_version(setId)
        previous = set_items(setId, version)
        allowed = visible_trees(request)
        hidden = [i for i in previous if not item_visible(i, allowed)]
        items = hidden + build_items(body["items"], previous, request)
        insert_version(setId, version + 1, items)
        return set_dict(db.one("SELECT * FROM eval_sets WHERE id = ?", (setId,)),
                        version + 1, request)

    @app.delete("/eval/sets/{setId}", status_code=204)
    async def delete_set(setId: str):
        """"Deleting a set never deletes evidence": the referenced turns, the
        frozen cases, their judgments and any evaluation replayed from the set
        all survive."""
        need_set(setId)
        db.run("DELETE FROM eval_set_versions WHERE set_id = ?", (setId,))
        db.run("DELETE FROM eval_sets WHERE id = ?", (setId,))
        return Response(status_code=204)

    @app.post("/eval/sets/{setId}/items", status_code=201)
    async def add_set_item(setId: str, request: Request):
        """The ⊞ action. "IDEMPOTENT: adding a referent the latest version
        already holds appends nothing and returns that version unchanged" —
        implemented literally, so two concurrent ⊞ presses cannot produce two
        members or two versions."""
        need_set(setId)
        body = await body_json(request)
        version = latest_version(setId)
        previous = set_items(setId, version)
        added = build_items([body], previous, request)
        if added and referent(added[0]) in {referent(i) for i in previous}:
            return JSONResponse(
                set_dict(db.one("SELECT * FROM eval_sets WHERE id = ?", (setId,)),
                         version, request), status_code=201)
        insert_version(setId, version + 1, previous + added)
        return JSONResponse(
            set_dict(db.one("SELECT * FROM eval_sets WHERE id = ?", (setId,)),
                     version + 1, request), status_code=201)

    def case_for_turn(source: dict) -> str:
        """"the server reuses the existing eval case for that turn or creates
        one sourced from it (same semantics as POST /eval/cases with source)".
        Lookup is on the stored source triple, so a case created by freezing,
        by POST /eval/cases, or by evaluation judging all count as the same
        case — freezing never duplicates one."""
        found = db.one(
            "SELECT id FROM eval_cases WHERE json_extract(source, '$.tree') = ?"
            " AND json_extract(source, '$.conversation_id') = ?"
            " AND json_extract(source, '$.turn_id') = ? ORDER BY rowid DESC LIMIT 1",
            (source["tree"], source["conversation_id"], source["turn_id"]))
        if found:
            return found["id"]
        prompt, envelope, output = case_from_source(source)
        return insert_case(new_id("case"), 1, prompt, envelope, output, None,
                           j(source))["id"]

    @app.post("/eval/sets/{setId}/freeze", status_code=201)
    async def freeze_set_items(setId: str, request: Request):
        """What "turn a casebook into an eval set" became: the item keeps its
        id and its source and gains a case_id, so provenance survives the
        freeze and nothing had to be converted into a second resource."""
        need_set(setId)
        body = await body_json(request)
        wanted = body.get("item_ids")
        if wanted is not None and (not isinstance(wanted, list)
                                   or any(not isinstance(i, str) for i in wanted)):
            err(422, "invalid", "item_ids must be an array of item ids when supplied.",
                field_error("item_ids", "item_ids must be an array of item ids when supplied."))
        version = latest_version(setId)
        previous = set_items(setId, version)
        allowed = visible_trees(request)
        targets = [i for i in previous
                   if i["kind"] == "reference" and item_visible(i, allowed)
                   and (wanted is None or i["id"] in wanted)]
        if wanted is not None:
            known = {i["id"] for i in previous if item_visible(i, allowed)}
            for item_id in wanted:
                if item_id not in known:
                    err(404, "not_found", f"Item '{item_id}' is not in this set.")
        if not targets:
            err(422, "invalid",
                "No reference items to freeze — every item you can see is already frozen.")
        frozen_ids = {i["id"] for i in targets}
        items = []
        for item in previous:
            if item["id"] not in frozen_ids:
                items.append(item)
                continue
            source = item["source"]
            need_visible_turn(request, source["tree"], source["conversation_id"],
                              source["turn_id"])
            items.append({**item, "kind": "frozen",
                          "case_id": case_for_turn(source)})
        insert_version(setId, version + 1, items)
        return JSONResponse(
            set_dict(db.one("SELECT * FROM eval_sets WHERE id = ?", (setId,)),
                     version + 1, request), status_code=201)

    @app.post("/eval/sets/{setId}/replay", status_code=202)
    async def replay_set(setId: str, request: Request):
        """"Replays every REFERENCE item's turn under the given configs — same
        engine as POST /agenttrees/{tree}/replay … A set may reference several
        trees, so the response carries one evaluation per tree touched, all
        children of a single parent task".

        Frozen items are skipped: a frozen case is content, not a turn in a
        conversation, so there is nothing to re-fire.

        Fan-out shape: ONE parent task; per tree one evaluation whose columns are
        baseline + one per config, and one replay_unit child per (tree,
        config) — the same children mock/engine.py already drives for
        /agenttrees/{tree}/replay, so there is no second replay path."""
        need_live_budget(request)  # 429 before the batch is enqueued
        need_set(setId)
        body = await body_json(request)
        configs = body.get("configs")
        if not configs or not isinstance(configs, list):
            err(422, "invalid", "configs must be a non-empty array.",
                field_error("configs", "configs must be a non-empty array."))
        if body.get("context_policy", "frozen") != "frozen":
            # Widening the policy is Phase 3; the tree-scoped replay pins the
            # same way (see /agenttrees/{tree}/replay above).
            err(422, "invalid", "Replays currently run frozen (openapi.yaml EvalSetReplayRequest).")

        allowed = visible_trees(request)
        items = [i for i in set_items(setId, latest_version(setId))
                 if i["kind"] == "reference" and item_visible(i, allowed)]
        if not items:
            err(422, "invalid",
                "This set has no turn references you can see — nothing to replay.")

        # Group into per-tree units, preserving item order. Each item resolves
        # to the ASSISTANT turn of its invocation plus the prompt that produced
        # it — exactly the rows a tree-scoped replay builds (assistant_rows).
        by_tree: dict[str, list[dict]] = {}
        for item in items:
            source = item["source"]
            turn = need_visible_turn(request, source["tree"], source["conversation_id"],
                                     source["turn_id"])
            # need_conversation, not need_live_conversation: a reference item is
            # EVIDENCE, and replaying it writes new conversations rather than
            # into the referenced one, so a tombstoned source still replays —
            # which is the promise "eval cases keep their source refs".
            conv = need_conversation(source["tree"], source["conversation_id"])
            target = turn["id"]
            if turn["role"] != "assistant":
                sibling = db.one(
                    "SELECT id FROM turns WHERE invocation_id = ? AND role = 'assistant'"
                    " ORDER BY rowid LIMIT 1", (turn["invocation_id"],))
                if not sibling:
                    continue  # a prompt with no answer has nothing to replay
                target = sibling["id"]
            rows = assistant_rows(conv, [target])
            if rows:
                by_tree.setdefault(source["tree"], []).extend(rows)
        if not by_tree:
            err(422, "invalid", "Set references resolve to no assistant turns to replay.")
        for tree in by_tree:
            need_enabled_tree(tree)  # 409 tree_disabled

        trees = list(by_tree)
        columns = [{"label": "baseline", "config": {}}] + [
            {"label": config_label(cfg, i), "config": cfg} for i, cfg in enumerate(configs)]
        # A cross-tree parent belongs to no single tree, so its /tasks/stream
        # events are withheld from partially-permitted callers (Broker
        # docstring); a single-tree set keeps its tree and streams normally.
        # Children always carry their own tree in the payload.
        parent = engine.create_task("replay", total=len(trees) * len(configs),
                                    payload={"result": None},
                                    tree_id=trees[0] if len(trees) == 1 else None)
        register_live(parent["id"], request)

        evaluations = []
        for ti, tree in enumerate(trees, start=1):
            rows = by_tree[tree]
            for idx, row in enumerate(rows):
                row["row_idx"] = idx
            evaluation_id = build_evaluation(tree, parent["id"],
                               f"Eval set · {len(configs)} config(s)", columns, rows)
            for row in rows:
                db.run("INSERT INTO evaluation_cells (evaluation_id, row_idx, col_idx, status, content,"
                       " conversation_id, turn_id) VALUES (?, ?, 0, 'done', ?, ?, ?)",
                       (evaluation_id, row["row_idx"], row["content"], row["conversation_id"],
                        row["turn_id"]))
                for col_idx in range(1, len(columns)):
                    db.run("INSERT INTO evaluation_cells (evaluation_id, row_idx, col_idx, status)"
                           " VALUES (?, ?, ?, 'pending')", (evaluation_id, row["row_idx"], col_idx))
            agent_row = root_agent(tree)
            for col_idx, cfg in enumerate(configs, start=1):
                cfg_agent = (db.one("SELECT * FROM agents WHERE id = ?", (cfg.get("agent_id"),))
                             if cfg.get("agent_id") else None) or agent_row
                engine.create_task("replay", parent_id=parent["id"], payload={
                    "kind": "replay_unit", "evaluation_id": evaluation_id, "tree_id": tree,
                    "col_idx": col_idx, "config": cfg,
                    "agent": cfg_agent["name"] if cfg_agent else "assistant",
                    "conv_index": ti, "conv_total": len(trees),
                    "rows": [{"row_idx": r["row_idx"], "prompt": r["prompt"],
                              "envelope": r.get("envelope")} for r in rows],
                })
            evaluations.append({"tree_id": tree, "evaluation_id": evaluation_id})

        db.run("UPDATE tasks SET payload = ? WHERE id = ?",
               (j({"result": {"evaluations": evaluations}}), parent["id"]))
        engine.spawn(engine.run_batch(parent["id"]))
        return JSONResponse({"task_id": parent["id"], "evaluations": evaluations}, status_code=202)

    @app.post("/eval/judge", status_code=202)
    async def judge(request: Request):
        need_live_budget(request)  # 429 before any judging is enqueued
        body = await body_json(request)
        if not body.get("judge_model") or not body.get("rubric_id"):
            err(422, "invalid", "judge_model and rubric_id are required.",
                field_error("rubric_id", "judge_model and rubric_id are required."))
        evaluation_id, case_ids, set_id = body.get("evaluation_id"), body.get("case_ids"), body.get("set_id")
        # v0.3.0 widened the oneOf to evaluation_id | case_ids | set_id
        # (openapi.yaml:2926-2929).
        if sum(1 for sel in (evaluation_id, case_ids, set_id) if sel) != 1:
            err(422, "invalid",
                "Exactly one of evaluation_id / case_ids / set_id is required "
                "(openapi.yaml:2926-2929).")
        if set_id:
            # "set_id … judges the set's latest membership version unless
            # set_version pins one". Since the merge a version holds reference
            # items too, so judging RESOLVES each item to a case: frozen items
            # give their case_id, references reuse-or-create the case for their
            # turn (identical to …/freeze). Turns are immutable, so the
            # resolution is deterministic — but membership is NOT rewritten
            # here: the item stays a reference until someone freezes it.
            need_set(set_id)
            version = latest_version(set_id)
            if body.get("set_version") is not None:
                version = body["set_version"]
                if not db.one("SELECT 1 AS x FROM eval_set_versions WHERE set_id = ?"
                              " AND version = ?", (set_id, version)):
                    err(404, "not_found",
                        f"Eval set '{set_id}' has no version {version}.")
            allowed = visible_trees(request)
            case_ids = []
            for item in set_items(set_id, version):
                if not item_visible(item, allowed):
                    continue
                cid = (item["case_id"] if item["kind"] == "frozen"
                       else case_for_turn(item["source"]))
                if cid not in case_ids:
                    case_ids.append(cid)
            if not case_ids:
                err(422, "invalid",
                    f"Eval set '{set_id}' v{version} has no cases to judge.")
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

        cases = []  # (case_id, evaluation_id, turn_id, conversation_id)
        evaluation_tree = None
        if evaluation_id:
            r = db.one("SELECT * FROM evaluations WHERE id = ?", (evaluation_id,))
            if not r:
                err(404, "not_found", f"Evaluation '{evaluation_id}' not found.")
            evaluation_tree = r["tree_id"]
            # Disable rule for judge (cheapest honest rule, documented):
            # judging is blocked when the RUN'S TREE is disabled — "new
            # chat/replay/judge against it return 409 tree_disabled"
            # (feature-spec.md:20; Conflict wired on /eval/judge,
            # openapi.yaml:1573). case_ids-only judging is NOT tree-gated:
            # eval cases are global resources (feature-spec.md:111).
            need_enabled_tree(r["tree_id"])
            cells = db.all(
                "SELECT * FROM evaluation_cells WHERE evaluation_id = ? AND col_idx > 0 AND status = 'done'",
                (evaluation_id,))
            for cell in cells:
                case_id = cell["case_id"]
                if not case_id:
                    # Auto-create cases from conversation turns (openapi.yaml:938-941).
                    row = db.one("SELECT * FROM evaluation_rows WHERE evaluation_id = ? AND row_idx = ?",
                                 (evaluation_id, cell["row_idx"]))
                    case_id = new_id("case")
                    db.run(
                        "INSERT INTO eval_cases (id, prompt, envelope, output, source, created_at)"
                        " VALUES (?, ?, ?, ?, ?, ?)",
                        (case_id, row["prompt"], row["envelope"], cell["content"] or "",
                         j({"tree": r["tree_id"], "conversation_id": row["conversation_id"],
                            "turn_id": row["turn_id"]}), now_iso()))
                    db.run("UPDATE evaluation_cells SET case_id = ? WHERE evaluation_id = ? AND row_idx = ?"
                           " AND col_idx = ?", (case_id, evaluation_id, cell["row_idx"], cell["col_idx"]))
                cases.append((case_id, evaluation_id, cell["turn_id"], cell["conversation_id"]))
            if not cases:
                err(422, "invalid", "Evaluation has no finished cells to judge yet.")
        else:
            for cid in case_ids:
                c = latest_case(cid)
                if not c:
                    err(404, "not_found", f"Eval case '{cid}' not found.")
                source = unj(c["source"]) or {}
                cases.append((cid, None, source.get("turn_id"), source.get("conversation_id")))

        # Judging an evaluation is tree-scoped; judging standalone eval cases is not
        # (they are global resources, feature-spec.md:111) — its events then
        # reach holders of every tree only (Broker docstring).
        parent = engine.create_task("judge", total=len(cases),
                                    payload={"result": {"evaluation_id": evaluation_id}},
                                    tree_id=evaluation_tree)
        register_live(parent["id"], request)
        for i, (case_id, rid_, turn_id, conversation_id) in enumerate(cases, start=1):
            engine.create_task("judge", parent_id=parent["id"], payload={
                "kind": "judge_case", "case_id": case_id, "evaluation_id": rid_,
                "turn_id": turn_id, "conversation_id": conversation_id,
                "judge_model": body["judge_model"], "rubric_id": rubric["id"],
                "rubric_version": rubric["version"], "rubric_name": rubric["name"],
                "case_index": i, "case_total": len(cases),
            })
        engine.spawn(engine.run_batch(parent["id"]))
        return JSONResponse({"task_id": parent["id"]}, status_code=202)

    @app.get("/eval/judgments")
    async def list_judgments(subject_kind: str | None = None, subject_id: str | None = None,
                             evaluation_id: str | None = None, scorer_ref: str | None = None,
                             conversation_id: str | None = None,
                             page: int = 1, page_size: int = 50):
        """listJudgments — equality filters, AND-ed, newest first.

        conversation_id is the one filter with no matching wire field: it
        selects on the denormalized scope column (mock/db.py judgments), which
        is what lets the chat view re-render every turn's 👍/👎 in one request
        instead of one per turn."""
        where, params = ["1=1"], []
        for col, val in (("subject_kind", subject_kind), ("subject_id", subject_id),
                         ("evaluation_id", evaluation_id), ("scorer_ref", scorer_ref),
                         ("conversation_id", conversation_id)):
            if val:
                where.append(f"{col} = ?")
                params.append(val)
        page, page_size = clamp_page(page, page_size, 200)
        clause = " AND ".join(where)
        total = db.one(f"SELECT COUNT(*) AS n FROM judgments WHERE {clause}", params)["n"]
        rows = db.all(
            f"SELECT * FROM judgments WHERE {clause} ORDER BY rowid DESC LIMIT ? OFFSET ?",
            [*params, page_size, (page - 1) * page_size])
        return page_of([judgment_dict(r) for r in rows], page, page_size, total)

    @app.get("/eval/evaluations/{evaluationId}/summary")
    async def evaluation_summary(evaluationId: str):
        if not db.one("SELECT 1 AS x FROM evaluations WHERE id = ?", (evaluationId,)):
            err(404, "not_found", f"Evaluation '{evaluationId}' not found.")
        # One group per SCORER IDENTITY — kind + ref + version. The judge model
        # is not part of the key (two judge models against one rubric version
        # stay one row, as they always have), so the group's scorer reports
        # model: null. The old `type = 'llm'` filter is gone rather than
        # renamed: judgments carrying an evaluation_id are produced by judging
        # that evaluation, so the filter never excluded a row, and dropping it
        # is what lets a future non-LLM scorer aggregate here for free.
        groups = db.all(
            "SELECT scorer_kind, scorer_ref, scorer_version,"
            " AVG(score) AS mean, COUNT(*) AS count"
            " FROM judgments WHERE evaluation_id = ?"
            " GROUP BY scorer_kind, scorer_ref, scorer_version", (evaluationId,))
        scorers = []
        for g in groups:
            scores = db.all(
                "SELECT score FROM judgments WHERE evaluation_id = ?"
                " AND scorer_kind = ? AND scorer_ref IS ? AND scorer_version IS ?",
                (evaluationId, g["scorer_kind"], g["scorer_ref"], g["scorer_version"]))
            distribution = [0, 0, 0, 0, 0]
            for s in scores:
                distribution[min(int(s["score"] * 5), 4)] += 1
            scorers.append({"scorer": {"kind": g["scorer_kind"], "ref": g["scorer_ref"],
                                       "version": g["scorer_version"], "model": None},
                            "mean": round(g["mean"], 4), "count": g["count"],
                            "distribution": distribution})
        return {"evaluation_id": evaluationId, "scorers": scorers}

    # ------------------------------------------------- static SPA (last!)
    # The built Vite bundle, when present, mounts AFTER every API
    # route so API paths always win; absent dist/ = dev mode, no change.
    static_root = resolve_static_dir(static_dir)
    if static_root:
        mount_spa(app, static_root)

    return app


app = create_app()
