// Corn-Bitcoin power-law Z-score for BitCorn Daybreak.
//
// Model (the author's; the oracle is his own workbook, pinned row-for-row in
// tests/valuation/powerLawZ.test.ts):
//   ratio    = btc / corn                      bushels per Bitcoin
//   age      = (date − genesis) / 365.25       years, both at UTC midnight
//   trend    = a · age^b
//   residual = log10(ratio / trend)
//   Z        = residual / σ                    σ is a FIXED fitted constant
//
// ─── WHY THIS IS A SIBLING OF zscore.ts, NOT A USE OF IT ─────────────────
//
// valuation/zscore.ts looks like it already does this — toZScore(value, stats)
// is (value − mean) / stdev, and passing { mean: log10(trend), stdev: σ } would
// reproduce Z arithmetically. It is deliberately NOT used, imported, or edited:
//
//   1. It is a shared resource another arc stands on. engine.ts is its only
//      src consumer, and engine.ts feeds /valuation/current, which feeds the
//      auto-buy scheduler. Bending it to serve a second model puts a live
//      buying system in the blast radius of a display feature.
//   2. Its `stdev === 0 → return 0` guard is right for an OBSERVED series (zero
//      spread really does mean "no deviation") and wrong for a CONFIGURED σ,
//      where 0 can only mean the configuration is broken. Routed through it, a
//      bad σ becomes Z = 0 — the most plausible-looking value on the scale.
//      Here an invalid σ is an explicit error result instead.
//   3. Its Stats contract means something else: `stdev` is documented as a
//      sample (Bessel-corrected) deviation of the observed series, and
//      computeStats derives mean and stdev from that series. This model's mean
//      is a trend that moves every day and its σ comes from the author's fit.
//
// PRECEDENT for the same reasoning: app/api/src/lightning/lndHealth.ts:38-42
// ("PARALLEL CLASSIFIER") — a pattern shared with another arc and pinned by
// live tests was deliberately neither extended nor imported, and a separate
// implementation written instead.
//
// ALSO NOT the valuation composite (composite.ts): that is a fixed-weight blend
// of twelve Bitcoin-only inputs, each Z'd against its own observed history. No
// corn, no trend, no fixed σ, and it drives the auto-buy multiplier. Two
// different models that both emit "a Z" — do not merge them.
//
// ─── FAILURE CONTRACT ────────────────────────────────────────────────────
//
// Invalid input never yields a number. Non-finite or non-positive prices, a
// non-finite or non-positive σ or a, a non-finite b, a malformed date or
// genesis, a date on or before genesis (age 0 ⇒ trend 0 ⇒ infinite Z), and
// parameters that validate but overflow all return { ok: false, error }, which
// carries no numeric field a caller could render as a Z.

export interface PowerLawParams {
  a: number;
  b: number;
  sigma: number; // log10 units
  genesis: string; // ISO yyyy-mm-dd, read as UTC midnight
}

export interface PowerLawObservation {
  date: string; // ISO yyyy-mm-dd, read as UTC midnight
  corn: number; // $/bu
  btc: number; // USD
}

export interface PowerLawZValue {
  age: number; // years since genesis
  trend: number; // bushels per BTC on the power-law trend
  residual: number; // log10(ratio / trend)
  z: number;
}

export type PowerLawZError =
  | "invalid_params"
  | "invalid_date"
  | "invalid_corn_price"
  | "invalid_btc_price"
  | "date_not_after_genesis"
  | "non_finite_result";

export type PowerLawZResult =
  | { ok: true; value: PowerLawZValue }
  | { ok: false; error: PowerLawZError; detail: string };

export type PowerLawParamsCheck =
  | { ok: true; params: PowerLawParams }
  | { ok: false; kind: "wrong_shape" | "invalid_value"; detail: string };

// The author's day-count convention, verified against his workbook's age
// column with zero error across all 4,016 rows.
const DAYS_PER_YEAR = 365.25;
const MS_PER_DAY = 86_400_000;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Unix ms at UTC midnight of an ISO yyyy-mm-dd date, or null. Round-trips the
// string because Date.parse alone accepts impossible dates: it reads
// "2021-02-30" as March 2 rather than rejecting it.
function utcMidnightMs(date: string): number | null {
  if (!ISO_DATE_RE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return ms;
}

function isPositiveFinite(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/**
 * Validates an untyped value as PowerLawParams. Shared by computePowerLawZ and
 * the KV loader (powerLawParams.ts) so there is one definition of "usable".
 * `wrong_shape`: not an object, or a field missing / of the wrong type (no
 * coercion — "0.25" is not a number). `invalid_value`: right types, unusable
 * values. Extra keys are ignored and not carried into the result.
 */
export function checkPowerLawParams(raw: unknown): PowerLawParamsCheck {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, kind: "wrong_shape", detail: "params must be a JSON object" };
  }
  const p = raw as Record<string, unknown>;
  for (const k of ["a", "b", "sigma"] as const) {
    if (typeof p[k] !== "number") {
      return { ok: false, kind: "wrong_shape", detail: `${k} must be a number, got ${typeof p[k]}` };
    }
  }
  if (typeof p.genesis !== "string") {
    return { ok: false, kind: "wrong_shape", detail: `genesis must be a string, got ${typeof p.genesis}` };
  }
  const { a, b, sigma, genesis } = p as unknown as PowerLawParams;
  if (!isPositiveFinite(a)) return { ok: false, kind: "invalid_value", detail: `a must be finite and > 0, got ${a}` };
  if (!Number.isFinite(b)) return { ok: false, kind: "invalid_value", detail: `b must be finite, got ${b}` };
  if (!isPositiveFinite(sigma)) {
    return { ok: false, kind: "invalid_value", detail: `sigma must be finite and > 0, got ${sigma}` };
  }
  if (utcMidnightMs(genesis) === null) {
    return { ok: false, kind: "invalid_value", detail: `genesis must be an ISO yyyy-mm-dd date, got ${JSON.stringify(genesis)}` };
  }
  return { ok: true, params: { a, b, sigma, genesis } };
}

export function computePowerLawZ(obs: PowerLawObservation, params: PowerLawParams): PowerLawZResult {
  const checked = checkPowerLawParams(params);
  if (!checked.ok) return { ok: false, error: "invalid_params", detail: checked.detail };
  const { a, b, sigma, genesis } = checked.params;

  const dateMs = utcMidnightMs(obs.date);
  if (dateMs === null) {
    return { ok: false, error: "invalid_date", detail: `date must be an ISO yyyy-mm-dd date, got ${JSON.stringify(obs.date)}` };
  }
  if (!isPositiveFinite(obs.corn)) {
    return { ok: false, error: "invalid_corn_price", detail: `corn must be finite and > 0, got ${obs.corn}` };
  }
  if (!isPositiveFinite(obs.btc)) {
    return { ok: false, error: "invalid_btc_price", detail: `btc must be finite and > 0, got ${obs.btc}` };
  }

  const genesisMs = utcMidnightMs(genesis)!; // validated by checkPowerLawParams
  const ageDays = (dateMs - genesisMs) / MS_PER_DAY;
  if (!(ageDays > 0)) {
    return { ok: false, error: "date_not_after_genesis", detail: `${obs.date} is not after genesis ${genesis}` };
  }

  const age = ageDays / DAYS_PER_YEAR;
  const trend = a * age ** b;
  const residual = Math.log10(obs.btc / obs.corn / trend);
  const z = residual / sigma;

  // Parameters can validate and still overflow (e.g. a huge b drives trend to
  // Infinity and residual to -Infinity). The contract is "never a non-finite
  // number", so the last line of defence is here rather than at every caller.
  if (![trend, residual, z].every(Number.isFinite)) {
    return { ok: false, error: "non_finite_result", detail: `trend=${trend} residual=${residual} z=${z}` };
  }
  return { ok: true, value: { age, trend, residual, z } };
}
