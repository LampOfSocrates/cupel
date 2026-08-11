"""Swagger UI over the CONTRACT — openapi.yaml itself, not this server's schema.

FastAPI's own docs are off (main.py create_app: docs_url=None, redoc_url=None)
and that stays true. Its derived schema is built from THIS SERVER's route
signatures, which carry almost no response models and none of the contract's
prose, so rendering it would document the mock rather than the thing the mock
implements. /openapi.json keeps its one job: presence-checking for
scripts/conformance.mjs.

What this adds instead is the artifact:

    GET /openapi.yaml   the contract file, streamed from disk
    GET /docs           Swagger UI pointed at it

NOTHING IS GENERATED, COPIED OR CACHED. The file is read per request and sent
`no-store`, so editing openapi.yaml IS the change to these docs — reload and it
is there. There is no regeneration step to forget and no second copy to drift.
That is the whole design constraint: the docs must not touch the contract, but
must follow it.

Both routes are include_in_schema=False: they are not contract operations, and
/openapi.json must keep describing only what the contract describes.

Neither is gated. The AuthGate only guards paths whose first segment is a known
API root, and "docs"/"openapi.yaml" are not among them — the same reason
/openapi.json is open, and for the same reason: this is the contract, it is
probed before any login, and it carries no data. The PermissionGate passes
through any path the contract does not name.

The URL in the page is RELATIVE on purpose. Served at /docs the browser
resolves it to /openapi.yaml; under the hosted demo's mount (root.py mounts the
app at /cupel-demo) the same page at /cupel-demo/docs resolves it to
/cupel-demo/openapi.yaml. No prefix awareness needed, matching how every other
handler here stays mount-agnostic.

Swagger UI comes from a CDN, so the PAGE needs network access — the contract it
renders does not. Offline, /openapi.yaml still serves the file.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse

# Repo root: mock/ sits directly under it, and so does the image's /app (the
# Dockerfile COPYs both to the same relative places).
CONTRACT = Path(__file__).resolve().parent.parent / "openapi.yaml"

_PAGE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Cupel API — the contract</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; }
      .swagger-ui .topbar { display: none; }
    </style>
  </head>
  <body>
    <div id="swagger"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      // Relative: resolves under the hosted demo's /cupel-demo mount as well as
      // at the root. Try-it-out therefore also targets whichever origin served
      // this page, which is the running mock.
      window.ui = SwaggerUIBundle({
        url: "openapi.yaml",
        dom_id: "#swagger",
        deepLinking: true,
        docExpansion: "none",
        defaultModelsExpandDepth: 1,
        tryItOutEnabled: true,
      });
    </script>
  </body>
</html>
"""

_MISSING = (
    "openapi.yaml is not present in this deployment, so there is nothing to "
    "document. The contract lives at the repo root and is served from disk; "
    "run the mock from a checkout, or add it to the image."
)


def register_docs(app: FastAPI) -> None:
    """Mount the contract and its Swagger UI on `app`. Call once, per app."""

    @app.get("/openapi.yaml", include_in_schema=False)
    async def contract():
        if not CONTRACT.is_file():
            return PlainTextResponse(_MISSING, status_code=404)
        # no-store, not a max-age: an edit to the contract must show on the
        # next reload, which is the only reason this reads from disk at all.
        return FileResponse(
            CONTRACT,
            media_type="application/yaml",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/docs", include_in_schema=False)
    async def docs_page():
        return HTMLResponse(_PAGE, headers={"Cache-Control": "no-store"})
