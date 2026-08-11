import json

def run_migrations(db):
    """Runs all database migrations on the provided Db instance sequentially."""
    _migrate_eval_cases(db)
    _migrate_conversation_owner(db)
    _migrate_run_to_evaluation(db)
    _migrate_casebooks_into_eval_sets(db)
    _migrate_judgment_subject_scorer(db)
    db.conn.commit()


def _migrate_eval_cases(db):
    """Older databases carry eval_cases with PRIMARY KEY (id)
    and no version column; CREATE TABLE IF NOT EXISTS above is a no-op for
    them. SQLite cannot change a primary key in place, so rebuild once and
    stamp every existing row as version 1 — Phase-1 cases stay readable and
    the judgments referencing them are untouched (they key on case id, not
    on this table). Idempotent: the column's presence is the marker."""
    cols = {r[1] for r in db.conn.execute("PRAGMA table_info(eval_cases)")}
    if not cols or "version" in cols:
        return
    db.conn.executescript(
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


def _migrate_conversation_owner(db):
    """Older databases carry conversations without user_id,
    and CREATE TABLE IF NOT EXISTS above is a no-op for them. Adding a
    column IS possible in place, so this is one ALTER plus a backfill.

    Backfill rule (documented, same rule new rows use — see
    mock/main.py conversation_owner): the owner is the author of the
    conversation's FIRST user turn, which is what the generator varies
    across personas (mock/generator.py:43 PERSONAS) and what interactive
    chat leaves as "user". Idempotent: the column's presence is the
    marker."""
    cols = {r[1] for r in db.conn.execute("PRAGMA table_info(conversations)")}
    if not cols or "user_id" in cols:
        return
    db.conn.execute("ALTER TABLE conversations ADD COLUMN user_id TEXT")
    db.conn.execute(
        "UPDATE conversations SET user_id = COALESCE("
        " (SELECT t.author FROM turns t WHERE t.conversation_id = conversations.id"
        "  AND t.role = 'user' ORDER BY t.rowid LIMIT 1), 'dev')")


def _migrate_run_to_evaluation(db):
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
    tables = {r[0] for r in db.conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'")}
    for old, new in (("runs", "evaluations"),
                     ("run_rows", "evaluation_rows"),
                     ("run_cells", "evaluation_cells")):
        if old not in tables:
            continue
        if new in tables:
            db.conn.execute(f"DROP TABLE {new}")
        db.conn.execute(f"ALTER TABLE {old} RENAME TO {new}")
    for table in ("evaluation_rows", "evaluation_cells", "judgments"):
        cols = {r[1] for r in db.conn.execute(f"PRAGMA table_info({table})")}
        if "run_id" in cols and "evaluation_id" not in cols:
            db.conn.execute(
                f"ALTER TABLE {table} RENAME COLUMN run_id TO evaluation_id")


def _migrate_casebooks_into_eval_sets(db):
    """Casebook and EvalSet merged into one noun, so their two physical
    shapes merge too. Older databases carry
    eval_sets(id, name, version, case_ids, created_at) plus casebooks /
    casebook_items; the new shape is eval_sets(id, name, description,
    created_by, created_at) + eval_set_versions(set_id, version, items).

    Two independent, presence-guarded halves, in the style of the three
    migrations above:
      1. eval_sets still has a case_ids column -> rebuild it and turn each
         old version row into an eval_set_versions row whose items are
         FROZEN (they were case ids, and a case id is exactly a frozen
         item's referent). CREATE TABLE IF NOT EXISTS at the top of this
         file is a no-op against the old table, which is what leaves the
         marker column visible here.
      2. a casebooks table exists -> each casebook becomes a set whose
         version 1 holds its items as REFERENCES, keeping their ids,
         notes and added_at. The casebook keeps its own id: ids are
         opaque, and rewriting them would break every judgment, link and
         bookmark that already names one.
    Nothing here runs on a database created after the merge."""
    cols = {r[1] for r in db.conn.execute("PRAGMA table_info(eval_sets)")}
    if "case_ids" in cols:
        db.conn.execute("ALTER TABLE eval_sets RENAME TO eval_sets_pre_t7b")
        db.conn.execute(
            "CREATE TABLE eval_sets ("
            " id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,"
            " created_by TEXT, created_at TEXT NOT NULL)")
        rows = db.conn.execute(
            "SELECT id, name, version, case_ids, created_at"
            " FROM eval_sets_pre_t7b ORDER BY id, version").fetchall()
        first: dict[str, tuple] = {}
        latest_name: dict[str, str] = {}
        for row in rows:
            first.setdefault(row["id"], (row["created_at"],))
            latest_name[row["id"]] = row["name"]
            items = [{"id": f"esi_{row['id']}_{i}", "kind": "frozen",
                      "source": None, "case_id": case_id, "note": None,
                      "added_at": row["created_at"]}
                     for i, case_id in enumerate(json.loads(row["case_ids"] or "[]"))]
            db.conn.execute(
                "INSERT INTO eval_set_versions (set_id, version, items, created_at)"
                " VALUES (?, ?, ?, ?)",
                (row["id"], row["version"], json.dumps(items), row["created_at"]))
        for set_id, (created_at,) in first.items():
            db.conn.execute(
                "INSERT INTO eval_sets (id, name, description, created_by, created_at)"
                " VALUES (?, ?, NULL, NULL, ?)",
                (set_id, latest_name[set_id], created_at))
        db.conn.execute("DROP TABLE eval_sets_pre_t7b")

    tables = {r[0] for r in db.conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "casebooks" not in tables:
        return
    for book in db.conn.execute(
            "SELECT * FROM casebooks ORDER BY rowid").fetchall():
        items = [{"id": i["id"], "kind": "reference",
                  "source": {"tree": i["tree"],
                             "conversation_id": i["conversation_id"],
                             "turn_id": i["turn_id"]},
                  "case_id": None, "note": i["note"],
                  "added_at": i["added_at"]}
                 for i in db.conn.execute(
                     "SELECT * FROM casebook_items WHERE casebook_id = ?"
                     " ORDER BY rowid", (book["id"],)).fetchall()]
        db.conn.execute(
            "INSERT OR REPLACE INTO eval_sets"
            " (id, name, description, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
            (book["id"], book["name"], book["description"],
             book["created_by"], book["created_at"]))
        db.conn.execute(
            "INSERT OR REPLACE INTO eval_set_versions"
            " (set_id, version, items, created_at) VALUES (?, 1, ?, ?)",
            (book["id"], json.dumps(items), book["created_at"]))
    db.conn.executescript(
        "DROP TABLE IF EXISTS casebook_items; DROP TABLE IF EXISTS casebooks;")


def _migrate_judgment_subject_scorer(db):
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
    cols = {r[1] for r in db.conn.execute("PRAGMA table_info(judgments)")}
    if "case_id" not in cols:
        return
    db.conn.executescript(
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
