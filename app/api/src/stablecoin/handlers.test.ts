// Coverage for toSettlementRow — the gross/fee/net derivation and the
// direction call behind GET /api/stablecoin/settlements.
//
// WHY THESE FIXTURES ALL CARRY A NONZERO FEE: the contract launches with
// feeBps = 0, and at feeBps = 0 net == gross. A zero-fee fixture therefore
// passes whether or not the subtraction exists — a vacuous green. Every
// discriminating case below uses a nonzero fee, and the sub-cent cases
// additionally distinguish a CORRECT implementation (subtract base units)
// from a PLAUSIBLE-BUT-WRONG one (subtract the formatted 2dp strings).
//
// Test seam (no production-code change): handlers.ts statically imports
// `../db`, which opens SQLite and mkdirs DB_DIR at module load (default
// /data/db, not writable here). Same discipline as detector.test.ts —
// point DB_DIR at a throwaway temp dir, then pull handlers in via dynamic
// import once env is set.

import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { SettlementEventRow } from "./handlers";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-settlement-row-"));
process.env.DB_DIR = TMP_DIR;
process.env.TREASURY_PUBKEY = process.env.TREASURY_PUBKEY ?? "02".padEnd(66, "a");

let toSettlementRow: typeof import("./handlers").toSettlementRow;

beforeAll(async () => {
  ({ toSettlementRow } = await import("./handlers"));
});

// Addresses arrive lowercased on both sides (base/store.ts:44 for wallets,
// :232-233 for event addresses), so fixtures are lowercase too.
const MINE = "0x" + "a".repeat(40);
const THEIRS = "0x" + "b".repeat(40);

function evt(over: Partial<SettlementEventRow> = {}): SettlementEventRow {
  return {
    block_number: 1_000,
    tx_hash: "0x" + "c".repeat(64),
    log_index: 0,
    sender_address: THEIRS,
    recipient_address: MINE,
    amount_units: "1000000",
    fee_units: "0",
    trade_ref: "0x" + "d".repeat(64),
    settled_at: 1_784_900_000_000,
    discovered_at: 1_784_900_030_000,
    ...over,
  };
}

describe("toSettlementRow — net derivation", () => {
  it("derives net as gross - fee for a whole-cent fee (10bps on 100.00)", () => {
    // fee = 100_000_000 * 10 / 10_000 = 100_000 units = 0.10 USDC
    const row = toSettlementRow(
      evt({ amount_units: "100000000", fee_units: "100000" }),
      MINE,
    );
    expect(row.amount_units_raw).toBe("100000000");
    expect(row.fee_units_raw).toBe("100000");
    expect(row.net_units_raw).toBe("99900000"); // 99.90 USDC
    // Formatted siblings stay GROSS + fee; net has no *_human by design.
    expect(row.amount_human).toBe("100.00");
    expect(row.fee_human).toBe("0.10");
  });

  it("stays exact when the fee is BELOW one cent (10bps on 5.00)", () => {
    // THE DISCRIMINATING CASE. fee = 5_000_000 * 10 / 10_000 = 5_000 units
    // = 0.005 USDC, which formatUsdcUnits truncates to "0.00". So a
    // format-then-subtract implementation computes 5.00 - 0.00 = 5.00 and
    // returns the GROSS unchanged, passing every whole-cent test above.
    // Only this assertion separates the two.
    const row = toSettlementRow(
      evt({ amount_units: "5000000", fee_units: "5000" }),
      MINE,
    );
    expect(row.fee_human).toBe("0.00"); // the truncation that hides the fee
    expect(row.net_units_raw).toBe("4995000"); // 4.995 USDC — NOT 5000000
    expect(row.net_units_raw).not.toBe(row.amount_units_raw);
  });

  it("stays exact for a fractional-cent fee on a large amount (25bps on 45001.00)", () => {
    // The case that forced full-precision rendering in the detail pane:
    // true fee 112.5025 and true net 44888.4975 both truncate at 2dp, so
    // the on-screen 2dp subtraction (45001.00 - 112.50 = 44888.50)
    // disagrees with the 2dp net (44888.49) by a cent. Base units carry
    // the exact figures regardless of how they are later displayed.
    const row = toSettlementRow(
      evt({ amount_units: "45001000000", fee_units: "112502500" }),
      MINE,
    );
    expect(row.net_units_raw).toBe("44888497500");
    expect(row.amount_human).toBe("45001.00");
    expect(row.fee_human).toBe("112.50"); // truncated from 112.5025
    // The exact identity the contract enforces (SettlementRouter.sol:267).
    expect(BigInt(row.fee_units_raw) + BigInt(row.net_units_raw)).toBe(
      BigInt(row.amount_units_raw),
    );
  });

  it("NON-DISCRIMINATING (documents today's feeBps=0 behavior only)", () => {
    // At feeBps = 0 net == gross, so this test passes with the subtraction
    // REMOVED. It is here to pin current production behavior, NOT as
    // evidence the derivation works. Do not treat it as coverage.
    const row = toSettlementRow(
      evt({ amount_units: "1000000", fee_units: "0" }),
      MINE,
    );
    expect(row.net_units_raw).toBe("1000000");
    expect(row.net_units_raw).toBe(row.amount_units_raw);
  });
});

describe("toSettlementRow — direction", () => {
  it("is 'sent' when the member is the sender", () => {
    const row = toSettlementRow(
      evt({ sender_address: MINE, recipient_address: THEIRS }),
      MINE,
    );
    expect(row.direction).toBe("sent");
  });

  it("is 'received' when the member is the recipient", () => {
    const row = toSettlementRow(
      evt({ sender_address: THEIRS, recipient_address: MINE }),
      MINE,
    );
    expect(row.direction).toBe("received");
  });

  it("derives net regardless of direction (the row is viewer-agnostic)", () => {
    // Both directions carry the same net; WHICH figure is shown to the
    // member is a display decision made in the frontend selector, not here.
    const sent = toSettlementRow(
      evt({ sender_address: MINE, recipient_address: THEIRS, amount_units: "5000000", fee_units: "5000" }),
      MINE,
    );
    const received = toSettlementRow(
      evt({ sender_address: THEIRS, recipient_address: MINE, amount_units: "5000000", fee_units: "5000" }),
      MINE,
    );
    expect(sent.net_units_raw).toBe("4995000");
    expect(received.net_units_raw).toBe("4995000");
  });
});
