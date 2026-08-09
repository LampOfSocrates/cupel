"""Container entrypoint: serve + seed a fresh database on boot.

Run: python -m mock.entrypoint  (invoked by mock/boot.py, which picks the
storage mode first; also works standalone and locally)

Behavior:
  1. uvicorn serves mock.main:app on 0.0.0.0:$PORT (Render injects PORT;
     default 4010) in the MAIN thread, so SIGTERM handling stays uvicorn's.
  2. A background thread polls /healthz on localhost until the server is up.
  3. It then seeds — but only when should_seed() says so (see below). Seeding
     runs the generator's seed mode against localhost (--seed $CUPEL_SEED,
     default 42; --token $DEMO_TOKEN when the gate is on — the generator
     writes through the public API, so it must pass the gate like any other
     client). Progress is logged; the server just keeps serving during and
     after.

SEED ONLY IF EMPTY. CUPEL_SEED_ON_BOOT=1 used to mean "re-seed
on every boot" — the mitigation for a disk that lost everything anyway
(docs/deployment.md). With CUPEL_STORAGE=s3 the database now SURVIVES a
restart, so the flag reads as "make sure this backend has data", and seeding
is skipped whenever the database already holds conversations. Otherwise every
restart would layer a fresh seed on top of real demo data: the generator's
idempotency covers chats (deterministic client_message_id) and skips forks /
replays / judgments by check-before-create, but evaluations and judgments can still
accrete — which was tolerable only while the disk was ephemeral. The
deterministic seed is unchanged for the empty case, so a first boot (or a
boot after a failed restore) still lands on the same dataset as before.
"""

import os
import threading
import time

import httpx
import uvicorn

from . import config, generator, storage

HEALTH_TIMEOUT_S = 120.0


def log(msg: str) -> None:
    print(f"[entrypoint] {msg}", flush=True)


def wait_healthz(base: str, timeout: float = HEALTH_TIMEOUT_S) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"{base}/healthz", timeout=5.0).status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    return False


def should_seed(env, db_path: str) -> tuple[bool, str]:
    """(seed?, why) — the seed-if-empty rule, pure apart from reading the DB
    file read-only. See the module docstring."""
    if env.get("CUPEL_SEED_ON_BOOT") != "1":
        return False, "CUPEL_SEED_ON_BOOT != 1"
    if not storage.database_is_empty(db_path):
        return False, ("database already holds conversations (restored replica "
                       "or warm restart) — not seeding on top of it")
    return True, "database is empty"


def seed_when_ready(port: int) -> None:
    base = f"http://127.0.0.1:{port}"
    if not wait_healthz(base):
        log(f"healthz never came up on {base}; skipping boot seed")
        return
    log(f"server healthy on {base}")
    db_path = os.environ.get("CUPEL_MOCK_DB") or config.DB_PATH
    seed_it, why = should_seed(os.environ, db_path)
    if not seed_it:
        log(f"skipping boot seed: {why}")
        return
    log(f"boot seed will run: {why}")
    seed = os.environ.get("CUPEL_SEED", "42")
    token = os.environ.get("DEMO_TOKEN")
    argv = ["seed", "--base", base, "--seed", seed]
    if token:
        argv += ["--token", token]
    log(f"seeding (seed={seed}, token={'set' if token else 'none'}) ...")
    try:
        generator.main(argv)
        log("boot seed complete")
    except SystemExit as exc:
        log(f"boot seed aborted: {exc}")
    except Exception as exc:  # keep serving even if seeding fails
        log(f"boot seed failed: {exc!r}")


def main() -> None:
    port = int(os.environ.get("PORT", "4010"))
    threading.Thread(target=seed_when_ready, args=(port,), daemon=True).start()
    log(f"starting uvicorn on 0.0.0.0:{port}")
    uvicorn.run("mock.main:app", host="0.0.0.0", port=port, log_level="info")


if __name__ == "__main__":
    main()
