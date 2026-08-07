"""P1-TDEPLOY same-origin production serving (docs/deployment.md:4).

"One Docker container: FastAPI mock serves the API AND the built Vite
bundle." — when a built dist/ exists, a catch-all GET route registered AFTER
every API route serves it: real files as-is, everything else falls back to
index.html so client-side routing survives a refresh. API routes always win
(Starlette matches routes in registration order). When dist/ is absent
(local dev: frontend on :5173, mock on :4010) nothing is mounted and the
server behaves exactly as before.

Resolution order for the bundle directory: explicit argument (tests) →
env CUPEL_STATIC_DIR (the Docker image sets /app/dist) → ../dist next to
this package. A directory without index.html counts as absent.
"""

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse


def resolve_static_dir(static_dir: str | None = None) -> Path | None:
    root = Path(
        static_dir
        or os.environ.get("CUPEL_STATIC_DIR")
        or Path(__file__).resolve().parent.parent / "dist"
    )
    return root.resolve() if (root / "index.html").is_file() else None


def mount_spa(app: FastAPI, root: Path) -> None:
    """Register the SPA catch-all. Call LAST, after all API routes."""
    index = root / "index.html"

    @app.get("/{spa_path:path}", include_in_schema=False)
    async def spa(spa_path: str):
        try:
            candidate = (root / spa_path).resolve()
        except (OSError, ValueError):
            return FileResponse(index)
        # Real bundle files (assets/*.js, favicons, ...) are served directly;
        # the resolve()+is_relative_to pair blocks ../ traversal out of dist.
        if candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(index)
