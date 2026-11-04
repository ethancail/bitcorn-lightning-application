// Drive-mode P1 item 3, R15(6): the rate's thresholds, at the boundaries.

import { describe, expect, it } from "vitest";
import { RATE_FRESH_MS, RATE_NONE_AFTER_MS, stateFor } from "./btcUsdCache";

describe("stateFor — fresh ≤ 10 min < stale ≤ 6 h < none", () => {
  it("fresh at 0 and at exactly 10 minutes", () => {
    expect(stateFor(0)).toBe("fresh");
    expect(stateFor(RATE_FRESH_MS)).toBe("fresh");
  });
  it("stale at 10 minutes + 1 second, and at exactly 6 hours", () => {
    expect(stateFor(RATE_FRESH_MS + 1_000)).toBe("stale");
    expect(stateFor(RATE_NONE_AFTER_MS)).toBe("stale");
  });
  it("none at 6 hours + 1 second, and with no rate", () => {
    expect(stateFor(RATE_NONE_AFTER_MS + 1_000)).toBe("none");
    expect(stateFor(null)).toBe("none");
  });
  it("the thresholds are R15(6)'s", () => {
    expect(RATE_FRESH_MS).toBe(10 * 60 * 1000);
    expect(RATE_NONE_AFTER_MS).toBe(6 * 60 * 60 * 1000);
  });
});
