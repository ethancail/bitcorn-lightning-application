// Oracle test for the Daybreak Corn-Bitcoin power-law Z (src/valuation/powerLawZ.ts).
//
// WHAT MAKES THIS AN ORACLE TEST. The expected values are not ours: every row in
// tests/fixtures/daybreakPowerLawOracle.ts is the model author's own spreadsheet
// output (4,016 rows, 2013-04-29..2026-09-21). The implementation is fed the
// fixture's own corn and BTC prices, so what is under test is the MATH, never a
// price feed. If this test and the workbook disagree, the implementation is
// wrong until shown otherwise.
//
// TOLERANCES, and why they differ by quantity:
//   - age, residual, Z are O(1) and asserted ABSOLUTELY at 1e-12.
//   - trend runs to ~2.4e4, where one ulp is ~3.6e-12 — an absolute 1e-12 is
//     below the float grid there. It is asserted RELATIVELY at 1e-12. Measured
//     against the workbook: trend 3.0e-15 relative, residual 1.9e-15, Z 7.4e-15,
//     age exact. The workbook computes trend as 10^(log10 a + b·log10 age)
//     rather than a·age^b; the two agree to a few ulps, which is why relative
//     is the only honest form for this quantity.
//
// WHY THE QUANTITIES ARE ASSERTED SEPARATELY: so a failure names what broke.
// A wrong day-count moves age first; a wrong exponent or coefficient moves
// trend; a wrong log base or an inverted ratio moves residual but not trend;
// a wrong σ moves Z alone.
//
// ANTI-VACUITY. "No row failed" also holds for a loop that checked nothing, and
// "Z matches" is easy if every Z is the same. So every negative assertion
// ("no offending rows") is paired in the same test with a positive one (the
// number of rows actually checked), and the fixture itself is pinned for shape,
// spread and orientation before any row is trusted.

import { describe, expect, it } from "vitest";
import {
  computePowerLawZ,
  type PowerLawParams,
  type PowerLawZResult,
} from "../../src/valuation/powerLawZ";
import {
  ORACLE_FIRST_DATE,
  ORACLE_LAST_DATE,
  ORACLE_PARAMS,
  ORACLE_ROW_COUNT,
  ORACLE_ROWS,
  ORACLE_SOURCE_DATA_POINTS,
  type OracleRow,
} from "../fixtures/daybreakPowerLawOracle";

const TOL_ABS = 1e-12;
const TOL_REL = 1e-12;

// The model author's parameters as published to us. Asserted below to be the
// exact doubles the workbook's Parameters sheet holds, so the numbers that will
// be seeded into KV are tied to the oracle rather than to a transcription.
const AUTHOR_PARAMS: PowerLawParams = {
  a: 0.01404231115158245,
  b: 4.990628190592716,
  sigma: 0.2577628256677634,
  genesis: "2009-01-03",
};

const PARAMS: PowerLawParams = { ...ORACLE_PARAMS };

describe("oracle fixture — permitting controls", () => {
  it("shape: carries exactly its declared rows, the source's row count, and exact first/last dates", () => {
    expect(ORACLE_ROWS.length).toBe(ORACLE_ROW_COUNT);
    expect(ORACLE_ROW_COUNT).toBe(4016);
    expect(ORACLE_SOURCE_DATA_POINTS).toBe(4016);
    expect(ORACLE_ROWS[0].date).toBe("2013-04-29");
    expect(ORACLE_ROWS[ORACLE_ROWS.length - 1].date).toBe("2026-09-21");
    expect(ORACLE_FIRST_DATE).toBe("2013-04-29");
    expect(ORACLE_LAST_DATE).toBe("2026-09-21");

    // Strictly ascending: no duplicated or reordered rows.
    const outOfOrder = ORACLE_ROWS.filter((r, i) => i > 0 && r.date <= ORACLE_ROWS[i - 1].date);
    expect(outOfOrder).toEqual([]);
    expect(ORACLE_ROWS.length - 1).toBe(4015); // pairs compared

    // Column alignment, pinned on the first row against the workbook's cells
    // A4..L4 read directly, so a generator that shifted a column cannot pass.
    expect(ORACLE_ROWS[0]).toEqual({
      sheetRow: 4,
      date: "2013-04-29",
      corn: 6.84,
      btc: 141.96,
      ratio: 20.754385964912281,
      age: 4.3175906913073234,
      trend: 20.782250418461924,
      residual: -5.8268465079769349e-4,
      z: -2.2605457140228965e-3,
    });
  });

  it("params: the workbook's Parameters sheet holds exactly the author's published parameters", () => {
    expect(ORACLE_PARAMS).toEqual(AUTHOR_PARAMS);
    // And they are usable, positive, finite numbers — not a vacuous equality.
    expect(PARAMS.sigma).toBeGreaterThan(0);
    expect(PARAMS.a).toBeGreaterThan(0);
  });

  it("spread: the oracle's Z values span a real range, so equality cannot pass trivially", () => {
    const zs = ORACLE_ROWS.map((r) => r.z);
    const min = Math.min(...zs);
    const max = Math.max(...zs);
    expect(min).toBe(-1.9562891330437895); // sheet row 606, 2015-09-21
    expect(max).toBe(3.279832869378659); // sheet row 1163, 2017-12-07
    expect(max - min).toBeGreaterThan(5);
    expect(new Set(zs).size).toBeGreaterThan(4000);
    // Both signs present in quantity — a function returning 0 fails every row.
    expect(zs.filter((z) => z < -1).length).toBeGreaterThan(100);
    expect(zs.filter((z) => z > 1).length).toBeGreaterThan(100);
  });

  it("orientation: ratio = btc ÷ corn (bushels per BTC) on every row, never corn ÷ btc", () => {
    const notBtcOverCorn = ORACLE_ROWS.filter((r) => r.ratio !== r.btc / r.corn);
    const isCornOverBtc = ORACLE_ROWS.filter((r) => r.ratio === r.corn / r.btc);
    expect(notBtcOverCorn.map((r) => r.sheetRow)).toEqual([]);
    expect(isCornOverBtc.map((r) => r.sheetRow)).toEqual([]);
    expect(ORACLE_ROWS.length).toBe(4016); // rows the two filters actually scanned
    // Bushels per BTC is large (BTC costs many bushels); corn ÷ btc would be < 1.
    expect(ORACLE_ROWS.every((r) => r.ratio > 1)).toBe(true);
  });
});

// ─── row-by-row comparison ───────────────────────────────────────────────

interface Comparison {
  checked: number;
  offenders: Array<{ sheetRow: number; date: string; expected: number; actual: number; err: number }>;
  worst: number;
}

function computeRow(r: OracleRow): PowerLawZResult {
  return computePowerLawZ({ date: r.date, corn: r.corn, btc: r.btc }, PARAMS);
}

function compare(
  pick: (v: { age: number; trend: number; residual: number; z: number }) => number,
  expectedOf: (r: OracleRow) => number,
  mode: "abs" | "rel",
): Comparison {
  const tol = mode === "abs" ? TOL_ABS : TOL_REL;
  const out: Comparison = { checked: 0, offenders: [], worst: 0 };
  for (const r of ORACLE_ROWS) {
    const res = computeRow(r);
    const expected = expectedOf(r);
    // A non-ok result is an offender with a NaN actual — never silently skipped.
    const actual = res.ok ? pick(res.value) : NaN;
    const diff = Math.abs(actual - expected);
    const err = mode === "abs" ? diff : diff / Math.abs(expected);
    out.checked++;
    if (!(err <= tol)) out.offenders.push({ sheetRow: r.sheetRow, date: r.date, expected, actual, err });
    if (err > out.worst || Number.isNaN(err)) out.worst = err;
  }
  return out;
}

function describeFailure(label: string, mode: "abs" | "rel", c: Comparison): string {
  return (
    `${label}: ${c.offenders.length} of ${c.checked} rows outside ${mode} ${mode === "abs" ? TOL_ABS : TOL_REL}; ` +
    `worst err ${c.worst}; first offenders ${JSON.stringify(c.offenders.slice(0, 3))}`
  );
}

describe("computePowerLawZ against the author's workbook — all 4,016 rows", () => {
  it("every oracle row computes to an ok result", () => {
    const notOk = ORACLE_ROWS.map((r) => ({ r, res: computeRow(r) })).filter((x) => !x.res.ok);
    expect(
      notOk.slice(0, 3).map((x) => ({ sheetRow: x.r.sheetRow, res: x.res })),
      `${notOk.length} of ${ORACLE_ROWS.length} rows returned an error result`,
    ).toEqual([]);
    expect(ORACLE_ROWS.length).toBe(4016);
  });

  it("AGE (sheet column E) matches, absolute 1e-12", () => {
    const c = compare((v) => v.age, (r) => r.age, "abs");
    expect(c.offenders, describeFailure("AGE (years since genesis)", "abs", c)).toEqual([]);
    expect(c.checked).toBe(ORACLE_ROW_COUNT);
  });

  it("TREND (sheet column F) matches, relative 1e-12", () => {
    const c = compare((v) => v.trend, (r) => r.trend, "rel");
    expect(c.offenders, describeFailure("TREND (a·age^b)", "rel", c)).toEqual([]);
    expect(c.checked).toBe(ORACLE_ROW_COUNT);
  });

  it("RESIDUAL (sheet column K, log10) matches, absolute 1e-12", () => {
    const c = compare((v) => v.residual, (r) => r.residual, "abs");
    expect(c.offenders, describeFailure("RESIDUAL (log10((btc/corn)/trend))", "abs", c)).toEqual([]);
    expect(c.checked).toBe(ORACLE_ROW_COUNT);
  });

  it("Z (sheet column L) matches, absolute 1e-12", () => {
    const c = compare((v) => v.z, (r) => r.z, "abs");
    expect(c.offenders, describeFailure("Z (residual/σ)", "abs", c)).toEqual([]);
    expect(c.checked).toBe(ORACLE_ROW_COUNT);
  });
});

// ─── invalid inputs: an explicit error result, never a number ────────────

const VALID_OBS = { date: "2026-09-21", corn: 5.43, btc: 86000 }; // the oracle's last row

function expectRejected(res: PowerLawZResult, error: string): void {
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.error).toBe(error);
  expect(typeof res.detail).toBe("string");
  // The failure carries no number at all — nothing a caller could render as a Z.
  expect("value" in res).toBe(false);
}

function expectValidBaseline(): void {
  const ok = computePowerLawZ(VALID_OBS, PARAMS);
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(Math.abs(ok.value.z - -0.68904927911541192)).toBeLessThanOrEqual(TOL_ABS);
}

describe("computePowerLawZ — invalid inputs return an explicit error result", () => {
  it.each([NaN, Infinity, -Infinity, 0, -5.43])("corn price %s → invalid_corn_price", (corn) => {
    expectRejected(computePowerLawZ({ ...VALID_OBS, corn }, PARAMS), "invalid_corn_price");
    expectValidBaseline();
  });

  it.each([NaN, Infinity, -Infinity, 0, -86000])("BTC price %s → invalid_btc_price", (btc) => {
    expectRejected(computePowerLawZ({ ...VALID_OBS, btc }, PARAMS), "invalid_btc_price");
    expectValidBaseline();
  });

  it.each([0, -0.2577628256677634, NaN, Infinity])("σ = %s → invalid_params", (sigma) => {
    expectRejected(computePowerLawZ(VALID_OBS, { ...PARAMS, sigma }), "invalid_params");
    expectValidBaseline();
  });

  it.each([0, -0.01404231115158245, NaN, Infinity])("a = %s → invalid_params", (a) => {
    expectRejected(computePowerLawZ(VALID_OBS, { ...PARAMS, a }), "invalid_params");
    expectValidBaseline();
  });

  it.each([NaN, Infinity, -Infinity])("b = %s → invalid_params", (b) => {
    expectRejected(computePowerLawZ(VALID_OBS, { ...PARAMS, b }), "invalid_params");
    expectValidBaseline();
  });

  it.each(["2009-01-3", "09-01-03", "2009-01-03T18:15:05Z", "2009-02-30", ""])(
    "genesis %j → invalid_params",
    (genesis) => {
      expectRejected(computePowerLawZ(VALID_OBS, { ...PARAMS, genesis }), "invalid_params");
      expectValidBaseline();
    },
  );

  it("a date BEFORE genesis → date_not_after_genesis", () => {
    expectRejected(computePowerLawZ({ ...VALID_OBS, date: "2008-12-31" }, PARAMS), "date_not_after_genesis");
    expectValidBaseline();
  });

  it("the genesis date itself → date_not_after_genesis (age 0 ⇒ trend 0 ⇒ infinite Z)", () => {
    expectRejected(computePowerLawZ({ ...VALID_OBS, date: "2009-01-03" }, PARAMS), "date_not_after_genesis");
    // The next day is the first computable one.
    const next = computePowerLawZ({ ...VALID_OBS, date: "2009-01-04" }, PARAMS);
    expect(next.ok).toBe(true);
    if (next.ok) expect(Number.isFinite(next.value.z)).toBe(true);
  });

  it.each(["2021-02-30", "2021-2-3", "", "2021-02-03T00:00:00Z", "not a date"])(
    "malformed date %j → invalid_date",
    (date) => {
      expectRejected(computePowerLawZ({ ...VALID_OBS, date }, PARAMS), "invalid_date");
      expectValidBaseline();
    },
  );

  it("parameters that validate but overflow (b = 400) → non_finite_result, not ±Infinity", () => {
    expectRejected(computePowerLawZ(VALID_OBS, { ...PARAMS, b: 400 }), "non_finite_result");
    expectValidBaseline();
  });
});
