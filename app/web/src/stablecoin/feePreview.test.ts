// Coverage for the fee preview's known-vs-zero distinction.
//
// THE VACUOUS-GREEN TRAP THIS AVOIDS: at feeBps = 0, a "known" preview and an
// "unknown" preview both produce the number 0. Any fixture using the contract's
// shipped 0 bps rate would pass whether or not the fix exists. Every
// discriminating case below uses a NONZERO rate — 25 bps, the launch rate — so
// "unknown" (null) and "zero fee" (0n) are actually distinguishable.

import { describe, expect, it } from "vitest";
import { feePreviewUnits, isFeeRateKnown } from "./feePreview";
import type { ContractStateResponse } from "./client";

function state(feeBps: number): ContractStateResponse {
  return {
    settlement_router_address: "0x" + "a".repeat(40),
    current_fee_bps: feeBps,
    is_paused: false,
    fee_recipient_address: "0x" + "b".repeat(40),
    as_of_block_number: 41_852_000,
    as_of_at: 1_750_000_000_000,
  };
}

const LAUNCH_BPS = 25; // 0.25%

describe("isFeeRateKnown", () => {
  it("is false when there is no contract state", () => {
    expect(isFeeRateKnown(null)).toBe(false);
  });

  it("is TRUE for a genuine zero-bps rate", () => {
    // The load-bearing case. A cached 0 bps is knowledge and must display as
    // "0.0% current rate". Keying the gate on the rate being nonzero instead of
    // on the state being present would suppress a true fact.
    expect(isFeeRateKnown(state(0))).toBe(true);
  });

  it("is true for the launch rate", () => {
    expect(isFeeRateKnown(state(LAUNCH_BPS))).toBe(true);
  });
});

describe("feePreviewUnits — unknown must not be representable as zero", () => {
  it("returns null (NOT 0n) when contract state is missing", () => {
    const fee = feePreviewUnits(null, "45000.00");
    expect(fee).toBeNull();
    // Stated explicitly: the old code produced 0n here and rendered it as
    // "0.00 USDC (0.0% current rate)".
    expect(fee).not.toBe(0n);
  });

  it("returns 0n (NOT null) for a real zero-bps rate", () => {
    // The other half of the distinction. Collapsing this to null would lose the
    // fact that the fee is genuinely zero.
    const fee = feePreviewUnits(state(0), "45000.00");
    expect(fee).toBe(0n);
    expect(fee).not.toBeNull();
  });

  it("computes the launch-rate fee in base units", () => {
    // 45000.00 USDC at 25 bps = 112.50 USDC = 112_500_000 units.
    expect(feePreviewUnits(state(LAUNCH_BPS), "45000.00")).toBe(112_500_000n);
  });

  it("matches the contract's integer-truncating arithmetic", () => {
    // SettlementRouter.sol:247 is integer division: 1.000001 USDC at 25 bps is
    // 1000001 * 25 / 10000 = 2500.0025 → 2500 units, truncated. Asserting the
    // truncation, not a rounded value, so the preview can't overstate the fee.
    expect(feePreviewUnits(state(LAUNCH_BPS), "1.000001")).toBe(2500n);
  });

  it("produces a sub-cent fee that would vanish at 2dp", () => {
    // 0.10 USDC at 25 bps = 0.00025 USDC = 250 units. Nonzero in base units but
    // formats to "0.00" — the same sub-cent trap as the settlement-row net/gross
    // fix. The value must survive as 250n regardless of how it renders.
    const fee = feePreviewUnits(state(LAUNCH_BPS), "0.10");
    expect(fee).toBe(250n);
    expect(fee).not.toBe(0n);
  });

  it("returns null for an unparseable amount even when the rate IS known", () => {
    // Nothing to apply a rate to. Distinct from the unknown-rate case in cause,
    // identical in "there is no number to show".
    expect(feePreviewUnits(state(LAUNCH_BPS), "")).toBeNull();
    expect(feePreviewUnits(state(LAUNCH_BPS), "abc")).toBeNull();
    expect(feePreviewUnits(state(LAUNCH_BPS), "1.0000001")).toBeNull(); // >6dp
  });

  it("returns null for an unparseable amount AND missing state", () => {
    expect(feePreviewUnits(null, "")).toBeNull();
  });

  it("treats a zero amount as a real zero fee, not unknown", () => {
    // "0" parses to 0n, so the rate applies and yields a true 0 fee. The form's
    // own validation rejects zero amounts at submit; that is a separate concern
    // from whether the preview can be computed.
    expect(feePreviewUnits(state(LAUNCH_BPS), "0")).toBe(0n);
  });
});
