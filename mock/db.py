"""SQLite persistence.

Modeled loosely on ADK sessions/events so the Phase-2 ADK adapter is a thin
remap: conversations ~ ADK sessions, turns ~ ADK events (author + invocation_id
grouping the user/assistant pair of one chat call), spans ~ per-invocation
telemetry keyed by turn.
"""

import json
import sqlite3
import threading

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS trees (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL, name TEXT NOT NULL,
  parent_id TEXT, tools TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1, format TEXT NOT NULL DEFAULT 'text');

-- Append-only (cupel-phases.md:160); live version = MAX(version).
CREATE TABLE IF NOT EXISTS instruction_versions (
  agent_id TEXT NOT NULL, version INTEGER NOT NULL,
  content TEXT NOT NULL, format TEXT NOT NULL, created_at TEXT NOT NULL,
  promoted_from_snapshot_id TEXT,
  PRIMARY KEY (agent_id, version));

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  content TEXT NOT NULL, base_version INTEGER,
  label TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS selections (
  agent_id TEXT PRIMARY KEY, items TEXT NOT NULL);

-- ~ ADK sessions. lineage is a JSON Lineage object, present iff fork.
-- user_id is the OWNING user, the cross-user dimension the
-- Inspector filters on (AdminConversationItem.user_id, openapi.yaml:3139).
-- Pre-existing databases gain it in Db._migrate_conversation_owner below.
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL, title TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'interactive', channel TEXT, agent_id TEXT,
  created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, lineage TEXT, user_id TEXT);

-- ~ ADK events. conversation_id NULL = detached replay output (grid cell
-- result that forked no conversation; still traceable by turn id).
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY, conversation_id TEXT, tree_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL, role TEXT NOT NULL, author TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '', content_type TEXT NOT NULL DEFAULT 'text',
  created_at TEXT NOT NULL, envelope TEXT, attachments TEXT NOT NULL DEFAULT '[]',
  client_message_id TEXT, task_id TEXT);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, content_type TEXT NOT NULL,
  size INTEGER NOT NULL, data BLOB, created_at TEXT NOT NULL);

-- payload is internal re-run state for retry-failed, never serialized out.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 1,
  stage TEXT, parent_id TEXT, result TEXT, error TEXT, payload TEXT,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);

CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL, task_id TEXT NOT NULL,
  label TEXT, created_at TEXT NOT NULL, columns TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS evaluation_rows (
  evaluation_id TEXT NOT NULL, row_idx INTEGER NOT NULL,
  conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  prompt TEXT NOT NULL, envelope TEXT,
  PRIMARY KEY (evaluation_id, row_idx));

CREATE TABLE IF NOT EXISTS evaluation_cells (
  evaluation_id TEXT NOT NULL, row_idx INTEGER NOT NULL, col_idx INTEGER NOT NULL,
  status TEXT NOT NULL, content TEXT, conversation_id TEXT, turn_id TEXT,
  task_id TEXT, case_id TEXT, latest_score REAL, error TEXT,
  PRIMARY KEY (evaluation_id, row_idx, col_idx));

-- payload_ref = span id; prompt/response/args/result back GET /spans/{id}/payload.
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, parent_id TEXT,
  type TEXT NOT NULL, name TEXT NOT NULL,
  start_ts TEXT NOT NULL, end_ts TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost REAL, model TEXT,
  status TEXT NOT NULL, error TEXT,
  prompt TEXT, response TEXT, args TEXT, result TEXT);

-- Seeded users (auth-on credentials, feature-spec.md:21). Part of the
-- IF NOT EXISTS schema, which runs on EVERY Db open — pre-existing DBs gain
-- the table additively; rows are seeded via auth.ensure_users (INSERT OR
-- IGNORE, migration-safe).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, roles TEXT NOT NULL DEFAULT '[]',
  permissions TEXT NOT NULL DEFAULT '{}',
  invited INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);

-- Append-only: (id, version) rows accumulate, same id across versions.
CREATE TABLE IF NOT EXISTS rubrics (
  id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
  prompt TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (id, version));

-- Versioning choice (documented): eval_cases moved from "PK id" to the
-- SAME append-only shape rubrics already use — composite PRIMARY KEY
-- (id, version), latest = MAX(version) — rather than a mutated "latest" row
-- plus a history side-table. One shape for every versioned store keeps the
-- invariant machine-obvious ("versions append-only", cupel-phases.md:160) and
-- GET /eval/cases/{id} "Returns the LATEST version" (openapi.yaml:1442) is one
-- ORDER BY. Pre-existing databases are migrated in Db._migrate_eval_cases
-- below: every existing row becomes version 1, so Phase-1 cases (and the
-- judgments pointing at them) keep working untouched.
CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  prompt TEXT NOT NULL, envelope TEXT,
  output TEXT NOT NULL, reference TEXT, source TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (id, version));

-- Append-only versioned MEMBERSHIP (openapi.yaml:1533-1536: "each save is a
-- new version carrying its full case_ids list"); case_ids is a JSON array.
CREATE TABLE IF NOT EXISTS eval_sets (
  id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
  case_ids TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (id, version));

-- Casebooks (openapi.yaml:3219-3262). A casebook is GLOBAL, not
-- tree-scoped (openapi.yaml:1654-1656), and its items are turn REFERENCES,
-- never copies (openapi.yaml:3252-3255) — hence a row of ids and nothing
-- else. Deleting a casebook or an item touches no turn, conversation, eval
-- set or evaluation (openapi.yaml:1722-1726, :1764-1769).
CREATE TABLE IF NOT EXISTS casebooks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  created_by TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS casebook_items (
  id TEXT PRIMARY KEY, casebook_id TEXT NOT NULL, tree TEXT NOT NULL,
  conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, note TEXT,
  added_at TEXT NOT NULL);

-- "Re-adding the same turn is idempotent (returns the existing item)"
-- (openapi.yaml:1744) — the rule is enforced at the storage layer so no
-- caller can create a second reference to the same turn.
CREATE UNIQUE INDEX IF NOT EXISTS casebook_items_ref
  ON casebook_items (casebook_id, tree, conversation_id, turn_id);

-- Audit trail. "EVERY access is audit-logged server-side"
-- (openapi.yaml:308-309) for GET /admin/conversations. The contract declares
-- NO endpoint that reads this back, so it is deliberately a server-side store
-- only (rows here + one stdout line per query, mock/main.py audit_inspect).
CREATE TABLE IF NOT EXISTS inspect_audit (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT,
  filters TEXT NOT NULL, result_count INTEGER NOT NULL,
  created_at TEXT NOT NULL);

-- Append-only (cupel-phases.md:160); human thumbs share this store.
CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY, case_id TEXT, evaluation_id TEXT, turn_id TEXT,
  conversation_id TEXT, type TEXT NOT NULL, judge_model TEXT,
  rubric_id TEXT, rubric_version INTEGER, score REAL NOT NULL,
  reasoning TEXT, created_at TEXT NOT NULL);
"""


class Db:
    def __init__(self, path: str):
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            # WAL is REQUIRED by CUPEL_STORAGE=s3 — Litestream
            # replicates by shipping WAL frames, and refuses a rollback-journal
            # database. Enabled unconditionally so both modes run the same
            # engine settings and the hosted path is never a special case.
            # ":memory:" silently stays "memory"; that is fine, tests use it.
            # synchronous=NORMAL is the documented WAL+Litestream pairing
            # (durability comes from the replica, not from fsync-per-commit);
            # busy_timeout guards the second connection database_is_empty()
            # opens at boot. The process-wide RLock below still serializes all
            # access, so WAL changes no concurrency assumption in this file.
            self.journal_mode = self.conn.execute(
                "PRAGMA journal_mode=WAL").fetchone()[0]
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.execute("PRAGMA busy_timeout=5000")
            self.conn.executescript(SCHEMA)
            self._migrate_eval_cases()
            self._migrate_conversation_owner()
            self._migrate_run_to_evaluation()
            self.conn.commit()

    def _migrate_eval_cases(self):
        """Older databases carry eval_cases with PRIMARY KEY (id)
        and no version column; CREATE TABLE IF NOT EXISTS above is a no-op for
        them. SQLite cannot change a primary key in place, so rebuild once and
        stamp every existing row as version 1 — Phase-1 cases stay readable and
        the judgments referencing them are untouched (they key on case id, not
        on this table). Idempotent: the column's presence is the marker."""
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(eval_cases)")}
        if not cols or "version" in cols:
            return
        self.conn.executescript(
            "ALTER TABLE eval_cases RENAME TO eval_cases_pre_t12;"
            " CREATE TABLE eval_cases ("
            "   id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,"
            "   prompt TEXT NOT NULL, envelope TEXT,"
            "   output TEXT NOT NULL, reference TEXT, source TEXT,"
            "   created_at TEXT NOT NULL, PRIMARY KEY (id, version));"
            " INSERT INTO eval_cases"
            "   (id, version, prompt, envelope, output, reference, source, created_at)"
            "   SELECT id, 1, prompt, envelope, output, reference, source, created_at"
            "   FROM eval_cases_pre_t12;"
            " DROP TABLE eval_cases_pre_t12;")

    def _migrate_conversation_owner(self):
        """Older databases carry conversations without user_id,
        and CREATE TABLE IF NOT EXISTS above is a no-op for them. Adding a
        column IS possible in place, so this is one ALTER plus a backfill.

        Backfill rule (documented, same rule new rows use — see
        mock/main.py conversation_owner): the owner is the author of the
        conversation's FIRST user turn, which is what the generator varies
        across personas (mock/generator.py:43 PERSONAS) and what interactive
        chat leaves as "user". Idempotent: the column's presence is the
        marker."""
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(conversations)")}
        if not cols or "user_id" in cols:
            return
        self.conn.execute("ALTER TABLE conversations ADD COLUMN user_id TEXT")
        self.conn.execute(
            "UPDATE conversations SET user_id = COALESCE("
            " (SELECT t.author FROM turns t WHERE t.conversation_id = conversations.id"
            "  AND t.role = 'user' ORDER BY t.rowid LIMIT 1), 'dev')")

    def _migrate_run_to_evaluation(self):
        """Older databases carry the pre-rename physical names: tables runs /
        run_rows / run_cells, and a run_id column on those two plus judgments.
        The wire renamed Run to Evaluation, and the physical schema follows so
        this file stays a truthful reference for anyone reading it.

        CREATE TABLE IF NOT EXISTS above has already created the NEW, empty
        tables on such a database, so each old table's data is moved by
        dropping the empty newcomer and renaming the old one over it.
        Idempotent: the presence of the OLD table (and of the old column) is
        the marker, exactly as the two migrations above use a column's
        presence. Nothing here runs on a database created after the rename."""
        tables = {r[0] for r in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        for old, new in (("runs", "evaluations"),
                         ("run_rows", "evaluation_rows"),
                         ("run_cells", "evaluation_cells")):
            if old not in tables:
                continue
            if new in tables:
                self.conn.execute(f"DROP TABLE {new}")
            self.conn.execute(f"ALTER TABLE {old} RENAME TO {new}")
        for table in ("evaluation_rows", "evaluation_cells", "judgments"):
            cols = {r[1] for r in self.conn.execute(f"PRAGMA table_info({table})")}
            if "run_id" in cols and "evaluation_id" not in cols:
                self.conn.execute(
                    f"ALTER TABLE {table} RENAME COLUMN run_id TO evaluation_id")

    def run(self, sql: str, params=()) -> sqlite3.Cursor:
        with self.lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
            return cur

    def one(self, sql: str, params=()) -> dict | None:
        with self.lock:
            row = self.conn.execute(sql, params).fetchone()
        return dict(row) if row else None

    def all(self, sql: str, params=()) -> list[dict]:
        with self.lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]


def j(value) -> str | None:
    return None if value is None else json.dumps(value)


def unj(text, default=None):
    return default if text is None else json.loads(text)
