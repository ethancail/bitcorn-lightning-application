// The auto-pay history's labels for the two pay-from-node guard types, pinned
// as literals (G3 ruling R6, 2026-11-06).

import { describe, expect, it } from "vitest";
import { autoPayLabel } from "./AutoPaySection";

describe("autoPayLabel, pay-from-node guard types", () => {
  it("settlement overdue: the history says the payment is held", () => {
    expect(autoPayLabel("AUTOPAY_SETTLEMENT_OVERDUE")).toBe("Held: earlier payment not credited");
  });

  it("price not acknowledged: unchanged", () => {
    expect(autoPayLabel("AUTOPAY_PRICE_NOT_ACKNOWLEDGED")).toBe("Price not accepted");
  });
});
