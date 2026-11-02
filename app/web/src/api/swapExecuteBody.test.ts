// Ruling d, part 2: one shared builder for the swap execute request body,
// used by WithdrawBitcoin, RefillChannel and SwapOperations, carrying every
// ceiling from the quote unchanged (loop-fee-ceilings F4). Before it, each
// page spread `quoteResp.ceilings` itself and nothing tested that it did.

import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import * as client from "./client";

// Through the namespace, so a missing builder fails on its output, not on an
// import error.
const build = (q: unknown, fields: Record<string, unknown>) =>
  ((client as any).swapExecuteBody ?? (() => fields))(q, fields);

const LO = {
  max_swap_fee_sat: 835,
  max_prepay_amt_sat: 30_000,
  max_miner_fee_sat: 1_200,
  max_swap_routing_fee_sat: 2_500,
  max_prepay_routing_fee_sat: 300,
};
const LI = { max_swap_fee_sat: 500, max_miner_fee_sat: 900 };

describe("swapExecuteBody carries every ceiling from the quote", () => {
  it("Loop Out: all five, unchanged, beside the caller's fields", () => {
    const body = build({ ceilings: LO }, { swap_request_id: "r1", destination_address: "bc1q" });
    expect(body).toEqual({ swap_request_id: "r1", destination_address: "bc1q", ...LO });
  });

  it.each(Object.keys(LO))("Loop Out: %s is carried", (k) => {
    const body = build({ ceilings: LO }, { swap_request_id: "r1" });
    expect(body[k]).toBe((LO as any)[k]);
  });

  it("Loop In: both, unchanged", () => {
    expect(build({ ceilings: LI }, { swap_request_id: "r2" })).toEqual({ swap_request_id: "r2", ...LI });
  });

  it("a quote without ceilings (stored before them) adds none", () => {
    expect(build({ ceilings: null }, { swap_request_id: "r3" })).toEqual({ swap_request_id: "r3" });
  });
});

describe("the three pages build the execute body with it", () => {
  for (const p of ["../pages/WithdrawBitcoin.tsx", "../pages/RefillChannel.tsx", "../pages/SwapOperations.tsx"]) {
    it(path.basename(p), () => {
      const src = fs.readFileSync(path.resolve(__dirname, p), "utf8");
      expect(src).toContain("swapExecuteBody(");
      expect(src).not.toContain("...quoteResp.ceilings");
    });
  }
});
