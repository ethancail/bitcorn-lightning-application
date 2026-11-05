// D18 (loop-fee-ceilings spec §9; B6, item 29): the member `max_fee_sat` is
// removed. A quote request carrying it gets the same policy result as one
// without it.
//
// Before the fix, checkMemberLoopOutPolicy's fee cap was
// `maxFeeSat ?? 15%` (swapPolicy.ts:137): a caller-supplied value REPLACED the
// 15% rather than adding a minimum, so a large one waved an over-cap quote
// through. The real policy runs here against a temp-dir database the real
// migration runner builds; only Loop terms are stubbed.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const TREASURY = "02" + "b7".repeat(32);
process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-policy-maxfee-test-"));
process.env.TREASURY_PUBKEY = TREASURY;

vi.mock("../lightning/loop", () => ({
  getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 5_000_000 })),
  getLoopInTerms: vi.fn(),
}));
vi.mock("../lightning/lnd", () => ({ getLndChainBalance: vi.fn() }));

type Policy = typeof import("./swapPolicy");
let policy: Policy;

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  const { db } = await import("../db");
  // The member's one active Treasury channel, with room for the swap.
  db.prepare(`
    INSERT INTO lnd_channels
      (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at, is_initiator)
    VALUES ('c1', ?, 2000000, 1500000, 500000, 1, 0, ?, 0)
  `).run(TREASURY, Date.now());
  policy = await import("./swapPolicy");
});

describe("D18: max_fee_sat no longer changes the member Loop Out policy result", () => {
  // 15% of 250,000 is 37,500; a quoted fee of 40,000 is over it.
  const base = { nodePubkey: "02" + "11".repeat(32), amountSat: 250_000, quotedFeeSat: 40_000 };

  it("an over-cap quote is refused the same way with or without a max_fee_sat", async () => {
    const without = await policy.checkMemberLoopOutPolicy(base);
    // Forced in, as a request body could before the fix.
    const withMaxFee = await policy.checkMemberLoopOutPolicy(
      { ...base, maxFeeSat: 1_000_000 } as unknown as Parameters<Policy["checkMemberLoopOutPolicy"]>[0],
    );
    expect(without).toMatchObject({ ok: false, code: "fee_exceeds_cap" });
    expect(withMaxFee).toEqual(without);
  });

  it("a within-cap quote passes the same way with or without a small max_fee_sat", async () => {
    const ok = { ...base, quotedFeeSat: 2_000 };
    const without = await policy.checkMemberLoopOutPolicy(ok);
    const withMaxFee = await policy.checkMemberLoopOutPolicy(
      { ...ok, maxFeeSat: 1 } as unknown as Parameters<Policy["checkMemberLoopOutPolicy"]>[0],
    );
    expect(without).toEqual({ ok: true });
    expect(withMaxFee).toEqual(without);
  });
});
