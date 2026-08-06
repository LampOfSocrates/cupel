"""P2-PERSIST container entrypoint: pick the storage mode, then serve.

This is the Docker CMD (`python -m mock.boot`). It sits one layer OUTSIDE
mock/entrypoint.py, which is unchanged in what it does — serve + seed:

  SKEIN_STORAGE=local (default)   exec `python -m mock.entrypoint`. Nothing
                                  else happens; a developer checkout and the
                                  current Render deploy behave exactly as they
                                  did before this task.

  SKEIN_STORAGE=s3                write litestream.yml from the SKEIN_S3_*
                                  env, restore the SQLite file from the bucket
                                  if a replica exists, then exec
                                  `litestream replicate -exec "python -m
                                  mock.entrypoint"` so every subsequent write
                                  is streamed back to the bucket.

Why Litestream rather than periodic snapshot/upload: it replicates the WAL
continuously (seconds of exposure, not minutes), it is a single static binary
with no Python dependency, and it is purpose-built for exactly this shape —
SQLite on an ephemeral disk in front of object storage. mock/db.py enables
WAL journaling, which Litestream requires.

DEGRADATION IS DELIBERATE. The hosted demo must keep serving, so nothing here
is fatal: missing S3 env or a missing litestream binary logs loudly and falls
back to local mode; a failed restore logs loudly and continues with a fresh
database, which mock/entrypoint.py then seeds because it is empty. A crash
loop would take the demo down to protect data that, by definition, was not
there.

The planning half (build_boot_plan) is pure so the whole s3 wiring — command
lines, generated config, credential env, degradation — is asserted in
mock/tests/test_storage.py without a bucket, a binary or a container.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

from . import config, storage


def log(msg: str) -> None:
    print(f"[boot] {msg}", flush=True)


def build_boot_plan(env, db_path: str, python: str = "python",
                    have_litestream: bool = True) -> dict:
    """Pure: environment -> what to write, run and exec.

    Returns
      mode          the EFFECTIVE mode after degradation ("local"|"s3")
      requested     what SKEIN_STORAGE asked for
      config_path   litestream.yml destination, or None in local mode
      config_text   its contents, or None
      restore       argv for the boot restore, or None
      exec          argv to exec (the long-running process)
      child_env     env additions for that process
      warnings      human-readable reasons for any degradation
    """
    requested = storage.mode(env)
    plan = {
        "mode": storage.LOCAL,
        "requested": requested,
        "db_path": db_path,
        "config_path": None,
        "config_text": None,
        "restore": None,
        "exec": [python, "-m", "mock.entrypoint"],
        "child_env": {"SKEIN_STORAGE": storage.LOCAL},
        "warnings": [],
    }
    if requested != storage.S3:
        return plan

    settings, missing = storage.s3_settings(env)
    if missing:
        plan["warnings"].append(
            "SKEIN_STORAGE=s3 but " + ", ".join(missing) + " not set — running "
            "LOCAL and UNREPLICATED; data will be lost on restart "
            "(docs/deployment.md)"
        )
        return plan
    if not have_litestream:
        plan["warnings"].append(
            "SKEIN_STORAGE=s3 but the `litestream` binary is not on PATH — "
            "running LOCAL and UNREPLICATED; data will be lost on restart. "
            "The Render image installs it (Dockerfile); locally, install "
            "Litestream or use SKEIN_STORAGE=local"
        )
        return plan

    config_path = (env.get("SKEIN_LITESTREAM_CONFIG") or "").strip() \
        or storage.DEFAULT_CONFIG_PATH
    plan.update(
        mode=storage.S3,
        config_path=config_path,
        config_text=storage.litestream_yml(db_path, settings),
        # -if-db-not-exists: never clobber a database that is already here.
        # -if-replica-exists: a first-ever boot (empty bucket) is success, not
        # an error — it just means "nothing to restore yet".
        restore=["litestream", "restore", "-if-db-not-exists",
                 "-if-replica-exists", "-config", config_path, db_path],
        # Flags MUST precede positional args; there are none here (the config
        # file names the database). Litestream exits when the child exits, and
        # forwards SIGTERM to it before a final sync. -exec is ONE string that
        # litestream splits with shell-words rules, so the interpreter path is
        # quoted — /usr/local/bin/python needs none, a Windows dev path does.
        exec=["litestream", "replicate", "-config", config_path,
              "-exec", f"{shlex.quote(python)} -m mock.entrypoint"],
        child_env={"SKEIN_STORAGE": storage.S3, **storage.litestream_env(settings)},
    )
    return plan


def main(argv=None) -> int:
    env = os.environ
    db_path = env.get("SKEIN_MOCK_DB") or config.DB_PATH
    plan = build_boot_plan(
        env,
        db_path=db_path,
        python=sys.executable or "python",
        have_litestream=shutil.which("litestream") is not None,
    )
    for warning in plan["warnings"]:
        log(f"WARNING: {warning}")

    child_env = {**env, **plan["child_env"]}
    restored = False
    # The image points SKEIN_MOCK_DB at /app/data, which the Dockerfile
    # creates — but a bind mount, a scratch path or a restore target can still
    # name a directory that is not there yet, and sqlite3 will not make one.
    if db_path != ":memory:":
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    if plan["config_text"]:
        Path(plan["config_path"]).parent.mkdir(parents=True, exist_ok=True)
        Path(plan["config_path"]).write_text(plan["config_text"], encoding="utf-8")
        log(f"storage mode s3 — litestream config at {plan['config_path']}")

    if plan["restore"]:
        existed = Path(db_path).exists()
        code = subprocess.run(plan["restore"], env=child_env).returncode
        if code != 0:
            log(f"WARNING: litestream restore failed (exit {code}) — continuing "
                "with a fresh database; the boot seed will refill it")
        # -if-replica-exists makes "nothing in the bucket" a success too, so
        # the file appearing is what actually distinguishes a restore.
        restored = not existed and Path(db_path).exists()
        log(f"restore: {'database restored from the replica' if restored else 'no replica restored (fresh database)'}")

    child_env["SKEIN_STORAGE_RESTORED"] = "1" if restored else "0"
    log(f"storage mode {plan['mode']} · db {db_path} · exec {' '.join(plan['exec'])}")

    if os.name == "nt":
        # execvpe on Windows detaches the replacement process, which would
        # orphan it under `npm start`; the container is Linux and takes the
        # exec path below.
        return subprocess.run(plan["exec"], env=child_env).returncode
    os.execvpe(plan["exec"][0], plan["exec"], child_env)
    return 0  # unreachable


if __name__ == "__main__":
    raise SystemExit(main())
