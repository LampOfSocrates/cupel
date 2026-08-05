"""P1-TDEPLOY tests: shared-token gate, same-origin static serving, generator
gate passage (docs/deployment.md:3-12). Run: npm run test:mock.

The gate defaults OFF (DEMO_TOKEN unset) so every other test file is
unaffected; static serving is exercised via an explicit temp dist dir so the
suite never depends on whether npm run build has produced a real dist/.
"""

import asyncio

import httpx
import pytest

from mock.generator import Generator, auth_headers, build_parser
from mock.main import DEMO_COOKIE, create_app

TOKEN = "t0k-demo-secret"


def make_client(static_dir="__no_dist__", **kwargs):
    """static_dir defaults to a nonexistent path so tests are independent of
    a locally built dist/; pass a real dir to exercise SPA serving."""
    app = create_app(db_path=":memory:", token_delay=0, step_delay=0,
                     static_dir=static_dir)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                             base_url="http://t", **kwargs)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    monkeypatch.delenv("DEMO_TOKEN", raising=False)
    monkeypatch.delenv("SKEIN_STATIC_DIR", raising=False)


# ------------------------------------------------------------- token gate
def test_no_demo_token_env_means_fully_open():
    async def case():
        async with make_client() as c:
            assert (await c.get("/me")).status_code == 200
            # dev 404 behavior unchanged when dist/ is absent
            assert (await c.get("/no-such-path")).status_code == 404
    run(case())


def test_gate_blocks_api_without_token(monkeypatch):
    monkeypatch.setenv("DEMO_TOKEN", TOKEN)

    async def case():
        async with make_client() as c:
            r = await c.get("/me")
            assert r.status_code == 401
            assert r.json() == {"code": "unauthorized",
                                "message": "Missing or invalid demo token."}
            # wrong token is also refused, via every channel
            assert (await c.get("/me", params={"token": "wrong"})).status_code == 401
            assert (await c.get("/me", headers={"X-Demo-Token": "wrong"})).status_code == 401
    run(case())


def test_healthz_stays_open(monkeypatch):
    monkeypatch.setenv("DEMO_TOKEN", TOKEN)

    async def case():
        async with make_client() as c:
            assert (await c.get("/healthz")).status_code == 200
    run(case())


def test_query_token_passes_and_sets_cookie(monkeypatch):
    monkeypatch.setenv("DEMO_TOKEN", TOKEN)

    async def case():
        async with make_client() as c:
            r = await c.get("/me", params={"token": TOKEN})
            assert r.status_code == 200
            cookie = r.headers.get("set-cookie", "")
            assert f"{DEMO_COOKIE}={TOKEN}" in cookie
            assert "HttpOnly" in cookie and "SameSite=Lax" in cookie
            assert "Secure" not in cookie  # plain http, no X-Forwarded-Proto
            # the client stored the cookie -> subsequent bare requests pass
            r2 = await c.get("/me")
            assert r2.status_code == 200
            assert "set-cookie" not in r2.headers  # only ?token= sets it
    run(case())


def test_cookie_secure_behind_https_proxy(monkeypatch):
    monkeypatch.setenv("DEMO_TOKEN", TOKEN)

    async def case():
        async with make_client() as c:
            r = await c.get("/me", params={"token": TOKEN},
                            headers={"X-Forwarded-Proto": "https"})
            assert r.status_code == 200
            assert "Secure" in r.headers.get("set-cookie", "")
    run(case())


def test_header_token_passes(monkeypatch):
    monkeypatch.setenv("DEMO_TOKEN", TOKEN)

    async def case():
        async with make_client() as c:
            r = await c.get("/me", headers={"X-Demo-Token": TOKEN})
            assert r.status_code == 200
            assert "set-cookie" not in r.headers
    run(case())


def test_browser_paths_get_html_provide_token_page(monkeypatch):
    monkeypatch.setenv("DEMO_TOKEN", TOKEN)

    async def case():
        async with make_client() as c:
            r = await c.get("/", headers={"Accept": "text/html,*/*"})
            assert r.status_code == 401
            assert r.headers["content-type"].startswith("text/html")
            assert "token" in r.text
            # non-HTML clients on the same path still get the JSON error
            r2 = await c.get("/", headers={"Accept": "application/json"})
            assert r2.status_code == 401
            assert r2.json()["code"] == "unauthorized"
    run(case())


# ---------------------------------------------------------- static serving
@pytest.fixture()
def dist(tmp_path):
    root = tmp_path / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "index.html").write_text("<html>SKEIN-INDEX</html>", encoding="utf-8")
    (root / "assets" / "app.js").write_text("console.log('skein')", encoding="utf-8")
    return root


def test_spa_index_and_fallback_and_assets(dist):
    async def case():
        async with make_client(static_dir=str(dist)) as c:
            r = await c.get("/")
            assert r.status_code == 200 and "SKEIN-INDEX" in r.text
            assert r.headers["content-type"].startswith("text/html")
            # client-route refresh -> index.html (SPA fallback)
            r = await c.get("/runs")
            assert r.status_code == 200 and "SKEIN-INDEX" in r.text
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


def test_gated_spa_flow_token_url_then_assets_via_cookie(dist, monkeypatch):
    """The shared demo link: /?token=... serves the app AND plants the cookie,
    after which asset + API requests pass with no client changes."""
    monkeypatch.setenv("DEMO_TOKEN", TOKEN)

    async def case():
        async with make_client(static_dir=str(dist)) as c:
            r = await c.get("/", params={"token": TOKEN},
                            headers={"Accept": "text/html"})
            assert r.status_code == 200 and "SKEIN-INDEX" in r.text
            assert f"{DEMO_COOKIE}={TOKEN}" in r.headers.get("set-cookie", "")
            assert (await c.get("/assets/app.js")).status_code == 200
            assert (await c.get("/me")).status_code == 200
    run(case())


# ------------------------------------------------------- generator + gate
def test_generator_token_flag_and_header():
    args = build_parser().parse_args(["seed", "--token", "abc"])
    assert args.token == "abc"
    assert build_parser().parse_args(["seed"]).token is None
    assert auth_headers(None) == {}
    assert auth_headers("abc") == {"X-Demo-Token": "abc"}


def test_generator_sends_x_demo_token(monkeypatch):
    """--token must ride as X-Demo-Token on every generator request (fake
    transport assert) and must satisfy the real gate."""
    seen = []

    def handler(request):
        seen.append(request.headers.get("x-demo-token"))
        return httpx.Response(200, json=[])

    async def fake():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                     base_url="http://t",
                                     headers=auth_headers(TOKEN)) as c:
            await Generator(c, seed=1, log=lambda *_: None)._get("/eval/rubrics")
    run(fake())
    assert seen == [TOKEN]

    monkeypatch.setenv("DEMO_TOKEN", TOKEN)

    async def real_gate():
        async with make_client(headers=auth_headers(TOKEN)) as c:
            gen = Generator(c, seed=1, log=lambda *_: None)
            assert (await gen._get("/me"))["user"]["id"] == "dev"
    run(real_gate())
