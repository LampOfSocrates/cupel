"""P2-READY: the mock ships its own OpenAPI (/openapi.json) and the readiness
script validates it against contract v0.3.0 as the FIRST conformance test
(skein-phases.md:98). Run: npm run test:mock.

Test-shape choice (documented per task): pytest fetches /openapi.json from the
app in-process (no uvicorn boot, no ports) and drives the Node CLI as a
subprocess with --json; the comparator's unit layer lives in
tests/skein-ready.test.js (vitest, fixture specs).
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

from mock.main import create_app

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "t0k-ready"


def make_client(**kwargs):
    app = create_app(db_path=":memory:", token_delay=0, step_delay=0,
                     static_dir="__no_dist__")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t", **kwargs)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _no_gate(monkeypatch):
    monkeypatch.delenv("DEMO_TOKEN", raising=False)


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


def skein_ready(*args):
    proc = subprocess.run(
        ["node", str(ROOT / "scripts" / "skein-ready.mjs"), *args],
        capture_output=True, text=True, cwd=ROOT)
    return proc


# ------------------------------------------------------- /openapi.json route
def test_openapi_served_docs_stay_off():
    async def case():
        async with make_client() as c:
            r = await c.get("/openapi.json")
            assert r.status_code == 200
            spec = r.json()
            assert spec["info"]["title"] == "Skein mock"
            assert "/agenttrees/{tree}/chat" in spec["paths"]
            # docs UIs remain disabled (openapi exposure only)
            assert (await c.get("/docs")).status_code == 404
            assert (await c.get("/redoc")).status_code == 404
    run(case())


def test_openapi_gated_like_other_endpoints(monkeypatch):
    """DEMO_TOKEN set -> /openapi.json is behind the gate (only /healthz is
    open); skein-ready reaches it via --header X-Demo-Token."""
    monkeypatch.setenv("DEMO_TOKEN", TOKEN)

    async def case():
        async with make_client() as c:
            assert (await c.get("/openapi.json")).status_code == 401
            r = await c.get("/openapi.json", headers={"X-Demo-Token": TOKEN})
            assert r.status_code == 200 and "paths" in r.json()
    run(case())


# ------------------------------------------------- first conformance runs
def test_phase1_conformance_passes(spec_path):
    """--phase1-only must report FULL conformance: the mock implements the
    whole v0.2.0 surface, so any gap here is a real mock bug (one was found
    and fixed during P2-READY: /tasks/stream didn't declare its
    text/event-stream content type — see SSE_RESPONSES in mock/main.py)."""
    proc = skein_ready(str(spec_path), "--phase1-only", "--json")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report["ok"] is True
    assert report["missing"] == []
    assert report["mismatched"] == []
    assert report["checked"] == report["conformant"] > 0


def test_full_run_reports_exactly_the_phase2_gaps(spec_path):
    """Default (full v0.3.0) run: the missing set is the not-yet-implemented
    Phase-2 surface. Tolerant by design: later Phase-2 tasks (P2-T07 auth,
    P2-T12 workbench, ...) implement these endpoints one by one, and this
    test must keep passing as the missing set SHRINKS — so we assert subset
    of the known Phase-2 surface plus a few sentinels that exist TODAY,
    not an exact list."""
    proc = skein_ready(str(spec_path), "--json")
    assert proc.returncode == 1, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report["ok"] is False
    # Nothing the mock DOES implement may be mismatched — Phase-1 stays green.
    assert report["mismatched"] == []

    phase2_paths = set(report["contract_paths"]) - set(report["phase1_paths"])
    missing_paths = {m["path"] for m in report["missing"]}
    assert missing_paths, "expected Phase-2 endpoints to be missing today"
    # Subset (not equality): implemented-later endpoints simply drop out.
    # P2-T12 implemented the PUT on the Phase-1 path /eval/cases/{caseId}, so
    # that path is fully conformant now and the old exemption is gone.
    assert missing_paths <= phase2_paths
    # Sentinels that are certainly unimplemented today (P2-T07 implemented
    # /auth/token + /auth/logout; P2-T07b/07c implemented /admin/users,
    # /admin/users/{userId}/permissions and /admin/agenttrees/{treeId};
    # P2-T12 implemented the eval workbench surface — each left this list,
    # so the missing set shrinks task by task, as documented above).
    for sentinel in ("/settings", "/casebooks",
                     "/agenttrees/{tree}/memory", "/admin/generator"):
        assert sentinel in missing_paths, f"{sentinel} should be missing today"
    # And the auth + admin + eval-workbench endpoints are conformant, not missing.
    for implemented in ("/auth/token", "/auth/logout", "/admin/users",
                        "/admin/users/{userId}/permissions",
                        "/admin/agenttrees/{treeId}",
                        "/eval/cases", "/eval/cases/import", "/eval/cases/{caseId}",
                        "/eval/sets", "/eval/sets/{setId}", "/eval/rubrics/{rubricId}"):
        assert implemented not in missing_paths
    # P2-T12 shrink, recorded so a regression is loud: 44 -> 51 conformant
    # operations of the same 69 checked (7 new: POST /eval/cases,
    # POST /eval/cases/import, PUT /eval/cases/{caseId}, GET + POST /eval/sets,
    # PUT /eval/sets/{setId}, PUT /eval/rubrics/{rubricId}).
    # >= not ==, keeping this test's tolerant design: later tasks only add.
    assert report["conformant"] >= 51


def test_prefix_remap_and_headers_flow(spec_path, tmp_path):
    """--prefix remaps contract paths before lookup (skein-phases.md:75):
    against the unprefixed mock spec everything goes missing under a bogus
    prefix — proving the remap is applied — and --header parses k:v pairs."""
    proc = skein_ready(str(spec_path), "--prefix", "/nabu-service",
                       "--phase1-only", "--json")
    assert proc.returncode == 1
    report = json.loads(proc.stdout)
    assert report["prefix"] == "/nabu-service"
    assert report["conformant"] == 0  # nothing matches under the prefix

    bad = skein_ready(str(spec_path), "--header", "no-colon-here")
    assert bad.returncode == 2
    assert "--header expects" in bad.stderr


# ---------------------------------------------------- P2-INIT: --init mode
def test_init_emits_target_block_from_real_mock(spec_path):
    """--init against the real mock's OpenAPI, fetched over HTTP so the
    fetched-origin baseUrl fallback is exercised end-to-end. Expectations
    match the FastAPI-generated spec's reality (verified via app.openapi()):
    it declares NO `servers` and NO securitySchemes (the DEMO_TOKEN gate is
    middleware, outside the spec), so baseUrl falls back to the fetch origin,
    requiresToken is omitted, and — paths matching the contract 1:1 — no
    prefix remap is detected."""
    handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                directory=str(spec_path.parent))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        origin = f"http://127.0.0.1:{server.server_address[1]}"
        proc = skein_ready(f"{origin}/{spec_path.name}", "--init",
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
