// code-audit-2 F02: positiveIntEnv never returns NaN, 0, a negative or
// Infinity. Each row below is one way the old parses went wrong:
// parseInt(v || d) turned "abc" into NaN (limit off) and "50k" into 50 (every
// payment refused); Number(v ?? d) turned "" into 0 (every swap refused) and
// "Infinity" into Infinity (limit off).

import { afterEach, describe, expect, it, vi } from "vitest";
import { positiveIntEnv } from "./positiveIntEnv";

const DEFAULT = 5_000_000;
const NAME = "F02_TEST_LIMIT";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env[NAME];
});

describe("positiveIntEnv — malformed values give the default, with a warning", () => {
  const malformed = [
    "abc", "50k", "1e6", "5_000", "10.5", "0", "-5", "0x10", "Infinity", "NaN",
    "9007199254740993", // past Number.MAX_SAFE_INTEGER
  ];
  for (const raw of malformed) {
    it(`${JSON.stringify(raw)} → the default, and warns`, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(positiveIntEnv(NAME, DEFAULT, raw)).toBe(DEFAULT);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(NAME);
      expect(String(warn.mock.calls[0][0])).toContain(String(DEFAULT));
    });
  }
});

describe("positiveIntEnv — unset or empty gives the default, silently", () => {
  for (const raw of [undefined, "", "   "]) {
    it(`${JSON.stringify(raw)} → the default, no warning`, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(positiveIntEnv(NAME, DEFAULT, raw)).toBe(DEFAULT);
      expect(warn).not.toHaveBeenCalled();
    });
  }
});

describe("positiveIntEnv — a positive whole number passes through", () => {
  for (const [raw, want] of [["1", 1], ["42", 42], [" 42 ", 42], ["007", 7], ["200000000", 200_000_000]] as const) {
    it(`${JSON.stringify(raw)} → ${want}, no warning`, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(positiveIntEnv(NAME, DEFAULT, raw)).toBe(want);
      expect(warn).not.toHaveBeenCalled();
    });
  }

  it("reads process.env[name] when no raw value is passed", () => {
    process.env[NAME] = "123";
    expect(positiveIntEnv(NAME, DEFAULT)).toBe(123);
  });
});
