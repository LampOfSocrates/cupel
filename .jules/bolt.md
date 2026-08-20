## 2026-08-20 - Database Performance Indexes
**Learning:** Performance indexes targeting SQLite columns generated or modified by schema migrations must be created at the end of `Db.__init__` (after migrations execute) to avoid schema boot errors.
**Action:** When adding SQLite database indexes, execute `CREATE INDEX IF NOT EXISTS` after schema migrations in `Db.__init__`.
