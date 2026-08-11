# Bolt's Journal - Critical Learnings

## 2025-02-22 - SQLite Performance Optimization with Indexes in Schema Migrations
**Learning:** Adding indexes to columns generated or modified by schema migrations inside `mock/db.py` must happen at the end of `Db.__init__` (after all migrations have executed and before the connection is committed). Attempting to create indexes earlier or directly in the `SCHEMA` definition can trigger schema boot errors because the columns or tables might not exist yet when migrating older databases.
**Action:** Always create performance indexes targeting dynamically-created or migration-modified columns at the very end of `Db.__init__` to ensure a safe, crash-free, and highly performant boot.
