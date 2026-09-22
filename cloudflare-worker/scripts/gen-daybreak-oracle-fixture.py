#!/usr/bin/env python3
"""
gen-daybreak-oracle-fixture.py — generate the Daybreak power-law oracle fixture.

Reads the model author's workbook and writes tests/fixtures/daybreakPowerLawOracle.ts,
the oracle that tests/valuation/powerLawZ.test.ts checks src/valuation/powerLawZ.ts
against. Every expected number in that fixture is the author's own spreadsheet
output; this script only transcribes it.

    python3 cloudflare-worker/scripts/gen-daybreak-oracle-fixture.py <workbook.xlsx> [out.ts]

<workbook.xlsx> is REQUIRED — there is no default, because the workbook is not in
the repo and its location is per-machine. [out.ts] defaults to the committed
fixture path (resolved from this script's location), which is what a refit wants.

WHY IT IS COMMITTED. A generated fixture whose generator lives in someone's /tmp
cannot be regenerated, only trusted. Committing it, and checking that it reproduces
the committed fixture byte-for-byte, is what makes the fixture's header a claim
that can be re-verified rather than an assertion. Same reasoning as
scripts/loopd-guard-static.py's "WHY THIS IS COMMITTED".

WHAT IT READS — nothing is hardcoded that the workbook itself states:
  - Sheet "Corn-Bitcoin Power Law", header on row 3. Observation rows are the rows
    below it whose Z-Score column (L) is non-empty; rows below the last observation
    carry projection content with an empty Z and are excluded. No sampling.
    Columns carried: A date, B corn, C BTC, D ratio, E age, F trend, K residual, L Z.
    The row-3 labels are CHECKED, so a column moved in a future workbook stops the
    run instead of shifting every value into the wrong field.
  - Sheet "Parameters", looked up by the label in column A: "Coefficient (a)",
    "Exponent (b)", "Sigma (σ, log₁₀)", "Genesis Date", "Data points". The
    parameters come from here, never from this file.

PRECISION. Values are emitted as the exact decimal strings stored in the sheet XML
(Excel's 17 significant digits), so each TypeScript literal parses to the same
IEEE-754 double the workbook holds. Dates are Excel serials, converted with the
1899-12-30 epoch; a non-integer serial stops the run.

Standard library only (zipfile + xml.etree): an .xlsx is a zip of XML parts, so no
spreadsheet dependency is needed. The workbook is opened read-only and never
modified. It is trusted local input; xml.etree does not resolve external entities.

Exit 0 = fixture written. Exit 1 = the workbook disagrees with itself (row count vs
its own "Data points", an unparseable number, a non-integer date). Exit 2 = could
not run (bad usage, unreadable workbook, sheet or label not found, header layout
changed) — a distinct class, so a broken input can never read as a good fixture.
"""
import datetime
import hashlib
import os
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS}

DATA_SHEET = "Corn-Bitcoin Power Law"
PARAMS_SHEET = "Parameters"
HEADER_ROW = 3
EXCEL_EPOCH = datetime.date(1899, 12, 30)

# Fixture field → (0-based column index, expected first line of the row-3 label).
COLUMNS = {
    "date": (0, "Date"),
    "corn": (1, "Corn Price"),
    "btc": (2, "Bitcoin Price"),
    "ratio": (3, "Bushels"),
    "age": (4, "Bitcoin Age"),
    "trend": (5, "Power Law"),
    "residual": (10, "Residual"),
    "z": (11, "Z-Score"),
}
NUMERIC = ("corn", "btc", "ratio", "age", "trend", "residual", "z")

PARAM_LABELS = {
    "a": "Coefficient (a)",
    "b": "Exponent (b)",
    "sigma": "Sigma (σ, log₁₀)",
    "genesis": "Genesis Date",
    "data_points": "Data points",
}

DEFAULT_OUT = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "daybreakPowerLawOracle.ts"
)


def die(code: int, msg: str) -> None:
    print(f"gen-daybreak-oracle-fixture: {msg}", file=sys.stderr)
    sys.exit(code)


def col_index(ref: str) -> int:
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def sheet_paths(z: zipfile.ZipFile) -> dict:
    """Sheet name → zip path, resolved through workbook.xml and its rels."""
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    targets = {r.get("Id"): r.get("Target") for r in rels.findall(f"{{{PKG_REL_NS}}}Relationship")}
    out = {}
    for s in wb.find("m:sheets", NS).findall("m:sheet", NS):
        target = targets[s.get(f"{{{REL_NS}}}id")]
        out[s.get("name")] = target.lstrip("/") if target.startswith("/") else "xl/" + target
    return out


def load_sheet(z: zipfile.ZipFile, path: str, shared: list) -> dict:
    """Row number → {column index → cached value string (or None)}."""
    sheet = ET.fromstring(z.read(path))
    rows = {}
    for row in sheet.find("m:sheetData", NS).findall("m:row", NS):
        cells = {}
        for c in row.findall("m:c", NS):
            v = c.find("m:v", NS)
            if v is not None:
                val = shared[int(v.text)] if c.get("t") == "s" else v.text
            elif c.get("t") == "inlineStr":
                val = "".join(t.text or "" for t in c.find("m:is", NS).iter(f"{{{MAIN_NS}}}t"))
            else:
                val = None
            cells[col_index(c.get("r"))] = val
        rows[int(row.get("r"))] = cells
    return rows


def serial_to_date(s: str) -> str:
    try:
        n = int(s)
    except (TypeError, ValueError):
        die(1, f"date serial is not an integer: {s!r}")
    if str(n) != s:
        die(1, f"date serial is not an integer: {s!r}")
    return (EXCEL_EPOCH + datetime.timedelta(days=n)).isoformat()


def read_workbook(path: str):
    try:
        raw = open(path, "rb").read()
        z = zipfile.ZipFile(path)
    except (OSError, zipfile.BadZipFile) as e:
        die(2, f"cannot read workbook {path!r}: {e}")
    sha = hashlib.sha256(raw).hexdigest()

    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter(f"{{{MAIN_NS}}}t")))

    sheets = sheet_paths(z)
    for name in (DATA_SHEET, PARAMS_SHEET):
        if name not in sheets:
            die(2, f"sheet {name!r} not found; workbook has {sorted(sheets)}")

    # ── Parameters, by label ──
    params_rows = load_sheet(z, sheets[PARAMS_SHEET], shared)
    by_label = {cells.get(0): (r, cells.get(1)) for r, cells in params_rows.items() if cells.get(0)}
    params = {}
    for key, label in PARAM_LABELS.items():
        row, value = by_label.get(label, (None, None))
        if value in (None, ""):
            die(2, f"Parameters sheet has no value for label {label!r}")
        params[key] = value
        params[f"{key}_cell"] = f"B{row}"  # where it was found, for the fixture header

    # ── Observation rows ──
    data = load_sheet(z, sheets[DATA_SHEET], shared)
    header = data.get(HEADER_ROW, {})
    for field, (idx, expected) in COLUMNS.items():
        got = (header.get(idx) or "").split("\n")[0].strip()
        if got != expected:
            die(2, f"row {HEADER_ROW} column {idx} ({field}) is {got!r}, expected {expected!r} — layout changed")

    rows = []
    z_idx = COLUMNS["z"][0]
    for r in sorted(data):
        if r <= HEADER_ROW:
            continue
        cells = data[r]
        if cells.get(z_idx) in (None, ""):
            continue
        rec = {"sheet_row": r}
        for field, (idx, _) in COLUMNS.items():
            rec[field] = cells.get(idx)
        for k in NUMERIC:
            if rec[k] in (None, ""):
                die(1, f"sheet row {r}: {k} is empty but Z is not")
            try:
                float(rec[k])
            except ValueError:
                die(1, f"sheet row {r}: {k} is not a number: {rec[k]!r}")
        rec["date"] = serial_to_date(rec["date"])
        rows.append(rec)

    if not rows:
        die(1, "no observation rows (no non-empty Z below the header)")
    data_points = int(params["data_points"])
    if data_points != len(rows):
        die(1, f"workbook's own Data points is {data_points} but {len(rows)} observation rows were found")
    return sha, rows, params, data_points


def render(workbook_name: str, sha: str, rows: list, params: dict, data_points: int) -> str:
    a, b, sigma = params["a"], params["b"], params["sigma"]
    genesis = serial_to_date(params["genesis"])
    lines = []
    w = lines.append
    w("// GENERATED FROM THE MODEL AUTHOR'S WORKBOOK — DO NOT HAND-EDIT.")
    w("//")
    w("// Oracle for the Daybreak Corn-Bitcoin power-law Z (src/valuation/powerLawZ.ts).")
    w("// Every number below is the author's own spreadsheet output, not ours: the test")
    w("// that imports this file checks our implementation against the authority's")
    w("// numbers rather than against our reasoning about them.")
    w("//")
    w("// SOURCE")
    w(f'//   File:    "{workbook_name}" (the model author\'s workbook)')
    w(f"//   SHA-256: {sha}")
    w(f'//   Sheet:   "{DATA_SHEET}", header on row {HEADER_ROW}')
    w(f"//   Params:  sheet \"Parameters\" — Coefficient (a) {params['a_cell']}, "
      f"Exponent (b) {params['b_cell']},")
    w(f"//            Sigma (σ, log₁₀) {params['sigma_cell']}, Genesis Date {params['genesis_cell']}, "
      f"Data points {params['data_points_cell']}")
    w("//")
    w("// SELECTION RULE: ALL observation rows — every row below the row-3 header whose")
    w("// Z-Score column (L) is non-empty. No sampling. Source row count: "
      f"{data_points} (the")
    w("// Parameters sheet's \"Data points\" cell agrees). Rows below the last observation")
    w("// carry projection content but an empty Z and are excluded by that rule.")
    w("//")
    w("// COLUMNS carried (sheet column in brackets): sheet row, date [A, Excel serial →")
    w("// ISO yyyy-mm-dd], corn $/bu [B], BTC USD [C], bushels per BTC [D], Bitcoin age")
    w("// in years [E], power-law trend [F], residual log10 [K], Z [L]. The σ-band")
    w("// columns G–J are not carried.")
    w("//")
    w("// PRECISION: values are the workbook's stored cached results, emitted verbatim")
    w("// as the 17-significant-digit strings in the sheet XML, so each literal parses")
    w("// to the exact double the workbook holds. The sheet computes the trend as")
    w("// 10^(log10(a) + b·log10(age)) rather than a·age^b; the two forms agree to")
    w("// ~3e-15 RELATIVE, which at trend ≈ 2.4e4 is several ulps — so the test")
    w("// asserts the trend relatively and the O(1) quantities absolutely.")
    w("//")
    w("// CADENCE: 2013-04-29..2020-12-31 are weekday rows only; from 2021-01-04 the")
    w("// rows are daily including weekends. Not a defect in the extraction — it is")
    w("// the source's own cadence.")
    w("")
    w("export interface OracleRow {")
    w("  sheetRow: number;")
    w("  date: string; // ISO yyyy-mm-dd (UTC)")
    w("  corn: number; // $/bu")
    w("  btc: number; // USD")
    w("  ratio: number; // bushels per BTC, as the sheet stores it")
    w("  age: number; // years since genesis")
    w("  trend: number;")
    w("  residual: number; // log10")
    w("  z: number;")
    w("}")
    w("")
    w("/** Parameters exactly as the workbook's Parameters sheet stores them. */")
    w("export const ORACLE_PARAMS = {")
    w(f"  a: {a},")
    w(f"  b: {b},")
    w(f"  sigma: {sigma},")
    w(f'  genesis: "{genesis}",')
    w("} as const;")
    w("")
    w(f"/** The workbook's own \"Data points\" cell (Parameters!{params['data_points_cell']}). */")
    w(f"export const ORACLE_SOURCE_DATA_POINTS = {data_points};")
    w("/** Rows this file declares it carries; must equal ORACLE_ROWS.length. */")
    w(f"export const ORACLE_ROW_COUNT = {len(rows)};")
    w(f'export const ORACLE_FIRST_DATE = "{rows[0]["date"]}";')
    w(f'export const ORACLE_LAST_DATE = "{rows[-1]["date"]}";')
    w("")
    w("type Raw = [number, string, number, number, number, number, number, number, number];")
    w("")
    w("// [sheetRow, date, corn, btc, ratio, age, trend, residual, z]")
    w("const RAW: Raw[] = [")
    for r in rows:
        w(f'  [{r["sheet_row"]}, "{r["date"]}", {r["corn"]}, {r["btc"]}, {r["ratio"]}, '
          f'{r["age"]}, {r["trend"]}, {r["residual"]}, {r["z"]}],')
    w("];")
    w("")
    w("export const ORACLE_ROWS: readonly OracleRow[] = RAW.map(")
    w("  ([sheetRow, date, corn, btc, ratio, age, trend, residual, z]) => ({")
    w("    sheetRow, date, corn, btc, ratio, age, trend, residual, z,")
    w("  }),")
    w(");")
    return "\n".join(lines) + "\n"


def main() -> None:
    args = sys.argv[1:]
    if len(args) not in (1, 2) or args[0].startswith("-"):
        die(2, "usage: gen-daybreak-oracle-fixture.py <workbook.xlsx> [out.ts]")
    workbook = args[0]
    out = os.path.normpath(args[1] if len(args) == 2 else DEFAULT_OUT)
    sha, rows, params, data_points = read_workbook(workbook)
    text = render(os.path.basename(workbook), sha, rows, params, data_points)
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"wrote {out}: {len(rows)} rows, {rows[0]['date']}..{rows[-1]['date']}, "
          f"a={params['a']} b={params['b']} sigma={params['sigma']} genesis={serial_to_date(params['genesis'])}, "
          f"sha256={sha}")


if __name__ == "__main__":
    main()
