"""What this backend implements, family by family — openapi.yaml
Health.capabilities / Capability.

The family names and the per-family operation totals are the CONTRACT's, not
this file's: they are the top-level `tags` of openapi.yaml and the operations
carrying each tag. This module is a cached projection of that, not a second
source of truth, and it cannot drift silently —
mock/tests/test_ready.py::test_declared_capabilities_match_the_contract
recomputes the whole table by running `cupel-ready --json` against the mock's
own generated OpenAPI and fails on any difference, including a family being
added to or removed from the contract.

Why a cached projection rather than reading openapi.yaml at boot: the contract
is a YAML file, no YAML parser ships in the runtime image
(mock/requirements.txt is fastapi/uvicorn/multipart/httpx), and openapi.yaml is
not copied into it (Dockerfile stage 3). Buying a runtime dependency and a new
build-context file to compute a value that changes only when the contract does
is the worse trade; a test that fails the moment it is stale is the cheaper
guarantee.

`partial` is expressed exactly as the contract defines it: `status` is the
promise (full = every contract operation in the family is served), and
implemented/operations/missing make the promise auditable. The mock is honest
about being incomplete — 59 of the contract's 67 operations, so `admin` is
partial and `memory`/`settings` are `none` rather than quietly absent.
"""

# openapi.yaml info.version — the contract this backend was built against, NOT
# config.VERSION, which is the server's own version.
CONTRACT_VERSION = "0.5.0"

CAPABILITIES: dict[str, dict] = {
    "auth": {"status": "full", "implemented": 2, "operations": 2},
    "identity": {"status": "full", "implemented": 1, "operations": 1},
    "admin": {
        "status": "partial", "implemented": 6, "operations": 8,
        # Generator control is Phase 3 (TASKS.md item 23); the Settings
        # drip-rate controls stay greyed out until it exists.
        "missing": ["POST /admin/generator", "GET /admin/generator/status"],
    },
    "meta": {"status": "full", "implemented": 2, "operations": 2},
    "trees": {"status": "full", "implemented": 3, "operations": 3},
    "agents": {"status": "full", "implemented": 7, "operations": 7},
    "conversations": {"status": "full", "implemented": 5, "operations": 5},
    "memory": {
        "status": "none", "implemented": 0, "operations": 4,
        # The one family that is contracted and built nowhere (TASKS.md item 12).
        "missing": [
            "GET /agenttrees/{tree}/memory",
            "PUT /agenttrees/{tree}/memory",
            "DELETE /agenttrees/{tree}/memory",
            "POST /agenttrees/{tree}/memory/compact",
        ],
    },
    "chat": {"status": "full", "implemented": 3, "operations": 3},
    "evaluations": {"status": "full", "implemented": 4, "operations": 4},
    "trace": {"status": "full", "implemented": 2, "operations": 2},
    "tasks": {"status": "full", "implemented": 5, "operations": 5},
    "eval": {"status": "full", "implemented": 19, "operations": 19},
    "settings": {
        "status": "none", "implemented": 0, "operations": 2,
        "missing": ["GET /settings", "PUT /settings"],
    },
}
