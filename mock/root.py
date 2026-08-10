"""Single-origin composition for the hosted demo (docs/deployment.md "How to
deploy") — ONE Render service serving BOTH the landing page and the demo:

  GET /             docs/index.html, the persona-facing landing page
  /assets/*         docs/assets/ — images the landing page embeds (the cupel
                     photo used as its logo/illustration) — NOT the SPA's own
                     /cupel-demo/assets/*, a completely separate mount below
  /cupel-demo/*      the whole demo app (API + built SPA) — mock/main.py's
                     create_app(), completely unmodified, MOUNTED here

Starlette's Mount strips the "/cupel-demo" prefix from scope["path"] before
routing into the mounted app and sets scope["root_path"] to it, so:
  - every route mock/main.py declares (`/healthz`, `/me`, `/openapi.json`,
    the SPA catch-all, ...) needs NO prefix awareness — they stay declared
    exactly as they are and become externally reachable at
    /cupel-demo/<same path>, with zero changes to mock/main.py or
    mock/static.py;
  - FastAPI's own openapi_url resolution honours root_path, so the demo's
    contract is served at /cupel-demo/openapi.json for free (docs/readiness.md);
  - mock/permissions.py's path-template regexes, which match scope["path"]
    pre-routing, see the SAME unprefixed paths they always did.

The SPA side needs the mirror-image change instead: `vite.config.ts` builds
with `base: "/cupel-demo/"` so the bundle's own asset/route URLs already
carry the prefix the browser will actually request.

This module is what the container serves in production (mock/entrypoint.py);
mock/main.py's create_app() stays importable and prefix-free on its own for
every other purpose (`npm run mock`, all of mock/tests/, local dev).
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .main import create_app

DOCS_DIR = Path(__file__).resolve().parent.parent / "docs"
LANDING_PAGE = DOCS_DIR / "index.html"
LANDING_ASSETS = DOCS_DIR / "assets"


def create_root_app(**demo_kwargs) -> FastAPI:
    root = FastAPI(title="Cupel", docs_url=None, redoc_url=None, openapi_url=None)

    @root.get("/", include_in_schema=False)
    async def landing():
        if LANDING_PAGE.is_file():
            return FileResponse(LANDING_PAGE, media_type="text/html")
        # Missing in a dev checkout that never pulled docs/ — the demo
        # mount below still works, this is just the front door.
        return PlainTextResponse("Cupel — see /cupel-demo/", status_code=200)

    if LANDING_ASSETS.is_dir():
        root.mount("/assets", StaticFiles(directory=LANDING_ASSETS), name="landing-assets")

    root.mount("/cupel-demo", create_app(**demo_kwargs))
    return root


app = create_root_app()
