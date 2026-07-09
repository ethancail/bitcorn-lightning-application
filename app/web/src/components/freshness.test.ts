import { describe, it, expect } from "vitest";
import {
  INITIAL_FRESHNESS,
  DEFAULT_STALE_THRESHOLD,
  recordSuccess,
  recordFailure,
  freshnessStatus,
  ageLabel,
  type FreshnessState,
} from "./freshness";

function failedN(n: number, lastSuccessAt: number | null = null): FreshnessState {
  let s: FreshnessState = { ...INITIAL_FRESHNESS, lastSuccessAt };
  for (let i = 0; i < n; i++) s = recordFailure(s);
  return s;
}

describe("freshness reducer", () => {
  it("failures accumulate and preserve lastSuccessAt", () => {
    const s = failedN(2, 1_000);
    expect(s.consecutiveFailures).toBe(2);
    expect(s.lastSuccessAt).toBe(1_000);
  });

  it("a success resets the failure count and stamps the time", () => {
    const s = recordSuccess(failedN(5, 1_000), 9_000);
    expect(s.consecutiveFailures).toBe(0);
    expect(s.lastSuccessAt).toBe(9_000);
  });
});

describe("freshnessStatus — the threshold logic", () => {
  it("stays fresh under the threshold (single blips don't alarm)", () => {
    expect(freshnessStatus(failedN(0), true)).toBe("fresh");
    expect(freshnessStatus(failedN(DEFAULT_STALE_THRESHOLD - 1), true)).toBe("fresh");
    // even with no data, under-threshold is "fresh" — the consumer's own
    // loading state covers the initial window
    expect(freshnessStatus(failedN(DEFAULT_STALE_THRESHOLD - 1), false)).toBe("fresh");
  });

  it("at threshold: stale when last-good data exists, unavailable when none", () => {
    expect(freshnessStatus(failedN(DEFAULT_STALE_THRESHOLD, 1_000), true)).toBe("stale");
    expect(freshnessStatus(failedN(DEFAULT_STALE_THRESHOLD), false)).toBe("unavailable");
  });

  it("respects a custom threshold", () => {
    expect(freshnessStatus(failedN(1), true, 1)).toBe("stale");
    expect(freshnessStatus(failedN(4), true, 5)).toBe("fresh");
  });

  it("recovers to fresh after a success", () => {
    const s = recordSuccess(failedN(DEFAULT_STALE_THRESHOLD, 1_000), 9_000);
    expect(freshnessStatus(s, true)).toBe("fresh");
  });
});

describe("ageLabel", () => {
  it("formats seconds, minutes, hours", () => {
    expect(ageLabel(0, 45_000)).toBe("45s ago");
    expect(ageLabel(0, 59_000)).toBe("59s ago");
    expect(ageLabel(0, 60_000)).toBe("1m ago");
    expect(ageLabel(0, 59 * 60_000)).toBe("59m ago");
    expect(ageLabel(0, 60 * 60_000)).toBe("1h ago");
    expect(ageLabel(0, 3 * 60 * 60_000 + 5 * 60_000)).toBe("3h ago");
  });

  it("clamps a future lastSuccessAt to 0s (clock skew safety)", () => {
    expect(ageLabel(10_000, 5_000)).toBe("0s ago");
  });
});
