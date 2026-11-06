// Drive-mode P3 (R26(1), Ethan's go R39): the member Loop Out daily check no
// longer counts the swap's own row. Its quote_created row is already in
// swap_requests at the fee phase and at execute, and the check used to add
// amountSat on top — so a swap counted twice against the day's limit. Two
// Loop Outs within the 5,000,000 daily limit must both pass execute.
//
// Harness: swapPolicy.maxFee.test.ts's (the real policy on a temp-dir DB;
// only Loop terms stubbed). swapRoutes.dailyOwnRow.test.ts drives the fee
// phase through the real route.

import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TREASURY = "02" + "b7".repeat(32);
const ME = "02" + "11".repeat(32);
process.env.DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-policy-own-row-"));
process.env.TREASURY_PUBKEY = TREASURY;

vi.mock("../lightning/loop", () => ({
  getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 5_000_000 })),
  getLoopInTerms: vi.fn(),
}));
vi.mock("../lightning/lnd", () => ({ getLndChainBalance: vi.fn() }));

type Policy = typeof import("./swapPolicy");
let policy: Policy;
let db: any;

beforeAll(async () => {
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  db = (await import("../db")).db;
  // One active hub channel with ample room (non-funder: room = local − reserve).
  db.prepare(`
    INSERT INTO lnd_channels
      (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at, is_initiator)
    VALUES ('c1', ?, 12000000, 10000000, 2000000, 1, 0, ?, 0)
  `).run(TREASURY, Date.now());
  policy = await import("./swapPolicy");
});

beforeEach(() => db.prepare("DELETE FROM swap_requests").run());

function row(id: string, amount: number, status: string) {
  db.prepare(`
    INSERT INTO swap_requests (id, created_at, updated_at, node_pubkey, role, swap_type, direction, status, amount_sat, quoted_fee_sat)
    VALUES (?, ?, ?, ?, 'member', 'loop_out', 'lightning_to_chain', ?, ?, 0)
  `).run(id, Date.now(), Date.now(), ME, status, amount);
}

describe("the swap's own row is not counted twice", () => {
  it("second of two 2,000,000 Loop Outs (4,000,000 of 5,000,000) passes at execute", async () => {
    row("first", 2_000_000, "succeeded");
    row("second", 2_000_000, "quote_created"); // the row execute is for
    const r = await policy.checkMemberLoopOutPolicy({
      nodePubkey: ME, amountSat: 2_000_000, quotedFeeSat: 5_000, excludeSwapRequestId: "second",
    });
    expect(r).toEqual({ ok: true });
  });

  it("other swaps still count: a third that would pass 5,000,000 is refused", async () => {
    row("first", 2_000_000, "succeeded");
    row("second", 2_000_000, "succeeded");
    row("third", 2_000_000, "quote_created");
    const r = await policy.checkMemberLoopOutPolicy({
      nodePubkey: ME, amountSat: 2_000_000, quotedFeeSat: 5_000, excludeSwapRequestId: "third",
    });
    expect(r).toMatchObject({ ok: false, code: "daily_limit_exceeded" });
  });

  it("pre-quote (no row yet) still counts every existing row", async () => {
    row("first", 4_000_000, "succeeded");
    const r = await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: 1_500_000 });
    expect(r).toMatchObject({ ok: false, code: "daily_limit_exceeded" });
  });
});
