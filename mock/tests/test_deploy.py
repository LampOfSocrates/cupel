"""Deployment tests: same-origin static serving, and the single-service
root mount that puts the landing page and the demo on one origin
(docs/deployment.md, mock/root.py). Run: npm run test:mock.

Static serving is exercised via an explicit temp dist dir so the suite never
depends on whether npm run build has produced a real dist/.
"""

import asyncio

import httpx
import pytest

from mock.main import create_app
from mock.root import create_root_app


def make_client(static_dir="__no_dist__", **kwargs):
    """static_dir defaults to a nonexistent path so tests are independent of
    a locally built dist/; pass a real dir to exercise SPA serving."""
    app = create_app(db_path=":memory:", token_delay=0, step_delay=0,
                     static_dir=static_dir)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t", **kwargs)


def make_root_client(**kwargs):
    app = create_root_app(db_path=":memory:", token_delay=0, step_delay=0,
                          static_dir="__no_dist__")
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t", **kwargs)


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------- static serving
@pytest.fixture()
def dist(tmp_path):
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<html>CUPEL-INDEX</html>", encoding="utf-8")
    (root / "assets" / "app.js").write_text("console.log('cupel')", encoding="utf-8")
    return root


def test_spa_index_and_fallback_and_assets(dist):
    async def case():
        async with make_client(static_dir=str(dist)) as c:
            r = await c.get("/")
            assert r.status_code == 200 and "CUPEL-INDEX" in r.text
            assert r.headers["content-type"].startswith("text/html")
            # client-route refresh -> index.html (SPA fallback)
            r = await c.get("/evaluations")
            assert r.status_code == 200 and "CUPEL-INDEX" in r.text
            # real bundle file served as itself
            r = await c.get("/assets/app.js")
            assert r.status_code == 200 and "console.log" in r.text
            assert "javascript" in r.headers["content-type"]
    run(case())


def test_api_routes_win_over_spa(dist):
    async def case():
        async with make_client(static_dir=str(dist)) as c:
            r = await c.get("/me")
            assert r.status_code == 200 and r.json()["user"]["id"] == "dev"
            # POST /agenttrees/agent1/chat is still the API, not the SPA
            r = await c.post("/agenttrees/agent1/chat",
                             json={"message": "hello", "stream": False})
            assert r.status_code == 200
            body = r.json()
            assert body["conversation_id"] and body["turn"]["role"] == "assistant"
            # API 404 semantics on parameterized routes unchanged
            r = await c.get("/agenttrees/nope/endpoints")
            assert r.status_code == 404 and r.json()["code"] == "not_found"
    run(case())


# --------------------------------------------------------------- root mount
# mock/root.py: ONE service, ONE origin — landing page at "/", the whole demo
# (unmodified create_app()) mounted at "/cupel-demo". Starlette's Mount
# strips the prefix before routing into the demo app, so these prove that
# mount does what it claims with zero changes to mock/main.py's routes.
def test_landing_page_served_at_root():
    async def case():
        async with make_root_client() as c:
            r = await c.get("/")
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/html")
            assert "<html" in r.text.lower()
    run(case())


def test_demo_mounted_under_cupel_demo_prefix():
    async def case():
        async with make_root_client() as c:
            assert (await c.get("/cupel-demo/healthz")).status_code == 200
            r = await c.get("/cupel-demo/me")
            assert r.status_code == 200 and r.json()["user"]["id"] == "dev"
            # the demo app's own root ("/", unprefixed dist-less 404) is not
            # reachable at the mount root — only at the landing page's "/".
    run(case())


def test_openapi_reachable_at_mount_prefix():
    """The contract's own promise (docs/readiness.md): the hosted demo's spec
    lives at /cupel-demo/openapi.json — Starlette's root_path handling makes
    this true for free, no prefix threaded through mock/main.py."""
    async def case():
        async with make_root_client() as c:
            r = await c.get("/cupel-demo/openapi.json")
            assert r.status_code == 200
            spec = r.json()
            assert spec["info"]["title"] == "Cupel mock"
            assert "/agenttrees/{tree}/chat" in spec["paths"]
            # unprefixed, would 404 through the root app (only reachable
            # under the mount)
            assert (await c.get("/openapi.json")).status_code == 404
    run(case())


def test_landing_assets_served_at_root_not_under_demo_mount():
    """docs/assets/ (the landing page's own images, e.g. its logo photo) is a
    separate mount from the SPA's /cupel-demo/assets/* — proves they cannot
    collide even though both are named "assets"."""
    async def case():
        async with make_root_client() as c:
            r = await c.get("/assets/cupel-photo.jpg")
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("image/")
            # not reachable through the demo mount's own (unrelated) assets dir
            assert (await c.get("/cupel-demo/assets/cupel-photo.jpg")).status_code == 404
    run(case())
