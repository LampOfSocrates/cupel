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

-- Append-only (invariant); live version = MAX(version).
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
-- invariant machine-obvious ("versions append-only") and
-- GET /eval/cases/{id} "Returns the LATEST version" (openapi.yaml:1442) is one
-- ORDER BY. Pre-existing databases are migrated in Db._migrate_eval_cases
-- below: every existing row becomes version 1, so Phase-1 cases (and the
-- judgments pointing at them) keep working untouched.
-- agenttree: free-form label naming the agent tree/endpoint this case
-- evaluates (openapi.yaml EvalCase.agenttree). Required on every case going
-- forward; older rows are backfilled by Db._migrate_eval_cases_agenttree
-- below (from source.tree where sourced, a visible placeholder otherwise).
CREATE TABLE IF NOT EXISTS eval_cases (
  id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  prompt TEXT NOT NULL, envelope TEXT,
  output TEXT NOT NULL, reference TEXT, source TEXT, created_at TEXT NOT NULL,
  agenttree TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (id, version));

-- Eval benchmarks, the noun Casebook merged into (openapi.yaml EvalBenchmark
-- — named EvalSet before the rename to a benchmark-flavored noun). TWO
-- tables, because the resource has two lifetimes and saying so here is
-- cheaper than a comment: the BENCHMARK is mutable metadata (a rename is not
-- a membership change, openapi.yaml PATCH /eval/benchmarks/{benchmarkId}),
-- the MEMBERSHIP is append-only ("each save is a new version carrying its
-- FULL item list"). Splitting them is what lets a rename leave every
-- recorded version untouched, so the append-only invariant
-- needs no exception for metadata.
--
-- A benchmark is GLOBAL, not tree-scoped: its reference items may point at
-- turns across trees, and per-item visibility follows the viewer's
-- permissions. items is a JSON array of {id, kind, source?, case_id?, note,
-- added_at} — reference items are turn REFERENCES, never copies, so nothing
-- here holds a turn's text. Deleting a benchmark touches no turn,
-- conversation, case, judgment or evaluation.
CREATE TABLE IF NOT EXISTS eval_benchmarks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  created_by TEXT, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS eval_benchmark_versions (
  benchmark_id TEXT NOT NULL, version INTEGER NOT NULL, items TEXT NOT NULL,
  created_at TEXT NOT NULL, PRIMARY KEY (benchmark_id, version));

-- Audit trail. "EVERY access is audit-logged server-side"
-- (openapi.yaml:308-309) for GET /admin/conversations. The contract declares
-- NO endpoint that reads this back, so it is deliberately a server-side store
-- only (rows here + one stdout line per query, mock/main.py audit_inspect).
CREATE TABLE IF NOT EXISTS inspect_audit (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, email TEXT,
  filters TEXT NOT NULL, result_count INTEGER NOT NULL,
  created_at TEXT NOT NULL);

-- Append-only (invariant); human thumbs share this store.
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
            self._migrate_eval_cases()
            self._migrate_eval_cases_agenttree()
            self._migrate_conversation_owner()
            self._migrate_run_to_evaluation()
            self._migrate_casebooks_into_eval_benchmarks()
            self._migrate_eval_sets_into_eval_benchmarks()
            self._migrate_judgment_subject_scorer()
            self._create_indexes()
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

    def _migrate_eval_cases_agenttree(self):
        """Older databases carry eval_cases with no agenttree column
        (openapi.yaml EvalCase.agenttree, added after v0.4.0 — every case now
        names the agent tree/endpoint it evaluates). Backfilled from
        source.tree for sourced cases, since that is the tree the case was
        actually pulled from; a handcrafted case with no source has no tree to
        recover, so it gets a visible placeholder rather than a silent guess.
        Idempotent: the column's presence is the marker."""
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(eval_cases)")}
        if not cols or "agenttree" in cols:
            return
        self.conn.execute("ALTER TABLE eval_cases ADD COLUMN agenttree TEXT NOT NULL DEFAULT ''")
        self.conn.execute(
            "UPDATE eval_cases SET agenttree ="
            " COALESCE(NULLIF(json_extract(source, '$.tree'), ''), '(unmigrated)')")

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

    def _migrate_casebooks_into_eval_benchmarks(self):
        """Casebook and EvalBenchmark (named EvalSet before the later
        benchmark-flavored rename) merged into one noun, so their two
        physical shapes merge too. Older databases carry
        eval_sets(id, name, version, case_ids, created_at) plus casebooks /
        casebook_items; the current shape is
        eval_benchmarks(id, name, description, created_by, created_at) +
        eval_benchmark_versions(benchmark_id, version, items) — this
        migration writes directly into the current names, so a database this
        old upgrades in one hop rather than passing through the intermediate
        eval_sets/eval_set_versions shape (that shape's own rename, for
        databases that DO carry it, is _migrate_eval_sets_into_eval_benchmarks
        below).

        Two independent, presence-guarded halves, in the style of the
        migrations above:
          1. an eval_sets table still has a case_ids column -> turn each old
             version row into an eval_benchmark_versions row whose items are
             FROZEN (they were case ids, and a case id is exactly a frozen
             item's referent).
          2. a casebooks table exists -> each casebook becomes a benchmark
             whose version 1 holds its items as REFERENCES, keeping their
             ids, notes and added_at. The casebook keeps its own id: ids are
             opaque, and rewriting them would break every judgment, link and
             bookmark that already names one.
        Nothing here runs on a database created after the merge."""
        tables = {r[0] for r in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        if "eval_sets" in tables:
            cols = {r[1] for r in self.conn.execute("PRAGMA table_info(eval_sets)")}
            if "case_ids" in cols:
                rows = self.conn.execute(
                    "SELECT id, name, version, case_ids, created_at"
                    " FROM eval_sets ORDER BY id, version").fetchall()
                first: dict[str, tuple] = {}
                latest_name: dict[str, str] = {}
                for row in rows:
                    first.setdefault(row["id"], (row["created_at"],))
                    latest_name[row["id"]] = row["name"]
                    items = [{"id": f"esi_{row['id']}_{i}", "kind": "frozen",
                              "source": None, "case_id": case_id, "note": None,
                              "added_at": row["created_at"]}
                             for i, case_id in enumerate(json.loads(row["case_ids"] or "[]"))]
                    self.conn.execute(
                        "INSERT INTO eval_benchmark_versions (benchmark_id, version, items, created_at)"
                        " VALUES (?, ?, ?, ?)",
                        (row["id"], row["version"], json.dumps(items), row["created_at"]))
                for benchmark_id, (created_at,) in first.items():
                    self.conn.execute(
                        "INSERT INTO eval_benchmarks (id, name, description, created_by, created_at)"
                        " VALUES (?, ?, NULL, NULL, ?)",
                        (benchmark_id, latest_name[benchmark_id], created_at))
                self.conn.execute("DROP TABLE eval_sets")
                if "eval_set_versions" in tables:
                    self.conn.execute("DROP TABLE eval_set_versions")

        tables = {r[0] for r in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        if "casebooks" not in tables:
            return
        for book in self.conn.execute(
                "SELECT * FROM casebooks ORDER BY rowid").fetchall():
            items = [{"id": i["id"], "kind": "reference",
                      "source": {"tree": i["tree"],
                                 "conversation_id": i["conversation_id"],
                                 "turn_id": i["turn_id"]},
                      "case_id": None, "note": i["note"],
                      "added_at": i["added_at"]}
                     for i in self.conn.execute(
                         "SELECT * FROM casebook_items WHERE casebook_id = ?"
                         " ORDER BY rowid", (book["id"],)).fetchall()]
            self.conn.execute(
                "INSERT OR REPLACE INTO eval_benchmarks"
                " (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
                (book["id"], book["name"], book["description"],
                 book["created_by"], book["created_at"]))
            self.conn.execute(
                "INSERT OR REPLACE INTO eval_benchmark_versions"
                " (benchmark_id, version, items, created_at) VALUES (?, 1, ?, ?)",
                (book["id"], json.dumps(items), book["created_at"]))
        self.conn.executescript(
            "DROP TABLE IF EXISTS casebook_items; DROP TABLE IF EXISTS casebooks;")

    def _migrate_eval_sets_into_eval_benchmarks(self):
        """Older databases carry the pre-rename physical names eval_sets /
        eval_set_versions(set_id, …) — the intermediate shape the Casebook
        merge produced, before EvalSet itself was later renamed to
        EvalBenchmark. CREATE TABLE IF NOT EXISTS at the top of this file has
        already created empty eval_benchmarks / eval_benchmark_versions
        tables on such a database, so each old table's data is moved by
        dropping the empty newcomer and renaming the old one over it — same
        pattern as _migrate_run_to_evaluation. Idempotent: the presence of the
        OLD table is the marker. Nothing here runs on a database created
        after the rename, and _migrate_casebooks_into_eval_benchmarks above
        already drops eval_sets/eval_set_versions for anything older still, so
        the two migrations never both fire on the same database."""
        tables = {r[0] for r in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        if "eval_sets" not in tables:
            return
        if "eval_benchmarks" in tables:
            self.conn.execute("DROP TABLE eval_benchmarks")
        self.conn.execute("ALTER TABLE eval_sets RENAME TO eval_benchmarks")
        if "eval_set_versions" in tables:
            if "eval_benchmark_versions" in tables:
                self.conn.execute("DROP TABLE eval_benchmark_versions")
            self.conn.execute("ALTER TABLE eval_set_versions RENAME TO eval_benchmark_versions")
            self.conn.execute(
                "ALTER TABLE eval_benchmark_versions RENAME COLUMN set_id TO benchmark_id")

    def _migrate_judgment_subject_scorer(self):
        """Older databases carry the union shape: judgments(case_id,
        evaluation_id, turn_id, conversation_id, type, judge_model, rubric_id,
        rubric_version, …). The wire replaced that with a polymorphic subject
        plus a scorer, and the physical schema follows so this file stays a
        truthful reference.

        SQLite cannot drop four columns and add six in place, so rebuild once,
        in the style of _migrate_eval_cases above. The mapping is total —
        every old row had exactly one of case_id / turn_id set:
          case_id non-null -> subject (case, case_id), the LLM judge path
          otherwise        -> subject (turn, turn_id), a POST /feedback thumb
          type             -> scorer_kind (llm | human, 1:1)
          rubric_id/_version/judge_model -> scorer_ref/_version/_model
        evaluation_id and conversation_id carry over untouched: the first is
        the batch scope, the second the query index documented on the table.

        MUST run after _migrate_run_to_evaluation, which is what renames this
        table's run_id column to evaluation_id. Idempotent: the OLD column's
        presence is the marker, exactly as the migrations above. A row with
        neither id would be unaddressable under the new shape; none can exist
        (both insert paths set one), and the WHERE says so rather than
        silently inventing a subject for one."""
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(judgments)")}
        if "case_id" not in cols:
            return
        self.conn.executescript(
            "ALTER TABLE judgments RENAME TO judgments_pre_t7c;"
            " CREATE TABLE judgments ("
            "   id TEXT PRIMARY KEY,"
            "   subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,"
            "   scorer_kind TEXT NOT NULL, scorer_ref TEXT,"
            "   scorer_version INTEGER, scorer_model TEXT,"
            "   evaluation_id TEXT, conversation_id TEXT,"
            "   score REAL NOT NULL, reasoning TEXT, created_at TEXT NOT NULL);"
            " INSERT INTO judgments (id, subject_kind, subject_id, scorer_kind,"
            "   scorer_ref, scorer_version, scorer_model, evaluation_id,"
            "   conversation_id, score, reasoning, created_at)"
            "   SELECT id,"
            "     CASE WHEN case_id IS NOT NULL THEN 'case' ELSE 'turn' END,"
            "     COALESCE(case_id, turn_id),"
            "     type, rubric_id, rubric_version, judge_model, evaluation_id,"
            "     conversation_id, score, reasoning, created_at"
            "   FROM judgments_pre_t7c"
            "   WHERE COALESCE(case_id, turn_id) IS NOT NULL;"
            " DROP TABLE judgments_pre_t7c;")

    def _create_indexes(self):
        """Create performance indexes for foreign key lookups and frequent query filters.
        Must run at the end of __init__ after all migrations execute so target columns exist."""
        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_turns_conversation_id ON turns(conversation_id)",
            "CREATE INDEX IF NOT EXISTS idx_spans_turn_id ON spans(turn_id)",
            "CREATE INDEX IF NOT EXISTS idx_judgments_evaluation_id ON judgments(evaluation_id)",
            "CREATE INDEX IF NOT EXISTS idx_judgments_conversation_id ON judgments(conversation_id)",
            "CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)",
            "CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id)",
            "CREATE INDEX IF NOT EXISTS idx_evaluation_rows_evaluation_id ON evaluation_rows(evaluation_id)",
            "CREATE INDEX IF NOT EXISTS idx_evaluation_cells_evaluation_id ON evaluation_cells(evaluation_id)",
        ]
        for stmt in indexes:
            self.conn.execute(stmt)

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
