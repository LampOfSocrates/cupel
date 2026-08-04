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

-- Append-only (loom-phases.md:160); live version = MAX(version).
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
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL, title TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'interactive', channel TEXT, agent_id TEXT,
  created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, lineage TEXT);

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

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, tree_id TEXT NOT NULL, task_id TEXT NOT NULL,
  label TEXT, created_at TEXT NOT NULL, columns TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS run_rows (
  run_id TEXT NOT NULL, row_idx INTEGER NOT NULL,
  conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  prompt TEXT NOT NULL, envelope TEXT,
  PRIMARY KEY (run_id, row_idx));

CREATE TABLE IF NOT EXISTS run_cells (
  run_id TEXT NOT NULL, row_idx INTEGER NOT NULL, col_idx INTEGER NOT NULL,
  status TEXT NOT NULL, content TEXT, conversation_id TEXT, turn_id TEXT,
  task_id TEXT, case_id TEXT, latest_score REAL, error TEXT,
  PRIMARY KEY (run_id, row_idx, col_idx));

-- payload_ref = span id; prompt/response/args/result back GET /spans/{id}/payload.
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, parent_id TEXT,
  type TEXT NOT NULL, name TEXT NOT NULL,
  start_ts TEXT NOT NULL, end_ts TEXT,
  tokens_in INTEGER, tokens_out INTEGER, cost REAL, model TEXT,
  status TEXT NOT NULL, error TEXT,
  prompt TEXT, response TEXT, args TEXT, result TEXT);

-- Append-only: (id, version) rows accumulate, same id across versions.
CREATE TABLE IF NOT EXISTS rubrics (
  id TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL,
  prompt TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (id, version));

CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT PRIMARY KEY, prompt TEXT NOT NULL, envelope TEXT,
  output TEXT NOT NULL, reference TEXT, source TEXT, created_at TEXT NOT NULL);

-- Append-only (loom-phases.md:160); human thumbs share this store.
CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY, case_id TEXT, run_id TEXT, turn_id TEXT,
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
            self.conn.executescript(SCHEMA)
            self.conn.commit()

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
