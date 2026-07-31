// Coverage for the direction-aware amount selector.
//
// WHY EVERY DISCRIMINATING FIXTURE CARRIES A NONZERO FEE: the rail
// launches at feeBps = 0, where net == gross and every assertion here
// would hold with the selector deleted. A zero-fee fixture proves nothing.
//
// The two directions are tested as a PAIR on purpose. "Received shows net"
// alone would pass a blanket subtraction; "sent shows gross" alone would
// pass the original bug. Only both together pin the asymmetry.

import { describe, it, expect } from "vitest";
import {
  formatUsdcFull,
  netUnits,
  viewerDetailAmounts,
  viewerHeadlineAmount,
} from "./settlementAmounts";
import type { SettlementRow } from "./client";

const MINE = "0x" + "a".repeat(40);
const THEIRS = "0x" + "b".repeat(40);

/** 10bps on 5.00 USDC — fee 0.005, i.e. BELOW one cent. */
const SUB_CENT = { amount_units_raw: "5000000", fee_units_raw: "5000", net_units_raw: "4995000" };

function row(over: Partial<SettlementRow> = {}): SettlementRow {
  return {
    block_number: 1_000,
    tx_hash: "0x" + "c".repeat(64),
    log_index: 0,
    sender_address: THEIRS,
    recipient_address: MINE,
    amount_units_raw: "100000000",
    fee_units_raw: "100000",
    net_units_raw: "99900000",
    amount_human: "100.00",
    fee_human: "0.10",
    trade_ref: "0x" + "d".repeat(64),
    settled_at: 1_784_900_000_000,
    discovered_at: 1_784_900_030_000,
    direction: "received",
    ...over,
  };
}

describe("viewerHeadlineAmount — the asymmetry", () => {
  it("SENT shows GROSS — the merchant was debited the full amount", () => {
    // Guards against a blanket subtraction. The contract pulls `amount`
    // from the sender across two transfers (SettlementRouter.sol:268+270),
    // so the sender's figure is the gross even though a fee was charged.
    const sent = viewerHeadlineAmount(row({ direction: "sent" }));
    expect(sent).toBe("100.00");
  });

  it("RECEIVED shows NET — the farmer was credited amount - fee", () => {
    const received = viewerHeadlineAmount(row({ direction: "received" }));
    expect(received).toBe("99.90");
    // The bug this fixes: the row used to render amount_human either way.
    expect(received).not.toBe("100.00");
  });

  it("the two directions disagree on the same row (asymmetry is live)", () => {
    const base = { ...SUB_CENT, amount_human: "5.00", fee_human: "0.00" };
    expect(viewerHeadlineAmount(row({ ...base, direction: "sent" }))).toBe("5.00");
    expect(viewerHeadlineAmount(row({ ...base, direction: "received" }))).toBe("4.99");
  });

  it("NON-DISCRIMINATING (documents today's feeBps=0 behavior only)", () => {
    // At feeBps = 0 both directions agree. This passes with the selector
    // reduced to either branch, so it is NOT evidence the fix works.
    const zero = {
      amount_units_raw: "1000000",
      fee_units_raw: "0",
      net_units_raw: "1000000",
      amount_human: "1.00",
      fee_human: "0.00",
    };
    expect(viewerHeadlineAmount(row({ ...zero, direction: "sent" }))).toBe("1.00");
    expect(viewerHeadlineAmount(row({ ...zero, direction: "received" }))).toBe("1.00");
  });
});

describe("netUnits — base-unit arithmetic, never string arithmetic", () => {
  it("is exact when the fee is below one cent", () => {
    // fee_human is "0.00" here, so a format-then-subtract selector would
    // return the gross (5.00) and pass any 2dp-only assertion.
    expect(netUnits(row({ ...SUB_CENT, fee_human: "0.00" }))).toBe(4_995_000n);
  });

  it("falls back to gross - fee when the API predates net_units_raw", () => {
    // Version skew: new bundle, older API container. Must NOT render
    // "undefined USDC" on a received row.
    const legacy = row({ net_units_raw: undefined, direction: "received" });
    expect(netUnits(legacy)).toBe(99_900_000n);
    expect(viewerHeadlineAmount(legacy)).toBe("99.90");
    expect(viewerHeadlineAmount(legacy)).not.toContain("undefined");
    expect(viewerHeadlineAmount(legacy)).not.toContain("NaN");
  });

  it("treats an empty-string net as absent rather than as zero", () => {
    // BigInt("") is 0n, which would silently render 0.00 on a receipt.
    expect(netUnits(row({ net_units_raw: "" }))).toBe(99_900_000n);
  });

  it("prefers the API field over re-deriving it", () => {
    // If the API ever disagrees with gross - fee, the API is the field of
    // record; this pins which side wins rather than leaving it implicit.
    expect(netUnits(row({ net_units_raw: "42" }))).toBe(42n);
  });
});

describe("formatUsdcFull + viewerDetailAmounts — on-screen reconciliation", () => {
  it("renders all six decimals, trailing zeros kept", () => {
    expect(formatUsdcFull(45_001_000_000n)).toBe("45001.000000");
    expect(formatUsdcFull(112_502_500n)).toBe("112.502500");
    expect(formatUsdcFull(0n)).toBe("0.000000");
    expect(formatUsdcFull(1n)).toBe("0.000001");
  });

  it("gross - fee = net EXACTLY as displayed (25bps on 45001.00)", () => {
    // The case that forced full precision. At 2dp the pane would show
    // 45001.00 - 112.50 = 44888.50 while the net row said 44888.49.
    const d = viewerDetailAmounts(
      row({
        amount_units_raw: "45001000000",
        fee_units_raw: "112502500",
        net_units_raw: "44888497500",
      }),
    );
    expect(d.gross).toBe("45001.000000");
    expect(d.fee).toBe("112.502500");
    expect(d.net).toBe("44888.497500");
    // The displayed strings themselves reconcile — parse them back and the
    // identity holds, which is the property the 2dp pane violated.
    const toUnits = (s: string) => BigInt(s.replace(".", ""));
    expect(toUnits(d.fee) + toUnits(d.net)).toBe(toUnits(d.gross));
  });

  it("reconciles for a sub-cent fee too", () => {
    const d = viewerDetailAmounts(row(SUB_CENT));
    expect(d.gross).toBe("5.000000");
    expect(d.fee).toBe("0.005000"); // visible here; "0.00" at 2dp
    expect(d.net).toBe("4.995000");
  });
});
