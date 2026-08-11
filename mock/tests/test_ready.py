"""The mock ships its own OpenAPI (/openapi.json) and the readiness
script validates it against contract v0.3.0 as the FIRST conformance test
(cupel-phases.md:98). Run: npm run test:mock.

Test-shape choice (documented per task): pytest fetches /openapi.json from the
app in-process (no uvicorn boot, no ports) and drives the Node CLI as a
subprocess with --json; the comparator's unit layer lives in
tests/cupel-ready.test.js (vitest, fixture specs).
"""

import asyncio
import functools
import http.server
import json
import subprocess
import threading
from pathlib import Path

import httpx
import pytest

from mock import capabilities as cap
from mock.main import create_app

ROOT = Path(__file__).resolve().parents[2]


def make_client(**kwargs):
    app = create_app(db_path=":memory:", token_delay=0, step_delay=0,
                     static_dir="__no_dist__")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t", **kwargs)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture()
def spec_path(tmp_path):
    """The mock's own OpenAPI, fetched through the real route."""
    async def case():
        async with make_client() as c:
            r = await c.get("/openapi.json")
            assert r.status_code == 200
            return r.json()
    spec = run(case())
    path = tmp_path / "mock-openapi.json"
    path.write_text(json.dumps(spec), encoding="utf-8")
    return path


def cupel_ready(*args):
    proc = subprocess.run(
        ["node", str(ROOT / "scripts" / "cupel-ready.mjs"), *args],
        capture_output=True, text=True, cwd=ROOT)
    return proc


# ------------------------------------------------------- /openapi.json route
def test_openapi_served_docs_stay_off():
    async def case():
        async with make_client() as c:
            r = await c.get("/openapi.json")
            assert r.status_code == 200
            spec = r.json()
            assert spec["info"]["title"] == "Cupel mock"
            assert "/agenttrees/{tree}/chat" in spec["paths"]
            # docs UIs remain disabled (openapi exposure only)
            assert (await c.get("/docs")).status_code == 404
            assert (await c.get("/redoc")).status_code == 404
    run(case())


# ------------------------------------------------- first conformance runs
def test_phase1_conformance_passes(spec_path):
    """--phase1-only must report FULL conformance: the mock implements the
    whole v0.2.0 surface, so any gap here is a real mock bug (one was found
    and fixed: /tasks/stream didn't declare its
    text/event-stream content type — see SSE_RESPONSES in mock/main.py)."""
    proc = cupel_ready(str(spec_path), "--phase1-only", "--json")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report["ok"] is True
    assert report["missing"] == []
    assert report["mismatched"] == []
    assert report["checked"] == report["conformant"] > 0


def test_full_run_reports_exactly_the_phase2_gaps(spec_path):
    """Default (full v0.3.0) run: the missing set is the not-yet-implemented
    Phase-2 surface. Tolerant by design: later Phase-2 tasks (auth,
    workbench, ...) implement these endpoints one by one, and this
    test must keep passing as the missing set SHRINKS — so we assert subset
    of the known Phase-2 surface plus a few sentinels that exist TODAY,
    not an exact list."""
    proc = cupel_ready(str(spec_path), "--json")
    assert proc.returncode == 1, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report["ok"] is False
    # Nothing the mock DOES implement may be mismatched — Phase-1 stays green.
    assert report["mismatched"] == []

    phase2_paths = set(report["contract_paths"]) - set(report["phase1_paths"])
    missing_paths = {m["path"] for m in report["missing"]}
    assert missing_paths, "expected Phase-2 endpoints to be missing today"
    # Subset (not equality): implemented-later endpoints simply drop out.
    # The version append under the Phase-1 path /eval/cases/{caseId} is
    # implemented, so that path is fully conformant now and the old
    # exemption is gone.
    assert missing_paths <= phase2_paths
    # Sentinels that are certainly unimplemented today (endpoints leave this
    # list as they get implemented, so the missing set shrinks task by task,
    # as documented above).
    for sentinel in ("/settings",
                     "/agenttrees/{tree}/memory", "/admin/generator"):
        assert sentinel in missing_paths, f"{sentinel} should be missing today"
    # And the auth + admin + eval-workbench + inspector endpoints are
    # conformant, not missing.
    for implemented in ("/auth/token", "/auth/logout", "/admin/users",
                        "/admin/users/{userId}/permissions",
                        "/admin/agenttrees/{treeId}",
                        "/eval/cases", "/eval/cases/import", "/eval/cases/{caseId}",
                        "/eval/benchmarks", "/eval/benchmarks/{benchmarkId}",
                        "/eval/benchmarks/{benchmarkId}/items", "/eval/benchmarks/{benchmarkId}/freeze",
                        "/eval/benchmarks/{benchmarkId}/replay", "/eval/rubrics/{rubricId}",
                        "/admin/conversations"):
        assert implemented not in missing_paths
    # Shrink recorded so a regression is loud: 51 -> 61 -> 58 conformant.
    # The DROP is the Casebook+EvalBenchmark merge, not a regression: nine
    # /casebooks operations plus three /eval/benchmarks ones became nine on the one
    # merged noun, so the whole contract went 69 -> 66 operations checked.
    # >= not ==, keeping this test's tolerant design: later tasks only add.
    assert report["conformant"] >= 58


def test_declared_capabilities_match_the_contract(spec_path):
    """GET /healthz's capabilities (mock/capabilities.py) must BE the
    comparator's per-family verdict, not a hand-kept opinion resembling it.

    This is what makes the declaration a projection of the contract rather
    than a second source of truth: the family names, their operation totals
    and the missing lists all come from openapi.yaml via `cupel-ready --json`,
    and any drift — a family added, an endpoint implemented, an operation
    moved between families — fails here rather than shipping a backend that
    lies about itself."""
    proc = cupel_ready(str(spec_path), "--json")
    report = json.loads(proc.stdout)
    assert report["mismatched"] == []  # `implemented` below counts conformant ops
    assert report["contract"]["version"] == cap.CONTRACT_VERSION

    computed = {
        f["name"]: {
            "status": f["status"],
            "implemented": f["conformant"],
            "operations": f["operations"],
            **({"missing": sorted(f["missing"])} if f["missing"] else {}),
        }
        for f in report["families"]
    }
    declared = {
        name: {**entry, **({"missing": sorted(entry["missing"])} if entry.get("missing") else {})}
        for name, entry in cap.CAPABILITIES.items()
    }
    assert declared == computed

    async def case():
        async with make_client() as c:
            health = (await c.get("/healthz")).json()
            assert health["contract_version"] == cap.CONTRACT_VERSION
            assert health["capabilities"] == cap.CAPABILITIES
    run(case())


def test_prefix_remap_and_headers_flow(spec_path, tmp_path):
    """--prefix remaps contract paths before lookup (cupel-phases.md:75):
    against the unprefixed mock spec everything goes missing under a bogus
    prefix — proving the remap is applied — and --header parses k:v pairs."""
    proc = cupel_ready(str(spec_path), "--prefix", "/nabu-service",
                       "--phase1-only", "--json")
    assert proc.returncode == 1
    report = json.loads(proc.stdout)
    assert report["prefix"] == "/nabu-service"
    assert report["conformant"] == 0  # nothing matches under the prefix

    bad = cupel_ready(str(spec_path), "--header", "no-colon-here")
    assert bad.returncode == 2
    assert "--header expects" in bad.stderr


# ------------------------------------------------------------- --init mode
def test_init_emits_target_block_from_real_mock(spec_path):
    """--init against the real mock's OpenAPI, fetched over HTTP so the
    fetched-origin baseUrl fallback is exercised end-to-end. Expectations
    match the FastAPI-generated spec's reality (verified via app.openapi()):
    it declares NO `servers` and NO securitySchemes (AUTH_MODE's bearer JWT
    check is ASGI middleware, outside FastAPI's Security system, so it is
    never declared in the generated spec), so baseUrl falls back to the fetch
    origin, requiresToken is omitted, and — paths matching the contract 1:1 —
    no prefix remap is detected."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                directory=str(spec_path.parent))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        origin = f"http://127.0.0.1:{server.server_address[1]}"
        proc = cupel_ready(f"{origin}/{spec_path.name}", "--init",
                           "--phase1-only", "--json")
        assert proc.returncode == 0, proc.stdout + proc.stderr
        init = json.loads(proc.stdout)["init"]
        assert init["baseUrl"] == origin
        assert init["baseUrlSource"] == "fetched-origin"
        assert init["remapPrefix"] is None
        assert init["requiresToken"] is False
        block = init["block"]
        assert f'baseUrl: "{origin}"' in block
        assert "remap:" not in block
        assert "requiresToken" not in block
        # the one-config-artifact invariant is stated in the block header
        assert "never writes agentic.config.ts" in block
    finally:
        server.shutdown()
        server.server_close()
