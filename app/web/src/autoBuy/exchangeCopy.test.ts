// kraken-autobuy P6 (D-P6-1, D-P6-2): the exchange's name and its hold, as the
// copy words them. Pure functions, plain *.test.ts.
import { describe, it, expect } from "vitest";
import { exchangeName, holdDuration, holdLabel, runHoldLabel } from "./exchangeCopy";

describe("exchangeName", () => {
  it("kraken is Kraken; coinbase, a missing value and anything else are Coinbase", () => {
    expect(exchangeName("kraken")).toBe("Kraken");
    expect(exchangeName("coinbase")).toBe("Coinbase");
    expect(exchangeName(undefined)).toBe("Coinbase");
    expect(exchangeName(null)).toBe("Coinbase");
  });
});

describe("holdLabel / holdDuration (D-P6-2: 96 hours or more in days, less in hours)", () => {
  it("Coinbase's 72 hours is worded in hours", () => {
    expect(holdLabel(72 * 3600)).toBe("72-hour");
    expect(holdDuration(72 * 3600)).toBe("72 hours");
  });
  it("Kraken's 7 days is worded in days", () => {
    expect(holdLabel(7 * 86400)).toBe("7-day");
    expect(holdDuration(7 * 86400)).toBe("7 days");
  });
  it("the boundary: 95 hours stays in hours, 96 hours becomes 4 days", () => {
    expect(holdLabel(95 * 3600)).toBe("95-hour");
    expect(holdLabel(96 * 3600)).toBe("4-day");
  });
  it("an unknown hold is null, never a guessed constant", () => {
    expect(holdLabel(undefined)).toBeNull();
    expect(holdLabel(null)).toBeNull();
    expect(holdLabel(0)).toBeNull();
    expect(holdDuration(undefined)).toBeNull();
  });
});

describe("runHoldLabel: a run's hold from the API's hold end minus its fill", () => {
  it("reads the difference, and is null when either end is missing", () => {
    expect(runHoldLabel({ filled_at: 1000, hold_ends_at: 1000 + 7 * 86400 })).toBe("7-day");
    expect(runHoldLabel({ filled_at: 1000, hold_ends_at: 1000 + 72 * 3600 })).toBe("72-hour");
    expect(runHoldLabel({ filled_at: null, hold_ends_at: 5000 })).toBeNull();
    expect(runHoldLabel({ filled_at: 1000, hold_ends_at: null })).toBeNull();
  });
});
