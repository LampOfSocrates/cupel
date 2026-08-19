## 2025-05-18 - Database performance indexes must be created after schema migrations in SQLite

**Learning:** Database indexes targeting columns that are added or modified by schema migrations (such as `conversations(user_id)` or `judgments(evaluation_id)`) will fail on application startup if executed before or alongside table initialization in `SCHEMA`. Executing index creation in `Db.__init__` right after migration methods ensures that all columns exist regardless of whether the database was freshly created or upgraded from an older schema version.

**Action:** Always place `CREATE INDEX IF NOT EXISTS` statements at the end of database initialization routines after all migration steps have completed.
