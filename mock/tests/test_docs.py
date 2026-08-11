"""/docs renders the CONTRACT, not the mock's own derived schema.

The mock's /openapi.json is generated from route signatures that carry almost
no response models — presence-checking material for scripts/conformance.mjs,
not documentation. mock/docs.py therefore serves openapi.yaml itself and points
Swagger UI at it. These tests pin the two properties that make that worth
doing: the bytes are the contract file (so a contract edit IS a docs edit, with
no regeneration step), and neither route leaks into /openapi.json.
Run: npm run test:mock.
"""

import asyncio
from pathlib import Path

import httpx

from mock.main import create_app

ROOT = Path(__file__).resolve().parents[2]
CONTRACT = ROOT / "openapi.yaml"


def make_client():
    app = create_app(db_path=":memory:", token_delay=0, step_delay=0,
                     static_dir="__no_dist__")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t")


def run(coro):
    return asyncio.run(coro)


def test_openapi_yaml_is_the_contract_file_byte_for_byte():
    async def case():
        async with make_client() as c:
            r = await c.get("/openapi.yaml")
            assert r.status_code == 200
            # THE property: served from disk, not generated. Anything else
            # would be a second copy, free to drift from the contract.
            assert r.content == CONTRACT.read_bytes()
            # And an edit must show on the next reload, so it is not cached.
            assert r.headers["cache-control"] == "no-store"
    run(case())


def test_docs_page_renders_swagger_against_a_relative_url():
    async def case():
        async with make_client() as c:
            r = await c.get("/docs")
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/html")
            assert "SwaggerUIBundle" in r.text
            # RELATIVE, so the page works at / and under the hosted demo's
            # /cupel-demo mount (mock/root.py) without knowing which it is.
            assert 'url: "openapi.yaml"' in r.text
    run(case())


def test_neither_route_enters_the_mock_schema():
    """/openapi.json must keep describing only contract operations."""
    async def case():
        async with make_client() as c:
            paths = (await c.get("/openapi.json")).json()["paths"]
            assert "/docs" not in paths
            assert "/openapi.yaml" not in paths
    run(case())


def test_docs_are_open_to_an_unauthenticated_caller():
    """The contract is probed before any login and carries no data — the same
    reason /openapi.json is open (mock/main.py AuthGate: neither "docs" nor
    "openapi.yaml" is an API root)."""
    async def case():
        async with make_client() as c:
            for path in ("/docs", "/openapi.yaml"):
                assert (await c.get(path)).status_code == 200
    run(case())
