"""Storage tests: storage modes, the Litestream wiring, seed-if-empty.

No bucket, no litestream binary, no container is touched — mock/boot.py splits
the pure plan (env -> config text + argv + child env) from the four lines that
execute it, so everything that could be wrong about the s3 path is asserted
here as data. Run: npm run test:mock.
"""

import asyncio
import sqlite3

import httpx
import pytest

from mock import boot, storage
from mock.db import Db
from mock.entrypoint import should_seed
from mock.main import create_app

S3_ENV = {
    "CUPEL_STORAGE": "s3",
    "CUPEL_S3_BUCKET": "cupel-demo",
    "CUPEL_S3_ENDPOINT": "https://acct.r2.cloudflarestorage.com",
    "CUPEL_S3_ACCESS_KEY_ID": "AKIAEXAMPLE",
    "CUPEL_S3_SECRET_ACCESS_KEY": "s3cr3t-value",
}

DB = "/app/data/cupel-mock.sqlite"


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------- mode select
def test_mode_defaults_to_local():
    assert storage.mode({}) == "local"
    assert storage.mode({"CUPEL_STORAGE": ""}) == "local"
    assert storage.mode({"CUPEL_STORAGE": "  S3 "}) == "s3"
    assert storage.mode({"CUPEL_STORAGE": "local"}) == "local"


def test_unknown_mode_falls_back_to_local_rather_than_failing():
    """A typo must not take the hosted demo down."""
    assert storage.mode({"CUPEL_STORAGE": "gcs"}) == "local"


def test_health_storage_shape():
    assert storage.health_storage({}) == {"mode": "local"}
    # local mode never claims a restore happened
    assert "restored" not in storage.health_storage({"CUPEL_STORAGE_RESTORED": "1"})
    assert storage.health_storage({"CUPEL_STORAGE": "s3"}) == {"mode": "s3", "restored": False}
    assert storage.health_storage(
        {"CUPEL_STORAGE": "s3", "CUPEL_STORAGE_RESTORED": "1"}
    ) == {"mode": "s3", "restored": True}


# ------------------------------------------------------------- s3 config
def test_s3_settings_defaults_and_missing():
    settings, missing = storage.s3_settings(S3_ENV)
    assert missing == []
    assert settings["bucket"] == "cupel-demo"
    assert settings["path"] == storage.DEFAULT_S3_PATH
    assert settings["region"] == storage.DEFAULT_S3_REGION

    settings, missing = storage.s3_settings(
        {**S3_ENV, "CUPEL_S3_PATH": "demo/db", "CUPEL_S3_REGION": "us-east-1"})
    assert (settings["path"], settings["region"]) == ("demo/db", "us-east-1")

    _, missing = storage.s3_settings({"CUPEL_STORAGE": "s3", "CUPEL_S3_BUCKET": "b"})
    assert missing == ["CUPEL_S3_ENDPOINT", "CUPEL_S3_ACCESS_KEY_ID",
                       "CUPEL_S3_SECRET_ACCESS_KEY"]


def test_litestream_yml_names_one_db_one_replica_and_no_secrets():
    settings, _ = storage.s3_settings(S3_ENV)
    text = storage.litestream_yml(DB, settings)
    assert f'- path: "{DB}"' in text
    assert "    replica:" in text and "replicas:" not in text  # 0.5 singular form
    assert "      type: s3" in text
    assert '      bucket: "cupel-demo"' in text
    assert '      path: "cupel-mock"' in text
    assert '      endpoint: "https://acct.r2.cloudflarestorage.com"' in text
    assert '      region: "auto"' in text
    # Credentials travel by env, never onto the container's disk.
    assert "s3cr3t-value" not in text
    assert "AKIAEXAMPLE" not in text
    assert "access-key-id" not in text


def test_litestream_env_carries_the_credentials():
    settings, _ = storage.s3_settings(S3_ENV)
    assert storage.litestream_env(settings) == {
        "LITESTREAM_ACCESS_KEY_ID": "AKIAEXAMPLE",
        "LITESTREAM_SECRET_ACCESS_KEY": "s3cr3t-value",
    }


# ------------------------------------------------------------- boot plan
def test_local_plan_is_the_pre_existing_behaviour():
    plan = boot.build_boot_plan({}, db_path=DB, python="py")
    assert plan["mode"] == "local"
    assert plan["exec"] == ["py", "-m", "mock.entrypoint"]
    assert plan["restore"] is None and plan["config_text"] is None
    assert plan["child_env"] == {"CUPEL_STORAGE": "local"}
    assert plan["warnings"] == []


def test_s3_plan_restores_then_replicates_with_exec():
    plan = boot.build_boot_plan(S3_ENV, db_path=DB, python="py")
    assert plan["mode"] == "s3" and plan["warnings"] == []
    assert plan["config_path"] == storage.DEFAULT_CONFIG_PATH
    assert plan["restore"] == [
        "litestream", "restore", "-if-db-not-exists", "-if-replica-exists",
        "-config", storage.DEFAULT_CONFIG_PATH, DB,
    ]
    # Flags MUST precede positionals; -exec wraps the unchanged app entrypoint.
    assert plan["exec"] == [
        "litestream", "replicate", "-config", storage.DEFAULT_CONFIG_PATH,
        "-exec", "py -m mock.entrypoint",
    ]
    assert plan["child_env"]["CUPEL_STORAGE"] == "s3"
    assert plan["child_env"]["LITESTREAM_ACCESS_KEY_ID"] == "AKIAEXAMPLE"
    assert storage.litestream_yml(DB, storage.s3_settings(S3_ENV)[0]) == plan["config_text"]


def test_exec_string_quotes_an_interpreter_path_with_spaces():
    """Litestream splits -exec with shell-words rules, so an unquoted
    `C:\\Program Files\\...` (or any spaced prefix) would exec the wrong thing."""
    plan = boot.build_boot_plan(S3_ENV, db_path=DB, python=r"C:\Program Files\py.exe")
    assert plan["exec"][-1] == "'C:\\Program Files\\py.exe' -m mock.entrypoint"


def test_s3_plan_honours_a_custom_config_path():
    plan = boot.build_boot_plan({**S3_ENV, "CUPEL_LITESTREAM_CONFIG": "/tmp/ls.yml"},
                                db_path=DB)
    assert plan["config_path"] == "/tmp/ls.yml"
    assert "/tmp/ls.yml" in plan["restore"] and "/tmp/ls.yml" in plan["exec"]


def test_missing_s3_env_degrades_to_local_and_says_which_vars():
    plan = boot.build_boot_plan({"CUPEL_STORAGE": "s3", "CUPEL_S3_BUCKET": "b"},
                                db_path=DB, python="py")
    assert plan["mode"] == "local" and plan["requested"] == "s3"
    assert plan["exec"] == ["py", "-m", "mock.entrypoint"]
    assert plan["child_env"] == {"CUPEL_STORAGE": "local"}
    assert "CUPEL_S3_ENDPOINT" in plan["warnings"][0]
    assert "UNREPLICATED" in plan["warnings"][0]


def test_missing_litestream_binary_degrades_to_local():
    plan = boot.build_boot_plan(S3_ENV, db_path=DB, python="py", have_litestream=False)
    assert plan["mode"] == "local"
    assert plan["exec"] == ["py", "-m", "mock.entrypoint"]
    assert "litestream" in plan["warnings"][0]


def test_restore_failure_serves_a_fresh_db_instead_of_crash_looping(tmp_path, monkeypatch):
    """A bad bucket/credential must not become a crash loop: log, carry on
    with an empty database, let seed-if-empty refill it."""
    db = tmp_path / "cupel.sqlite"
    cfg = tmp_path / "litestream.yml"
    monkeypatch.setattr(boot.shutil, "which", lambda _name: "/usr/local/bin/litestream")
    for key, value in {**S3_ENV, "CUPEL_MOCK_DB": str(db),
                       "CUPEL_LITESTREAM_CONFIG": str(cfg)}.items():
        monkeypatch.setenv(key, value)

    calls = []

    class Result:
        def __init__(self, code):
            self.returncode = code

    def fake_run(argv, env=None):
        calls.append((argv, env))
        return Result(1 if argv[1] == "restore" else 0)  # restore fails

    def fake_execvpe(file, args, env):
        calls.append((args, env))

    monkeypatch.setattr(boot.subprocess, "run", fake_run)
    monkeypatch.setattr(boot.os, "execvpe", fake_execvpe)
    assert boot.main() == 0

    assert cfg.read_text(encoding="utf-8").startswith("# GENERATED")
    assert calls[0][0][1] == "restore"
    assert calls[1][0][:2] == ["litestream", "replicate"]
    # Server still starts, and it is told no restore happened.
    assert calls[1][1]["CUPEL_STORAGE_RESTORED"] == "0"
    assert calls[1][1]["CUPEL_STORAGE"] == "s3"
    assert not db.exists()


def test_successful_restore_is_reported_to_the_server(tmp_path, monkeypatch):
    db = tmp_path / "cupel.sqlite"
    cfg = tmp_path / "litestream.yml"
    monkeypatch.setattr(boot.shutil, "which", lambda _name: "/usr/local/bin/litestream")
    for key, value in {**S3_ENV, "CUPEL_MOCK_DB": str(db),
                       "CUPEL_LITESTREAM_CONFIG": str(cfg)}.items():
        monkeypatch.setenv(key, value)

    calls = []

    class Result:
        returncode = 0

    def fake_run(argv, env=None):
        calls.append((argv, env))
        if argv[1] == "restore":
            db.write_bytes(b"")  # litestream pulled the replica down
        return Result()

    def fake_execvpe(file, args, env):
        calls.append((args, env))

    monkeypatch.setattr(boot.subprocess, "run", fake_run)
    monkeypatch.setattr(boot.os, "execvpe", fake_execvpe)
    assert boot.main() == 0
    assert calls[1][1]["CUPEL_STORAGE_RESTORED"] == "1"


# ------------------------------------------------------------------- WAL
def test_wal_is_on_for_file_databases(tmp_path):
    """Litestream replicates WAL frames — without this, s3 mode cannot work."""
    db = Db(str(tmp_path / "wal.sqlite"))
    assert db.journal_mode == "wal"
    assert db.conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    # the RLock-serialized helpers still behave
    db.run("INSERT INTO meta (key, value) VALUES ('k', 'v')")
    assert db.one("SELECT value FROM meta WHERE key='k'")["value"] == "v"
    assert db.all("SELECT * FROM meta") == [{"key": "k", "value": "v"}]


def test_memory_databases_are_unaffected():
    db = Db(":memory:")
    assert db.journal_mode == "memory"
    assert db.all("SELECT * FROM meta") == []


# --------------------------------------------------------- database_is_empty
def test_database_is_empty_covers_absent_fresh_and_populated(tmp_path):
    path = tmp_path / "cupel.sqlite"
    assert storage.database_is_empty(str(path))       # not there at all
    assert storage.database_is_empty(":memory:")
    assert storage.database_is_empty("")

    Db(str(path))                                      # schema, no rows
    assert storage.database_is_empty(str(path))

    conn = sqlite3.connect(str(path))
    conn.execute(
        "INSERT INTO conversations (id, tree_id, title, created_at, last_activity_at)"
        " VALUES ('c1', 'agent1', 't', 'now', 'now')")
    conn.commit()
    conn.close()
    assert not storage.database_is_empty(str(path))


def test_unreadable_database_counts_as_empty(tmp_path):
    """A truncated/half-restored file must resolve to 'seed me', not a crash."""
    junk = tmp_path / "junk.sqlite"
    junk.write_bytes(b"not a database at all")
    assert storage.database_is_empty(str(junk))


# ------------------------------------------------------------ seed-if-empty
def test_should_seed_rules(tmp_path):
    path = tmp_path / "cupel.sqlite"
    assert should_seed({}, str(path)) == (False, "CUPEL_SEED_ON_BOOT != 1")

    on = {"CUPEL_SEED_ON_BOOT": "1"}
    seed_it, why = should_seed(on, str(path))
    assert seed_it and "empty" in why

    Db(str(path))
    assert should_seed(on, str(path))[0] is True      # schema only is still empty

    conn = sqlite3.connect(str(path))
    conn.execute(
        "INSERT INTO conversations (id, tree_id, title, created_at, last_activity_at)"
        " VALUES ('c1', 'agent1', 't', 'now', 'now')")
    conn.commit()
    conn.close()
    seed_it, why = should_seed(on, str(path))
    assert seed_it is False
    assert "not seeding on top of it" in why


# ----------------------------------------------------------------- /healthz
def test_healthz_reports_the_active_storage_mode(monkeypatch):
    async def case(expected):
        app = create_app(db_path=":memory:", token_delay=0, step_delay=0,
                         static_dir="__no_dist__")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://t") as c:
            body = (await c.get("/healthz")).json()
        assert body["status"] == "ok" and body["seed"]
        assert body["storage"] == expected

    monkeypatch.delenv("CUPEL_STORAGE", raising=False)
    monkeypatch.delenv("CUPEL_STORAGE_RESTORED", raising=False)
    run(case({"mode": "local"}))

    monkeypatch.setenv("CUPEL_STORAGE", "s3")
    monkeypatch.setenv("CUPEL_STORAGE_RESTORED", "1")
    run(case({"mode": "s3", "restored": True}))


@pytest.mark.parametrize("restored", ["0", None])
def test_healthz_s3_without_a_restore(monkeypatch, restored):
    monkeypatch.setenv("CUPEL_STORAGE", "s3")
    if restored is None:
        monkeypatch.delenv("CUPEL_STORAGE_RESTORED", raising=False)
    else:
        monkeypatch.setenv("CUPEL_STORAGE_RESTORED", restored)

    async def case():
        app = create_app(db_path=":memory:", token_delay=0, step_delay=0,
                         static_dir="__no_dist__")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://t") as c:
            assert (await c.get("/healthz")).json()["storage"] == {
                "mode": "s3", "restored": False}

    run(case())
