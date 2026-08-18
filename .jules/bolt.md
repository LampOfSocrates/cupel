## 2025-05-18 - Post-migration SQLite Index Creation
**Learning:** Indexes on columns that might be modified or added via schema migrations (such as `conversations(user_id)` or `judgments(evaluation_id)`) must be applied after all migration methods run during database initialization to prevent schema errors on legacy or unmigrated databases.
**Action:** Always place `_create_indexes()` execution at the end of `Db.__init__` in `mock/db.py` after all `_migrate_*` methods complete.
