"""P2-T12 eval workbench — the mock half of contract v0.3.0's eval surface:
POST /eval/cases, GET+PUT /eval/cases/{caseId}, POST /eval/cases/import,
GET+POST /eval/sets, PUT /eval/sets/{setId}, PUT /eval/rubrics/{rubricId},
and JudgeRequest.set_id (+ set_version).

Run: npm run test:mock.

The append-only rules under test (invariant cupel-phases.md:160):
- "each save appends the next version, never overwrites. Prior versions stay
  readable and existing judgments keep pointing at the content they actually
  judged" (openapi.yaml:1459-1466)
- "each save is a new version carrying its full case_ids list; earlier
  versions remain queryable" (openapi.yaml:1533-1536)
- "Failed rows never abort the import; valid rows land" (openapi.yaml:1391)
"""

import asyncio
import io
import json
import sqlite3
import zipfile

import pytest

from mock.config import IMPORT_SYNC_MAX_ROWS
from mock.db import Db
from mock.tests.test_mock import client_pair, run, seed_conversation, wait_task

CSV_HEADER = "question,answer,expected\n"


def csv_bytes(*rows: str) -> bytes:
    return (CSV_HEADER + "".join(rows)).encode("utf-8")


MAPPING = json.dumps({"input": "question", "output": "answer", "reference": "expected"})


def upload(data: bytes, mapping: str = MAPPING, filename: str = "cases.csv", **fields):
    files = {"file": (filename, data, "text/csv")}
    return {"files": files, "data": {"mapping": mapping, **fields}}


async def make_case(c, prompt="Why was I charged twice?", output="A hold, not a charge.",
                    reference=None):
    r = await c.post("/eval/cases", json={
        "input": {"prompt": prompt}, "output": output, "reference": reference})
    assert r.status_code == 201, r.text
    return r.json()


async def make_rubric(c, name="match-reference", prompt="Score against the reference."):
    r = await c.post("/eval/rubrics", json={"name": name, "prompt": prompt})
    assert r.status_code == 201, r.text
    return r.json()


# ------------------------------------------------------------------- cases
def test_create_case_handcrafted_and_read_back():
    async def case():
        async with client_pair() as c:
            created = await make_case(c, reference="One charge; the hold drops in 3 days.")
            assert created["version"] == 1
            assert created["input"]["prompt"] == "Why was I charged twice?"
            assert created["reference"] == "One charge; the hold drops in 3 days."
            assert created["source"] is None
            got = (await c.get(f"/eval/cases/{created['id']}")).json()
            assert got == created
    run(case())


def test_create_case_requires_exactly_one_mode():
    """openapi.yaml:3328-3330 oneOf: (input + output) XOR source."""
    async def case():
        async with client_pair() as c:
            assert (await c.post("/eval/cases", json={})).status_code == 422
            both = await c.post("/eval/cases", json={
                "input": {"prompt": "p"}, "output": "o",
                "source": {"tree": "agent1", "conversation_id": "c", "turn_id": "t"}})
            assert both.status_code == 422
            # handcrafted mode still validates its own fields
            assert (await c.post("/eval/cases",
                                 json={"input": {"prompt": "  "}, "output": "o"})).status_code == 422
            assert (await c.post("/eval/cases",
                                 json={"input": {"prompt": "p"}})).status_code == 422
    run(case())


def test_create_case_sourced_from_a_real_turn():
    """"sourced = the server derives input (the turn's prompt + envelope) and
    output (its response)" (openapi.yaml:3322-3326) — the workbench's "pull
    from a real turn" (cupel-phases.md:80)."""
    async def case():
        async with client_pair() as c:
            conv_id = await seed_conversation(c, n=1)
            conv = (await c.get(f"/agenttrees/agent1/conversations/{conv_id}")).json()
            user_turn = next(t for t in conv["turns"] if t["role"] == "user")
            answer = next(t for t in conv["turns"] if t["role"] == "assistant")

            r = await c.post("/eval/cases", json={"source": {
                "tree": "agent1", "conversation_id": conv_id, "turn_id": answer["id"]}})
            assert r.status_code == 201, r.text
            created = r.json()
            assert created["input"]["prompt"] == user_turn["content"]
            assert created["output"] == answer["content"]
            assert created["source"] == {"tree": "agent1", "conversation_id": conv_id,
                                         "turn_id": answer["id"]}
            assert created["version"] == 1

            # Referencing the user half of the same invocation resolves to the
            # same pair (a turn row is one message, db.py:53).
            from_user = (await c.post("/eval/cases", json={"source": {
                "tree": "agent1", "conversation_id": conv_id,
                "turn_id": user_turn["id"]}})).json()
            assert from_user["output"] == answer["content"]

            missing = await c.post("/eval/cases", json={"source": {
                "tree": "agent1", "conversation_id": conv_id, "turn_id": "nope"}})
            assert missing.status_code == 404
            bad_tree = await c.post("/eval/cases", json={"source": {
                "tree": "ghost", "conversation_id": conv_id, "turn_id": answer["id"]}})
            assert bad_tree.status_code == 404
    run(case())


def test_case_put_appends_versions_and_get_returns_latest():
    async def case():
        async with client_pair() as c:
            created = await make_case(c)
            v2 = await c.put(f"/eval/cases/{created['id']}", json={
                "input": {"prompt": "Why was I charged twice?"},
                "output": "A temporary authorisation hold.", "reference": "Not a double charge."})
            assert v2.status_code == 201, v2.text
            assert v2.json()["version"] == 2
            v3 = (await c.put(f"/eval/cases/{created['id']}", json={
                "input": {"prompt": "Why two charges?"}, "output": "Third take."})).json()
            assert v3["version"] == 3
            assert v3["id"] == created["id"]

            latest = (await c.get(f"/eval/cases/{created['id']}")).json()
            assert latest["version"] == 3 and latest["output"] == "Third take."
            # Rollback = PUT the old content again -> yet another version
            # (openapi.yaml:1465-1466), never a mutation of v1.
            rolled = (await c.put(f"/eval/cases/{created['id']}", json={
                "input": created["input"], "output": created["output"]})).json()
            assert rolled["version"] == 4 and rolled["output"] == created["output"]
    run(case())


def test_case_put_validation_and_missing_case():
    async def case():
        async with client_pair() as c:
            created = await make_case(c)
            assert (await c.put("/eval/cases/nope",
                                json={"input": {"prompt": "p"}, "output": "o"})).status_code == 404
            assert (await c.put(f"/eval/cases/{created['id']}",
                                json={"output": "o"})).status_code == 422
            assert (await c.put(f"/eval/cases/{created['id']}",
                                json={"input": {"prompt": "p"}})).status_code == 422
    run(case())


def test_versioned_case_keeps_phase1_rows_valid(tmp_path):
    """The (id, version) migration (db.py Db._migrate_eval_cases): a database
    written before P2-T12 opens fine and its rows read back as version 1."""
    path = str(tmp_path / "old.sqlite")
    conn = sqlite3.connect(path)
    conn.executescript(
        "CREATE TABLE eval_cases (id TEXT PRIMARY KEY, prompt TEXT NOT NULL,"
        " envelope TEXT, output TEXT NOT NULL, reference TEXT, source TEXT,"
        " created_at TEXT NOT NULL);"
        " INSERT INTO eval_cases VALUES ('case_old', 'old prompt', NULL,"
        " 'old output', NULL, NULL, '2026-01-01T00:00:00Z');")
    conn.commit()
    conn.close()

    db = Db(path)
    try:
        cols = {r[1] for r in db.conn.execute("PRAGMA table_info(eval_cases)")}
        assert "version" in cols
        row = db.one("SELECT * FROM eval_cases WHERE id = 'case_old'")
        assert row["version"] == 1 and row["output"] == "old output"
    finally:
        db.conn.close()
    # Idempotent: reopening the same file does not re-run the rebuild.
    again = Db(path)
    try:
        assert again.all("SELECT * FROM eval_cases")[0]["version"] == 1
    finally:
        again.conn.close()


# -------------------------------------------------------------------- sets
def test_set_create_list_and_versioned_membership():
    async def case():
        async with client_pair() as c:
            a, b, d = [await make_case(c, prompt=f"q{i}") for i in range(3)]
            created = await c.post("/eval/sets", json={"name": "refund-fails",
                                                       "case_ids": [a["id"], b["id"]]})
            assert created.status_code == 201, created.text
            s1 = created.json()
            assert s1["version"] == 1 and s1["case_ids"] == [a["id"], b["id"]]

            s2 = await c.put(f"/eval/sets/{s1['id']}",
                             json={"case_ids": [a["id"], b["id"], d["id"]]})
            assert s2.status_code == 201, s2.text
            assert s2.json()["version"] == 2 and len(s2.json()["case_ids"]) == 3
            # Rename travels into the new version (openapi.yaml:3438-3442).
            s3 = (await c.put(f"/eval/sets/{s1['id']}",
                              json={"case_ids": [d["id"]], "name": "refund-fails-lite"})).json()
            assert s3["version"] == 3 and s3["name"] == "refund-fails-lite"

            listed = (await c.get("/eval/sets")).json()
            assert [s["id"] for s in listed] == [s1["id"]]  # latest version each
            assert listed[0]["version"] == 3 and listed[0]["case_ids"] == [d["id"]]
    run(case())


def test_set_validation():
    async def case():
        async with client_pair() as c:
            a = await make_case(c)
            assert (await c.post("/eval/sets", json={})).status_code == 422
            assert (await c.post("/eval/sets",
                                 json={"name": "s", "case_ids": ["ghost"]})).status_code == 404
            s = (await c.post("/eval/sets", json={"name": "s"})).json()
            assert s["case_ids"] == []  # "empty/omitted = start empty"
            assert (await c.put(f"/eval/sets/{s['id']}", json={})).status_code == 422
            assert (await c.put("/eval/sets/ghost",
                                json={"case_ids": [a["id"]]})).status_code == 404
    run(case())


# ----------------------------------------------------------------- rubrics
def test_rubric_put_appends_a_new_version():
    async def case():
        async with client_pair() as c:
            v1 = await make_rubric(c)
            v2 = await c.put(f"/eval/rubrics/{v1['id']}", json={"prompt": "Stricter wording."})
            assert v2.status_code == 201, v2.text
            assert v2.json() == {**v1, "version": 2, "prompt": "Stricter wording.",
                                 "created_at": v2.json()["created_at"]}
            latest = (await c.get("/eval/rubrics")).json()
            mine = [r for r in latest if r["id"] == v1["id"]]
            assert len(mine) == 1 and mine[0]["version"] == 2

            assert (await c.put("/eval/rubrics/ghost",
                                json={"prompt": "x"})).status_code == 404
            assert (await c.put(f"/eval/rubrics/{v1['id']}", json={})).status_code == 422
    run(case())


# ------------------------------------------------------------ judge by set
def test_judge_by_set_id_fans_out_over_membership():
    async def case():
        async with client_pair() as c:
            cases = [await make_case(c, prompt=f"q{i}", output=f"a{i}") for i in range(3)]
            rubric = await make_rubric(c)
            s1 = (await c.post("/eval/sets", json={
                "name": "set-a", "case_ids": [c_["id"] for c_ in cases[:2]]})).json()
            # v2 adds the third case; judging without set_version uses LATEST.
            (await c.put(f"/eval/sets/{s1['id']}",
                         json={"case_ids": [c_["id"] for c_ in cases]}))

            r = await c.post("/eval/judge", json={
                "set_id": s1["id"], "judge_model": "claude-haiku-4-5",
                "rubric_id": rubric["id"]})
            assert r.status_code == 202, r.text
            task = await wait_task(c, r.json()["task_id"])
            assert task["status"] == "done"
            detail = (await c.get(f"/tasks/{task['id']}")).json()
            assert len(detail["children"]) == 3

            for c_ in cases:
                judgments = (await c.get("/eval/judgments",
                                         params={"case_id": c_["id"]})).json()
                assert len(judgments) == 1
                assert judgments[0]["rubric_id"] == rubric["id"]
                assert judgments[0]["rubric_version"] == rubric["version"]
                assert judgments[0]["type"] == "llm"
    run(case())


def test_judge_by_set_version_pins_the_older_membership():
    async def case():
        async with client_pair() as c:
            cases = [await make_case(c, prompt=f"q{i}") for i in range(3)]
            rubric = await make_rubric(c)
            s1 = (await c.post("/eval/sets", json={
                "name": "pinned", "case_ids": [cases[0]["id"]]})).json()
            (await c.put(f"/eval/sets/{s1['id']}",
                         json={"case_ids": [c_["id"] for c_ in cases]}))

            r = await c.post("/eval/judge", json={
                "set_id": s1["id"], "set_version": 1,
                "judge_model": "claude-haiku-4-5", "rubric_id": rubric["id"]})
            task = await wait_task(c, r.json()["task_id"])
            detail = (await c.get(f"/tasks/{task['id']}")).json()
            assert len(detail["children"]) == 1
            assert (await c.get("/eval/judgments", params={"case_id": cases[2]["id"]})).json() == []

            missing = await c.post("/eval/judge", json={
                "set_id": s1["id"], "set_version": 9,
                "judge_model": "claude-haiku-4-5", "rubric_id": rubric["id"]})
            assert missing.status_code == 404
    run(case())


def test_judge_selector_is_exactly_one():
    async def case():
        async with client_pair() as c:
            a = await make_case(c)
            rubric = await make_rubric(c)
            base = {"judge_model": "claude-haiku-4-5", "rubric_id": rubric["id"]}
            assert (await c.post("/eval/judge", json=base)).status_code == 422
            two = await c.post("/eval/judge", json={**base, "set_id": "s", "case_ids": [a["id"]]})
            assert two.status_code == 422
            assert (await c.post("/eval/judge",
                                 json={**base, "set_id": "ghost"})).status_code == 404
            empty = (await c.post("/eval/sets", json={"name": "empty"})).json()
            no_cases = await c.post("/eval/judge", json={**base, "set_id": empty["id"]})
            assert no_cases.status_code == 422
    run(case())


# ------------------------------------------------------------------ import
def test_import_csv_creates_cases_and_a_named_set():
    async def case():
        async with client_pair() as c:
            data = csv_bytes("Why two charges?,A hold.,Not a double charge.\n",
                             "Where is my refund?,In 3 days.,\n")
            r = await c.post("/eval/cases/import",
                             **upload(data, set_name="imported"))
            assert r.status_code == 200, r.text
            report = r.json()
            assert report["rows_total"] == 2 and report["rows_imported"] == 2
            assert report["errors"] == []
            assert len(report["created_case_ids"]) == 2

            first = (await c.get(f"/eval/cases/{report['created_case_ids'][0]}")).json()
            assert first["input"]["prompt"] == "Why two charges?"
            assert first["output"] == "A hold." and first["reference"] == "Not a double charge."
            assert first["version"] == 1
            second = (await c.get(f"/eval/cases/{report['created_case_ids'][1]}")).json()
            assert second["reference"] is None  # blank cell -> nullable reference

            sets = (await c.get("/eval/sets")).json()
            assert [s["id"] for s in sets] == [report["set_id"]]
            assert sets[0]["name"] == "imported"
            assert sets[0]["case_ids"] == report["created_case_ids"]
    run(case())


def test_import_reports_bad_rows_per_line_and_still_lands_the_good_ones():
    """"row errors reported per line, not all-or-nothing" (feature-spec.md:63)."""
    async def case():
        async with client_pair() as c:
            data = csv_bytes("Good question?,Good answer.,ref\n",
                             ",Answer with no question.,\n",
                             "Question with no answer.,,\n",
                             "Another good one?,Another answer.,\n")
            r = await c.post("/eval/cases/import", **upload(data))
            assert r.status_code == 200, r.text
            report = r.json()
            assert report["rows_total"] == 4
            assert report["rows_imported"] == 2
            assert len(report["created_case_ids"]) == 2
            assert [e["row"] for e in report["errors"]] == [2, 3]
            assert report["errors"][0]["column"] == "question"
            assert report["errors"][1]["column"] == "answer"
            assert all(e["message"] for e in report["errors"])
            assert report["set_id"] is None  # no set requested
    run(case())


def test_import_honours_column_mapping_and_extends_an_existing_set():
    async def case():
        async with client_pair() as c:
            seed = await make_case(c)
            target = (await c.post("/eval/sets", json={"name": "growing",
                                                       "case_ids": [seed["id"]]})).json()
            # Deliberately mapped in a different order than the header.
            mapping = json.dumps({"input": "expected", "output": "question"})
            data = csv_bytes("used-as-output,ignored,used-as-input\n")
            r = await c.post("/eval/cases/import",
                             **upload(data, mapping=mapping, set_id=target["id"]))
            assert r.status_code == 200, r.text
            report = r.json()
            assert report["set_id"] == target["id"] and report["rows_imported"] == 1
            imported = (await c.get(f"/eval/cases/{report['created_case_ids'][0]}")).json()
            assert imported["input"]["prompt"] == "used-as-input"
            assert imported["output"] == "used-as-output"
            assert imported["reference"] is None  # reference unmapped

            sets = (await c.get("/eval/sets")).json()
            assert sets[0]["version"] == 2  # membership appended, not overwritten
            assert sets[0]["case_ids"] == [seed["id"], report["created_case_ids"][0]]
    run(case())


def test_import_whole_file_failures_are_422():
    """422 is reserved for "Unparseable file or invalid mapping (whole-file
    failure, distinct from per-row errors)" (openapi.yaml:1421)."""
    async def case():
        async with client_pair() as c:
            good = csv_bytes("q,a,e\n")
            assert (await c.post("/eval/cases/import",
                                 **upload(good, mapping="not json"))).status_code == 422
            assert (await c.post("/eval/cases/import",
                                 **upload(good, mapping=json.dumps({"input": "question"})))
                    ).status_code == 422
            unknown = json.dumps({"input": "nope", "output": "answer"})
            bad_col = await c.post("/eval/cases/import", **upload(good, mapping=unknown))
            assert bad_col.status_code == 422
            assert "nope" in bad_col.json()["message"]
            assert (await c.post("/eval/cases/import", **upload(b""))).status_code == 422
            both_sets = await c.post("/eval/cases/import",
                                     **upload(good, set_id="a", set_name="b"))
            assert both_sets.status_code == 422
            assert (await c.post("/eval/cases/import",
                                 **upload(good, set_id="ghost"))).status_code == 404
    run(case())


def test_import_large_file_returns_202_with_the_same_report_on_the_task():
    """"Above the server's size threshold: 202 TaskRef — an 'import' task whose
    result.import_report carries the identical report shape"
    (openapi.yaml:1386-1389)."""
    async def case():
        async with client_pair() as c:
            rows = [f"q{i},a{i},\n" for i in range(IMPORT_SYNC_MAX_ROWS + 1)]
            rows[5] = ",orphan answer,\n"  # one bad row survives the async path too
            r = await c.post("/eval/cases/import",
                             **upload(csv_bytes(*rows), set_name="bulk"))
            assert r.status_code == 202, r.text
            assert set(r.json()) == {"task_id"}
            task = await wait_task(c, r.json()["task_id"])
            assert task["type"] == "import" and task["status"] == "done"
            report = task["result"]["import_report"]
            assert set(report) == {"set_id", "rows_total", "rows_imported",
                                   "created_case_ids", "errors"}
            assert report["rows_total"] == IMPORT_SYNC_MAX_ROWS + 1
            assert report["rows_imported"] == IMPORT_SYNC_MAX_ROWS
            assert [e["row"] for e in report["errors"]] == [6]
            assert report["set_id"]
            sets = (await c.get("/eval/sets")).json()
            assert sets[0]["id"] == report["set_id"]
            assert len(sets[0]["case_ids"]) == IMPORT_SYNC_MAX_ROWS
    run(case())


def xlsx_bytes(rows, shared=True) -> bytes:
    """A minimal but real .xlsx: sharedStrings + A1-referenced cells, the shape
    Excel/Sheets exports use (mock/tabular.py)."""
    strings, sheet_rows = [], []
    for r_idx, row in enumerate(rows, start=1):
        cells = []
        for c_idx, value in enumerate(row):
            ref = f"{chr(65 + c_idx)}{r_idx}"
            if shared:
                if value not in strings:
                    strings.append(value)
                cells.append(f'<c r="{ref}" t="s"><v>{strings.index(value)}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{value}</t></is></c>')
        sheet_rows.append(f'<row r="{r_idx}">{"".join(cells)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/worksheets/sheet1.xml",
                   f'<worksheet {ns}><sheetData>{"".join(sheet_rows)}</sheetData></worksheet>')
        if shared:
            items = "".join(f"<si><t>{s}</t></si>" for s in strings)
            z.writestr("xl/sharedStrings.xml", f'<sst {ns}>{items}</sst>')
    return buf.getvalue()


@pytest.mark.parametrize("shared", [True, False])
def test_import_xlsx_needs_no_extra_dependency(shared):
    async def case():
        async with client_pair() as c:
            data = xlsx_bytes([["question", "answer", "expected"],
                               ["Why two charges?", "A hold.", "Not a double charge."],
                               ["", "orphan", ""]], shared=shared)
            r = await c.post("/eval/cases/import",
                             files={"file": ("cases.xlsx", data,
                                             "application/vnd.openxmlformats-officedocument"
                                             ".spreadsheetml.sheet")},
                             data={"mapping": MAPPING})
            assert r.status_code == 200, r.text
            report = r.json()
            assert report["rows_total"] == 2 and report["rows_imported"] == 1
            assert [e["row"] for e in report["errors"]] == [2]
            got = (await c.get(f"/eval/cases/{report['created_case_ids'][0]}")).json()
            assert got["input"]["prompt"] == "Why two charges?"
            assert got["reference"] == "Not a double charge."
    run(case())


def test_import_rejects_a_corrupt_workbook_whole_file():
    async def case():
        async with client_pair() as c:
            r = await c.post("/eval/cases/import",
                             files={"file": ("cases.xlsx", b"PK\x03\x04garbage", "application/x")},
                             data={"mapping": MAPPING})
            assert r.status_code == 422
            assert "XLSX" in r.json()["message"] or "workbook" in r.json()["message"].lower()
    run(case())


# --------------------------------------------------- cases stay tree-global
def test_eval_cases_are_global_not_tree_scoped():
    """"Global: tasks, span payloads, eval rubrics/judgments, settings"
    (feature-spec.md:115) — a disabled tree blocks new RUN work, never eval
    case/set CRUD or judging standalone cases."""
    async def case():
        async with client_pair() as c:
            a = await make_case(c)
            rubric = await make_rubric(c)
            s = (await c.post("/eval/sets", json={"name": "s", "case_ids": [a["id"]]})).json()
            assert (await c.patch("/admin/agenttrees/agent1",
                                  json={"enabled": False})).status_code == 200
            assert (await c.post("/eval/cases", json={"input": {"prompt": "p"},
                                                      "output": "o"})).status_code == 201
            assert (await c.put(f"/eval/sets/{s['id']}",
                                json={"case_ids": [a["id"]]})).status_code == 201
            judged = await c.post("/eval/judge", json={
                "set_id": s["id"], "judge_model": "claude-haiku-4-5",
                "rubric_id": rubric["id"]})
            assert judged.status_code == 202
            assert (await wait_task(c, judged.json()["task_id"]))["status"] == "done"
    run(case())
