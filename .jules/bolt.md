## 2026-08-14 - SQLite Database Indexes and Python 3.12+ Pathlib Compatibility

**Learning:**
1. Database performance indexes on SQLite schema columns generated or modified by schema migrations (such as `conversations.user_id` or `judgments.evaluation_id`) must be created after all migrations complete at the end of `Db.__init__` rather than in the initial `SCHEMA` string, preventing migration boot failures on pre-existing databases.
2. In Python 3.12+, mocking `os.name = 'nt'` on Linux or macOS environments causes `pathlib.Path` to instantiate `WindowsPath`, which raises `NotImplementedError` when methods like `Path.parent` are called. Target `os.execvpe` directly instead of modifying `os.name`.

**Action:**
- Place `CREATE INDEX IF NOT EXISTS` calls after `Db` migrations run in `mock/db.py`.
- Mock process execution functions (`os.execvpe`) directly when testing container/process entrypoints without poisoning `os.name` in Python 3.12+.
