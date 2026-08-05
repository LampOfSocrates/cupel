"""P1-TDEPLOY container entrypoint: serve + deterministic re-seed on boot.

Run: python -m mock.entrypoint  (the Docker CMD; also works locally)

docs/deployment.md:8-10 — the free tier has "no persistent disk → SQLite is
ephemeral. Mitigation: mock re-seeds deterministically on boot (generator
seed mode, fixed --seed), so a restart resets to seeded state".

Behavior:
  1. uvicorn serves mock.main:app on 0.0.0.0:$PORT (Render injects PORT;
     default 4010) in the MAIN thread, so SIGTERM handling stays uvicorn's.
  2. A background thread polls /healthz on localhost until the server is up.
  3. If SKEIN_SEED_ON_BOOT=1, it then runs the generator's seed mode against
     localhost (--seed $SKEIN_SEED, default 42; --token $DEMO_TOKEN when the
     gate is on — the generator writes through the public API, so it must
     pass the gate like any other client). Progress is logged; the server
     just keeps serving during and after.

Idempotency (generator module docstring): re-running seed dedupes chats via
deterministic client_message_id and check-before-create skips, so a warm
restart with a surviving DB converges to the same dataset. Runs/judgments
CAN accrete across restarts in edge cases — acceptable per deployment.md:
the DB is ephemeral anyway, "a restart resets to seeded state".
"""

import os
import threading
import time

import httpx
import uvicorn

from . import generator

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


def seed_when_ready(port: int) -> None:
    base = f"http://127.0.0.1:{port}"
    if not wait_healthz(base):
        log(f"healthz never came up on {base}; skipping boot seed")
        return
    log(f"server healthy on {base}")
    if os.environ.get("SKEIN_SEED_ON_BOOT") != "1":
        log("SKEIN_SEED_ON_BOOT != 1 — skipping boot seed")
        return
    seed = os.environ.get("SKEIN_SEED", "42")
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
