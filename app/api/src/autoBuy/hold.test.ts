// kraken-autobuy P2: the per-provider withdrawal hold (spec §3 P2, ruling S2, E1).
// Values are written out as literal seconds, not as the expressions hold.ts uses,
// so a changed expression cannot agree with itself.

import { describe, expect, it } from "vitest";
import { holdEndsAt, holdSecondsFor } from "./hold";

describe("W · withdrawal hold per provider", () => {
  it("W1 Coinbase's hold is 259200 s (72 h)", () => {
    expect(holdSecondsFor("coinbase")).toBe(259200);
  });

  it("W2 Kraken's hold is 604800 s (7 days, E1)", () => {
    expect(holdSecondsFor("kraken")).toBe(604800);
  });

  it("W3 an unknown provider throws rather than reading a default hold", () => {
    expect(() => holdSecondsFor("binance")).toThrow(/^unknown_autobuy_provider: binance$/);
    expect(() => holdSecondsFor("")).toThrow(/unknown_autobuy_provider/);
  });

  it("W4 holdEndsAt is filled_at plus the provider's hold, and null for an unfilled run", () => {
    expect(holdEndsAt("coinbase", 1_800_000_000)).toBe(1_800_259_200);
    expect(holdEndsAt("kraken", 1_800_000_000)).toBe(1_800_604_800);
    expect(holdEndsAt("kraken", null)).toBeNull();
    expect(holdEndsAt("coinbase", undefined)).toBeNull();
  });
});
