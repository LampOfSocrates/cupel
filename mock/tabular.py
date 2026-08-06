"""P2-T12 bulk-import parsing — "upload CSV/XLSX (or paste a table)"
(feature-spec.md:63; openapi.yaml:1376-1379).

DEPENDENCY DECISION (documented per task): mock/requirements.txt gains NOTHING.
CSV is stdlib `csv`. XLSX is a zip of XML, so the reader below is stdlib
`zipfile` + `xml.etree` — ~70 lines covering exactly what real exporters emit:
shared strings, inline strings, formula-result strings, booleans and numbers,
with sparse cells placed by their A1 reference. Anything outside that (an
encrypted book, a corrupt zip, no worksheet) raises TableError, which the
endpoint answers as the contract's whole-file 422 (openapi.yaml:1421-1425) —
never a silent half-import. Rejecting XLSX outright would have failed the
skein-phases.md:80 promise ("bulk-import a spreadsheet"); adding openpyxl would
have bought a dependency for a mock that only needs to read simple grids.
"""

import csv
import io
import re
import zipfile
from xml.etree import ElementTree

XLSX_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
CELL_REF = re.compile(r"^([A-Z]+)")


class TableError(Exception):
    """Whole-file failure — the file cannot be read at all (openapi.yaml:1421)."""


def _column_index(ref: str) -> int:
    """A1-style column letters -> 0-based index ("A" -> 0, "AB" -> 27)."""
    letters = CELL_REF.match(ref or "")
    if not letters:
        return -1
    idx = 0
    for ch in letters.group(1):
        idx = idx * 26 + (ord(ch) - 64)
    return idx - 1


def _text(node) -> str:
    return "".join(node.itertext()) if node is not None else ""


def _parse_csv(data: bytes) -> list[list[str]]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = data.decode("latin-1")
        except Exception as exc:  # pragma: no cover - latin-1 decodes anything
            raise TableError(f"File is not readable text: {exc}") from exc
    try:
        return [row for row in csv.reader(io.StringIO(text, newline=""))]
    except csv.Error as exc:
        raise TableError(f"Malformed CSV: {exc}") from exc


def _parse_xlsx(data: bytes) -> list[list[str]]:
    try:
        book = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise TableError(f"Not a readable XLSX workbook: {exc}") from exc
    with book:
        sheets = sorted(n for n in book.namelist()
                        if n.startswith("xl/worksheets/sheet") and n.endswith(".xml"))
        if not sheets:
            raise TableError("Workbook contains no worksheet.")
        shared: list[str] = []
        if "xl/sharedStrings.xml" in book.namelist():
            sst = ElementTree.fromstring(book.read("xl/sharedStrings.xml"))
            shared = [_text(si) for si in sst.findall(f"{XLSX_MAIN}si")]
        try:
            sheet = ElementTree.fromstring(book.read(sheets[0]))
        except ElementTree.ParseError as exc:
            raise TableError(f"Unreadable worksheet XML: {exc}") from exc

    rows: list[list[str]] = []
    for row in sheet.iter(f"{XLSX_MAIN}row"):
        cells: list[str] = []
        for pos, cell in enumerate(row.findall(f"{XLSX_MAIN}c")):
            idx = _column_index(cell.get("r", ""))
            if idx < 0:
                idx = pos
            while len(cells) < idx:
                cells.append("")
            kind = cell.get("t")
            if kind == "s":
                raw = _text(cell.find(f"{XLSX_MAIN}v"))
                value = shared[int(raw)] if raw.isdigit() and int(raw) < len(shared) else ""
            elif kind == "inlineStr":
                value = _text(cell.find(f"{XLSX_MAIN}is"))
            else:
                value = _text(cell.find(f"{XLSX_MAIN}v"))
            cells.append(value)
        rows.append(cells)
    return rows


def parse_table(filename: str, data: bytes) -> tuple[list[str], list[list[str]]]:
    """(header, data_rows). Extension picks the parser; a .xlsx magic number
    ("PK") on an unnamed upload is honoured too, so pasted-table CSV (which the
    UI uploads as text/csv, openapi.yaml:1408) is never mis-sniffed."""
    if not data:
        raise TableError("The uploaded file is empty.")
    name = (filename or "").lower()
    if name.endswith(".xlsx") or (not name.endswith(".csv") and data[:2] == b"PK"):
        rows = _parse_xlsx(data)
    else:
        rows = _parse_csv(data)
    rows = [r for r in rows if any((c or "").strip() for c in r)]
    if not rows:
        raise TableError("The file has no rows.")
    header = [(c or "").strip() for c in rows[0]]
    if not any(header):
        raise TableError("The first row must be a header naming the columns.")
    return header, rows[1:]
