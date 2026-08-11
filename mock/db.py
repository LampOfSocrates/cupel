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

-- NOTE THE ABSENT COLUMN: there is no `status` here and there never has been
-- (checked across this file's whole history, including its pre-rename `runs`
-- shape). openapi.yaml Evaluation.status is DERIVED from the owning task —
-- see mock/engine.py evaluation_status for the resolution, including how a
-- partially-failed batch and a pruned task read. tasks.status is the single
-- writer of execution state; storing a second copy here is what would let the
-- two disagree, so the column stays absent deliberately rather than by
-- oversight.
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

-- Eval sets, the noun Casebook merged into (openapi.yaml EvalSet). TWO tables,
-- because the resource has two lifetimes and saying so here is cheaper than a
-- comment: the SET is mutable metadata (a rename is not a membership change,
-- openapi.yaml PATCH /eval/sets/{setId}), the MEMBERSHIP is append-only
-- ("each save is a new version carrying its FULL item list"). Splitting them
-- is what lets a rename leave every recorded version untouched, so the
-- append-only invariant (cupel-phases.md:160) needs no exception for metadata.
--
-- A set is GLOBAL, not tree-scoped: its reference items may point at turns
-- across trees, and per-item visibility follows the viewer's permissions.
-- items is a JSON array of {id, kind, source?, case_id?, note, added_at} —
-- reference items are turn REFERENCES, never copies, so nothing here holds a
-- turn's text. Deleting a set touches no turn, conversation, case, judgment or
-- evaluation.
CREATE TABLE IF NOT EXISTS eval_sets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  created_by TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS eval_set_versions (
  set_id TEXT NOT NULL, version INTEGER NOT NULL, items TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (set_id, version));

-- Audit trail. "EVERY access is audit-logged server-side"
-- (openapi.yaml:308-309) for GET /admin/conversations. The contract declares
-- NO endpoint that reads this back, so it is deliberately a server-side store
-- only (rows here + one stdout line per query, mock/main.py audit_inspect).
CREATE TABLE IF NOT EXISTS inspect_audit (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT,
  filters TEXT NOT NULL, result_count INTEGER NOT NULL,
  created_at TEXT NOT NULL);

-- Append-only (cupel-phases.md:160); human thumbs share this store.
--
-- One row = one score, addressed by a SUBJECT (what was judged) and a SCORER
-- (what produced the score) — openapi.yaml JudgmentSubject / Scorer. That pair
-- replaced four mutually exclusive nullable foreign keys (case_id, run_id,
-- turn_id, conversation_id) plus a `type` enum, which made the table a union
-- with no discriminator: a thumb was the turn_id rows, an LLM score the
-- case_id rows, and nothing in the schema said so.
--
-- evaluation_id is NOT the subject: an LLM judgment of a grid cell judges the
-- CASE, and the evaluation is the batch it was produced in. It stays a
-- separate scope so one case can be scored inside two evaluations without
-- either overwriting the other's cell (mock/engine.py _run_judge_case).
--
-- conversation_id is the one denormalization here and is deliberately NOT a
-- wire field: it exists so GET /eval/judgments?conversation_id= and the
-- Inspector's latest-score filter stay single queries rather than joins
-- through turns and eval-case sources. It is a scope index, never a subject.
CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
  scorer_kind TEXT NOT NULL, scorer_ref TEXT, scorer_version INTEGER,
  scorer_model TEXT,
  evaluation_id TEXT, conversation_id TEXT,
  score REAL NOT NULL, reasoning TEXT, created_at TEXT NOT NULL);
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
            # SQLite's built-in lower() folds ASCII ONLY, so a title holding
            # "ÜBER" stayed "ÜBER" while the search term was lowered in
            # Python — which made every non-ASCII conversation unsearchable.
            # The contract says ?search= is case-insensitive full stop
            # (openapi.yaml listConversations), so both sides fold through the
            # same Python rule.
            self.conn.create_function("ci_lower", 1,
                                      lambda v: v.lower() if isinstance(v, str) else v,
                                      deterministic=True)
            self.conn.executescript(SCHEMA)
            from .migrations import run_migrations
            run_migrations(self)

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
