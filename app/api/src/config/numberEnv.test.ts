// code-audit-2, Loop and money-path env parses (the F02 follow-up): the
// numberEnv core and its wrappers. F02's semantics, extended to ranges and
// decimals: unset or empty → the default, silently; anything outside the
// grammar or the range → the default, with one warning; never NaN, Infinity,
// or a value outside the range. positiveIntEnv.test.ts still pins the
// positiveIntEnv wrapper unchanged.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  numberEnv,
  nonNegativeIntEnv,
  percentEnv,
  positiveIntEnv,
  timerMsEnv,
  TIMER_MS_MAX,
  TIMER_MS_MIN,
} from "./numberEnv";

const NAME = "LOOP_ENV_TEST_VALUE";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[NAME];
});

/** The value, and how many times it warned (each warning must name the
 *  variable and the default). */
function parse(fn: (raw: string | undefined) => number, raw: string | undefined, def: number) {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const value = fn(raw);
  for (const [msg] of warn.mock.calls) {
    expect(String(msg)).toContain(NAME);
    expect(String(msg)).toContain(String(def));
  }
  return { value, warnings: warn.mock.calls.length };
}

describe("every wrapper: unset or empty gives the default, silently", () => {
  const wrappers = {
    positiveIntEnv: (raw?: string) => positiveIntEnv(NAME, 7, raw),
    nonNegativeIntEnv: (raw?: string) => nonNegativeIntEnv(NAME, 7, raw),
    timerMsEnv: (raw?: string) => timerMsEnv(NAME, 7, raw),
    percentEnv: (raw?: string) => percentEnv(NAME, 7, { min: 0, max: 100 }, raw),
  };
  for (const [label, fn] of Object.entries(wrappers)) {
    for (const raw of [undefined, "", "   "]) {
      it(`${label}(${JSON.stringify(raw)}) → the default, no warning`, () => {
        expect(parse(fn, raw, 7)).toEqual({ value: 7, warnings: 0 });
      });
    }
  }
});

describe("the grammar: no sign, exponent, hex, separator, word or trailing junk", () => {
  const junk = ["abc", "-5", "+5", "1e3", "0x10", "5_000", "50k", "Infinity", "NaN", "1.", ".5", "1.2.3"];
  for (const raw of junk) {
    it(`integer and decimal rules both refuse ${JSON.stringify(raw)}`, () => {
      expect(parse((r) => nonNegativeIntEnv(NAME, 9, r), raw, 9)).toEqual({ value: 9, warnings: 1 });
      expect(parse((r) => percentEnv(NAME, 9, { min: 0, max: 1e9 }, r), raw, 9)).toEqual({ value: 9, warnings: 1 });
    });
  }

  it("a whole-number rule refuses a decimal", () => {
    expect(parse((r) => nonNegativeIntEnv(NAME, 9, r), "10.5", 9)).toEqual({ value: 9, warnings: 1 });
  });

  it("a whole-number rule refuses a value past Number.MAX_SAFE_INTEGER", () => {
    expect(parse((r) => nonNegativeIntEnv(NAME, 9, r), "9007199254740993", 9)).toEqual({ value: 9, warnings: 1 });
  });

  it("surrounding whitespace is trimmed", () => {
    expect(parse((r) => nonNegativeIntEnv(NAME, 9, r), " 42 ", 9)).toEqual({ value: 42, warnings: 0 });
    expect(parse((r) => percentEnv(NAME, 9, { min: 0, max: 100 }, r), " 1.5 ", 9)).toEqual({ value: 1.5, warnings: 0 });
  });
});

describe("nonNegativeIntEnv — 0 is a value, not a fallback", () => {
  it.each([["0", 0], ["1", 1], ["007", 7], ["50000", 50_000]])("%s → %s, no warning", (raw, want) => {
    expect(parse((r) => nonNegativeIntEnv(NAME, 9, r), raw, 9)).toEqual({ value: want, warnings: 0 });
  });
});

describe(`timerMsEnv — [${TIMER_MS_MIN}, ${TIMER_MS_MAX}]: Node turns anything outside into a 1 ms delay`, () => {
  it("the range is the ruled one (R3)", () => {
    expect(TIMER_MS_MIN).toBe(1000);
    expect(TIMER_MS_MAX).toBe(2_147_483_647);
  });
  it.each([["1000", 1000], ["60000", 60_000], ["2147483647", 2_147_483_647]])("%s → %s", (raw, want) => {
    expect(parse((r) => timerMsEnv(NAME, 60_000, r), raw, 60_000)).toEqual({ value: want, warnings: 0 });
  });
  it.each(["999", "0", "1", "2147483648", "3000000000"])("%s → the default, with a warning", (raw) => {
    expect(parse((r) => timerMsEnv(NAME, 60_000, r), raw, 60_000)).toEqual({ value: 60_000, warnings: 1 });
  });
});

describe("percentEnv — decimals allowed; the bounds are the caller's", () => {
  const swapFeeCap = (r: string | undefined) => percentEnv(NAME, 15, { min: 0, minExclusive: true, max: 100 }, r);
  it.each([["1.5", 1.5], ["0.01", 0.01], ["100", 100], ["15", 15]])("swap-fee-cap rule: %s → %s", (raw, want) => {
    expect(parse(swapFeeCap, raw, 15)).toEqual({ value: want, warnings: 0 });
  });
  it.each(["0", "0.0", "100.01", "150"])("swap-fee-cap rule: %s → the default (0 and >100 invalid, R2)", (raw) => {
    expect(parse(swapFeeCap, raw, 15)).toEqual({ value: 15, warnings: 1 });
  });

  const margin = (r: string | undefined) => percentEnv(NAME, 50, { min: 0, max: 100 }, r);
  it.each([["0", 0], ["12.5", 12.5], ["100", 100]])("margin rule [0, 100]: %s → %s", (raw, want) => {
    expect(parse(margin, raw, 50)).toEqual({ value: want, warnings: 0 });
  });
  it("margin rule [0, 100]: 100.5 → the default", () => {
    expect(parse(margin, "100.5", 50)).toEqual({ value: 50, warnings: 1 });
  });
});

describe("numberEnv — the core", () => {
  it("an inclusive whole-number range (the routing cap's [1, 1,000,000])", () => {
    const cap = (r: string | undefined) => numberEnv(NAME, 10_000, { integer: true, min: 1, max: 1_000_000 }, r);
    expect(parse(cap, "1", 10_000)).toEqual({ value: 1, warnings: 0 });
    expect(parse(cap, "1000000", 10_000)).toEqual({ value: 1_000_000, warnings: 0 });
    expect(parse(cap, "0", 10_000)).toEqual({ value: 10_000, warnings: 1 });
    expect(parse(cap, "1000001", 10_000)).toEqual({ value: 10_000, warnings: 1 });
  });

  it("maxDecimals bounds the digits after the point (the base fee's millisat)", () => {
    const base = (r: string | undefined) => numberEnv(NAME, 10, { integer: false, min: 0, maxDecimals: 3 }, r);
    expect(parse(base, "0.5", 10)).toEqual({ value: 0.5, warnings: 0 });
    expect(parse(base, "1.234", 10)).toEqual({ value: 1.234, warnings: 0 });
    expect(parse(base, "0.0001", 10)).toEqual({ value: 10, warnings: 1 });
  });

  it("reads process.env[name] when no raw value is passed", () => {
    process.env[NAME] = "123";
    expect(numberEnv(NAME, 9, { integer: true, min: 0 })).toBe(123);
  });
});
