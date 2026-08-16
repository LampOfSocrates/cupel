## 2026-08-06 - Database Indexes and Migration Execution Order
**Learning:** In `mock/db.py`, performance indexes targeting columns generated or modified by schema migrations (such as `user_id` on `conversations` or `evaluation_id` on `judgments`) must be created at the end of `Db.__init__` (after migrations execute). Creating them prematurely in the static `SCHEMA` block fails or creates invalid indexes on pre-migration database shapes.
**Action:** Always place `CREATE INDEX IF NOT EXISTS` statements after migration functions run in `Db.__init__`.
