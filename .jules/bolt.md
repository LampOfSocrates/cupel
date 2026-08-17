## 2026-03-30 - SQLite Foreign Key Performance Indexing
**Learning:** In SQLite persistence schemas with frequent relational queries (`turns` by `conversation_id`, `spans` by `turn_id`, `judgments` by `evaluation_id`/`conversation_id`, `tasks` by `parent_id`, `evaluation_rows`/`cells` by `evaluation_id`), missing indexes cause O(N) full table scans.
**Action:** Create indexes using `CREATE INDEX IF NOT EXISTS` at the end of `Db.__init__` after schema migrations execute to avoid schema initialization errors on legacy databases.
