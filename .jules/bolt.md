## 2026-08-05 - SQLite foreign key performance indexes after migrations
**Learning:** In SQLite databases that apply schema migrations dynamically at boot, creating performance indexes on foreign keys and filter columns must occur after all migrations run, to avoid schema boot errors on columns added by migrations (such as `user_id` on `conversations`).
**Action:** Always place `CREATE INDEX IF NOT EXISTS` at the end of `Db.__init__` after all `_migrate_*` methods have committed their schema changes.
