// Drive-mode P1 item 4, R15(7): the member fee limit is exact in millisats,
// and shown rounded UP, so the figure the member sees is a true upper bound.

import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-pay-fee-limit-unit-"));
const { maxFeeMtokensFor, mtokensToSatsCeil } = await import("./payFeeLimit");

describe("maxFeeMtokensFor — 10,000 msat + amount_msat / 100", () => {
  it.each([
    ["1000", "10010"],          // 1 sat
    ["1000000", "20000"],       // 1,000 sats
    ["1234567000", "12355670"], // 1,234,567 sats
    ["0", "10000"],             // an amountless request: the base alone
  ])("%s msat → %s msat", (amount, limit) => {
    expect(maxFeeMtokensFor(amount)).toBe(limit);
  });

  it("stays exact past 2^53 msat (BigInt arithmetic)", () => {
    expect(maxFeeMtokensFor("2100000000000000000")).toBe("21000000000010000");
  });
});

describe("mtokensToSatsCeil — rounded up, never down", () => {
  it.each([["12355670", 12_356], ["20000", 20], ["20001", 21], ["1", 1]])("%s msat → %s sats", (m, sats) => {
    expect(mtokensToSatsCeil(m)).toBe(sats);
  });
});
