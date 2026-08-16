## 2026-08-16 - Database Indexes and Migration Order
**Learning:** In SQLite databases that run schema migrations on boot (such as adding columns like `user_id` or physical schema renames), adding indexes during initial `CREATE TABLE` definitions can fail on legacy databases if those columns don't exist prior to migrations running.
**Action:** Place `CREATE INDEX IF NOT EXISTS` calls at the end of `Db.__init__` after all schema migrations execute.
