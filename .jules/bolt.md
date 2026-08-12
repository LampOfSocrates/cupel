# Bolt Performance Journal

## 2026-08-05 - Safe Database Performance Indexes Creation in SQLite
**Learning:** SQLite database indexes on columns created or populated by dynamic migrations can trigger schema boot errors or lock exceptions if executed inline with the initial `SCHEMA` definition before migration scripts run.
**Action:** Always execute `CREATE INDEX IF NOT EXISTS` commands at the very end of database initialization (`Db.__init__`), immediately before committing the transaction, to ensure all table columns (such as `user_id` or `evaluation_id`) exist and have been migrated successfully.
