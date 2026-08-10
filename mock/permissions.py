"""What each operation requires of its caller — openapi.yaml `x-requires`.

This is a cached projection of the CONTRACT, not a second source of truth.
Every entry below is the `x-requires` value written on that operation in
openapi.yaml, and mock/tests/test_permissions.py::
test_declared_requirements_match_the_contract re-reads openapi.yaml and fails
on any difference — a new operation, a changed requirement, a typo. Same trade,
for the same reason, as mock/capabilities.py: no YAML parser ships in the
runtime image (mock/requirements.txt is fastapi/uvicorn/multipart/httpx) and
openapi.yaml is not copied into it, so buying a runtime dependency to compute a
value that moves only when the contract does is the worse deal; a test that
fails the moment it is stale is the cheaper guarantee.

The two failures are DIFFERENT on purpose (openapi.yaml info.description,
"Per-operation permissions"):

* `view` is the precondition of the PATH and is enforced by the AuthGate as
  404 not_found, so an unpermitted tree stays indistinguishable from an absent
  one. Nothing in this module answers 403 for it — `view` and `none` are
  pass-through here precisely so that property is not weakened by accident.
* `tune` / `evaluate` are capabilities WITHIN a tree the caller can already
  see, and `admin` / `inspect` are global roles. Missing one of those is a
  403 forbidden whose message names what is missing.

No AUTH_MODE branch: `caller_permissions`/`caller_roles` take the same
"verified user, else the dev user who holds everything" path the rest of the
mock takes (main.request_roles, main.permitted_trees), so an off-mode request
runs this code and is allowed, rather than skipping it.
"""

import re

# openapi.yaml info.version — the contract these requirements were read from.
CONTRACT_VERSION = "0.3.0"

TREE_PERMISSIONS = ("view", "tune", "evaluate")
ROLES = ("admin", "inspect")

# "METHOD /contract/path/{template}" -> x-requires. All 67 operations, so a
# missing entry is a bug rather than an implicit "none".
REQUIREMENTS: dict[str, str] = {
    "POST /auth/token": "none",
    "POST /auth/logout": "none",
    "GET /me": "none",
    "GET /admin/users": "admin",
    "PUT /admin/users": "admin",
    "GET /admin/users/{userId}/permissions": "admin",
    "PUT /admin/users/{userId}/permissions": "admin",
    "PATCH /admin/agenttrees/{treeId}": "admin",
    "GET /admin/conversations": "inspect",
    "POST /admin/generator": "admin",
    "GET /admin/generator/status": "admin",
    "GET /healthz": "none",
    "GET /models": "none",
    "GET /agenttrees": "none",
    "POST /agenttrees": "none",
    "GET /agenttrees/{tree}/endpoints": "view",
    "GET /agenttrees/{tree}/agents": "view",
    "POST /agenttrees/{tree}/agents": "tune",
    "GET /agenttrees/{tree}/agents/{agentId}/instructions": "view",
    "POST /agenttrees/{tree}/agents/{agentId}/instructions/versions": "tune",
    "POST /agenttrees/{tree}/agents/{agentId}/snapshots": "tune",
    "GET /agenttrees/{tree}/agents/{agentId}/last-selection": "view",
    "PUT /agenttrees/{tree}/agents/{agentId}/last-selection": "evaluate",
    "GET /agenttrees/{tree}/conversations": "view",
    "GET /agenttrees/{tree}/conversations/{conversationId}": "view",
    "PATCH /agenttrees/{tree}/conversations/{conversationId}": "view",
    "DELETE /agenttrees/{tree}/conversations/{conversationId}": "view",
    "GET /agenttrees/{tree}/conversations/{conversationId}/turns": "view",
    "GET /agenttrees/{tree}/memory": "view",
    "PUT /agenttrees/{tree}/memory": "tune",
    "DELETE /agenttrees/{tree}/memory": "tune",
    "POST /agenttrees/{tree}/memory/compact": "tune",
    "POST /agenttrees/{tree}/chat": "view",
    "POST /upload": "none",
    "POST /feedback": "none",
    "POST /agenttrees/{tree}/replay": "evaluate",
    "POST /agenttrees/{tree}/replay/turn": "evaluate",
    "GET /agenttrees/{tree}/evaluations": "view",
    "GET /agenttrees/{tree}/evaluations/{evaluationId}": "view",
    "GET /agenttrees/{tree}/turns/{turnId}/trace": "view",
    "GET /spans/{spanId}/payload": "none",
    "GET /tasks": "none",
    "GET /tasks/stream": "none",
    "GET /tasks/{taskId}": "none",
    "DELETE /tasks/{taskId}": "none",
    "POST /tasks/{taskId}/retry-failed": "none",
    "GET /eval/rubrics": "none",
    "POST /eval/rubrics": "none",
    "POST /eval/rubrics/{rubricId}/versions": "none",
    "POST /eval/cases": "none",
    "POST /eval/cases/import": "none",
    "GET /eval/cases/{caseId}": "none",
    "POST /eval/cases/{caseId}/versions": "none",
    "GET /eval/sets": "none",
    "POST /eval/sets": "none",
    "GET /eval/sets/{setId}": "none",
    "DELETE /eval/sets/{setId}": "none",
    "PATCH /eval/sets/{setId}": "none",
    "POST /eval/sets/{setId}/versions": "none",
    "POST /eval/sets/{setId}/items": "none",
    "POST /eval/sets/{setId}/freeze": "none",
    "POST /eval/sets/{setId}/replay": "none",
    "POST /eval/judge": "none",
    "GET /eval/judgments": "none",
    "GET /eval/evaluations/{evaluationId}/summary": "none",
    "GET /settings": "none",
    "PUT /settings": "none",
}

# Only these can refuse with a 403 — the rest are pass-through here, and a
# missing `view` is the AuthGate's 404.
ENFORCED = {k: v for k, v in REQUIREMENTS.items() if v not in ("none", "view")}


def _matcher(template: str) -> re.Pattern:
    """A contract path template as a regex. `{x}` matches one segment; the
    gate runs BEFORE routing, so the match has to be done here rather than read
    off a resolved route."""
    parts = [re.escape(p) if not p.startswith("{") else r"[^/]+"
             for p in re.split(r"(\{[^/]+\})", template) if p]
    return re.compile("^" + "".join(parts) + "$")


# Longest template first so a literal segment never loses to a placeholder
# (/tasks/stream must win over /tasks/{taskId}).
_ENFORCED_MATCHERS = [
    (method, _matcher(path), path, requires)
    for method, path, requires in sorted(
        ((k.split(" ", 1)[0], k.split(" ", 1)[1], v) for k, v in ENFORCED.items()),
        key=lambda e: -len(e[1]))
]


def requirement(method: str, path: str) -> tuple[str, str] | None:
    """(requirement, contract path) for an ENFORCED operation, else None.

    None means "nothing for this gate to do": an unknown path (the router will
    404 it), or an operation requiring `none`/`view`."""
    for m, pattern, template, requires in _ENFORCED_MATCHERS:
        if m == method and pattern.match(path):
            return requires, template
    return None


def tree_of(path: str) -> str | None:
    """The tree id a /agenttrees/{tree}/… path names."""
    parts = path.split("/")
    return parts[2] if len(parts) > 3 and parts[1] == "agenttrees" and parts[2] else None


def refusal(requires: str, tree: str | None) -> str:
    """The sentence a refusal reads as. It names the missing capability (and
    the tree it is missing on), because "Forbidden" tells a user nothing they
    can act on — the remedy for a role and for a per-tree permission are
    different people and different screens."""
    if requires in ROLES:
        return f"The {requires} role is required."
    return (f"You do not have permission to {requires} agent tree '{tree}'."
            if tree else f"The {requires} permission is required.")
