"""Cupel mock server package.

LEGACY ENV ALIAS (rename Skein → Cupel, 2026-08-07). Every variable this
package reads is now CUPEL_*, but the LIVE Render service still has the old
SKEIN_* names in its dashboard — renaming them in render.yaml does not rename
them on a running service. So on import, any SKEIN_* variable whose CUPEL_*
counterpart is unset is copied across. CUPEL_* always wins; nothing is
removed. Importing the package is the one thing every entry point
(mock.boot, mock.entrypoint, uvicorn mock.main:app, pytest) does first.

DELETE THIS once the Render dashboard has been updated to CUPEL_* — it exists
only to carry the running deploy across the rename.
"""

import os


def _alias_legacy_env(env=None) -> None:
    env = os.environ if env is None else env
    for key in [k for k in env if k.startswith("SKEIN_")]:
        new = "CUPEL_" + key[len("SKEIN_"):]
        if new not in env:
            env[new] = env[key]


_alias_legacy_env()
