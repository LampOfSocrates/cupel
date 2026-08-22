## 2025-05-18 - SQLite Performance Indexes and Schema Migration Timing

**Learning:** Database performance indexes targeting columns generated or modified by schema migrations (e.g. `conversations.user_id`) must be created at the end of `Db.__init__` after all migration routines have finished executing, preventing schema boot errors on legacy databases.

**Action:** Always place `CREATE INDEX IF NOT EXISTS` queries in a `_create_indexes()` helper called at the very end of database initialization/migrations.
