## 2026-08-05 - Database Performance Indexes After Schema Migrations

**Learning:** Performance indexes targeting columns created or renamed by schema migrations (such as `conversations(user_id)` or `judgments(evaluation_id)`) must be executed at the end of `Db.__init__` after all `_migrate_*()` routines run. Attempting to create indexes in `SCHEMA` before migrations execute causes boot errors on legacy databases.

**Action:** Always execute index creation via `_create_indexes()` after schema migration helper functions complete in `Db.__init__`.
