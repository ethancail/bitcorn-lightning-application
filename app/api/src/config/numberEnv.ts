// A number from the environment, inside a range, or the code's default.
//
// Why this exists (code-audit-2 F02 and its follow-up, "Loop and money-path
// env parses"): the limits, caps, buffers and timers in env.ts were parsed with
// Number(v ?? d). A malformed value gave NaN, every comparison against NaN is
// false, and the guard switched off (the 15% swap-fee cap, the withdrawal max,
// the swap buffers, quote expiry); BigInt(NaN) threw and stopped every member
// payment; setInterval(fn, NaN) became a 1 ms hot loop. An empty value — what
// compose's ${VAR:-} interpolation yields — gave 0, which refused every swap.
// So anything outside a site's grammar or range falls back to the default,
// with one warning. Never NaN, Infinity, or a value outside the range.
//
//   unset, or empty after trimming → the default, silently
//   in the grammar and the range   → that number
//   anything else                  → the default, with a console.warn
//
// The grammar is plain decimal digits: no sign, exponent, hex, separator or
// word ("abc", "-5", "1e6", "0x10", "5_000", "Infinity" are all refused).
// Whole-number rules take /^[0-9]+$/ and a safe integer; decimal rules take
// /^[0-9]+(\.[0-9]+)?$/, optionally with a bound on the digits after the point.
//
// The defaults live only at the env.ts call sites. Parsing lives here so it is
// testable apart from ENV; config/env.limits.test.ts and
// config/env.loopMoney.test.ts prove each value actually reaches ENV.

export type NumberEnvRule = {
  /** Whole numbers only; otherwise a plain decimal. */
  integer: boolean;
  /** The lower bound: inclusive, or exclusive with minExclusive. */
  min: number;
  minExclusive?: boolean;
  /** The upper bound, inclusive. */
  max?: number;
  /** Decimal rules: at most this many digits after the point. */
  maxDecimals?: number;
};

function grammar(rule: NumberEnvRule): RegExp {
  if (rule.integer) return /^[0-9]+$/;
  const frac = rule.maxDecimals === undefined ? "+" : `{1,${rule.maxDecimals}}`;
  return new RegExp(`^[0-9]+(\\.[0-9]${frac})?$`);
}

function describeRule(rule: NumberEnvRule): string {
  const kind = rule.integer ? "a whole number" : "a number";
  const digits = !rule.integer && rule.maxDecimals !== undefined
    ? ` with at most ${rule.maxDecimals} decimal places`
    : "";
  const low = rule.minExclusive ? `above ${rule.min}` : `at least ${rule.min}`;
  const high = rule.max === undefined ? "" : ` and at most ${rule.max}`;
  return `${kind}${digits} ${low}${high}`;
}

function inRange(n: number, rule: NumberEnvRule): boolean {
  if (rule.integer ? !Number.isSafeInteger(n) : !Number.isFinite(n)) return false;
  if (rule.minExclusive ? !(n > rule.min) : !(n >= rule.min)) return false;
  return rule.max === undefined || n <= rule.max;
}

export function numberEnv(
  name: string,
  defaultValue: number,
  rule: NumberEnvRule,
  raw: string | undefined = process.env[name],
): number {
  const text = raw?.trim() ?? "";
  if (text === "") return defaultValue;
  const n = grammar(rule).test(text) ? Number(text) : NaN;
  if (inRange(n, rule)) return n;
  console.warn(
    `[env] ${name}=${JSON.stringify(raw)} is not ${describeRule(rule)}; using the default ${defaultValue}`,
  );
  return defaultValue;
}

/** A positive whole number (≥ 1): limits, caps, counts, expiries. */
export function positiveIntEnv(name: string, defaultValue: number, raw?: string): number {
  return numberEnv(name, defaultValue, { integer: true, min: 1 }, raw);
}

/** A whole number ≥ 0, where 0 is a legitimate setting (a buffer, a cooldown). */
export function nonNegativeIntEnv(name: string, defaultValue: number, raw?: string): number {
  return numberEnv(name, defaultValue, { integer: true, min: 0 }, raw);
}

// Node sets a timer delay outside [1, 2147483647], NaN included, to 1 ms
// ("When delay is larger than 2147483647 or less than 1 or NaN, the delay will
// be set to 1" — Node v24 docs, timers). The floor is Ethan's ruling R3,
// 2026-11-23: no scheduler here needs to tick faster than once a second.
export const TIMER_MS_MIN = 1000;
export const TIMER_MS_MAX = 2_147_483_647;

/** A setInterval delay in ms, in [TIMER_MS_MIN, TIMER_MS_MAX]. */
export function timerMsEnv(name: string, defaultValue: number, raw?: string): number {
  return numberEnv(name, defaultValue, { integer: true, min: TIMER_MS_MIN, max: TIMER_MS_MAX }, raw);
}

/** A percentage, decimals allowed (1.5 is 1.5%), within the caller's bounds. */
export function percentEnv(
  name: string,
  defaultValue: number,
  range: { min: number; max: number; minExclusive?: boolean },
  raw?: string,
): number {
  return numberEnv(name, defaultValue, { integer: false, ...range }, raw);
}
