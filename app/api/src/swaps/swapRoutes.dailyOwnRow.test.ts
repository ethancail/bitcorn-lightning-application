// Drive-mode P3 (R26(1), Ethan's go R39): the fee phase of POST
// /api/swaps/loop-out/quote no longer counts the new quote's own row against
// the daily limit. With 2,000,000 already withdrawn today, a second 2,000,000
// Loop Out (4,000,000 of 5,000,000) gets policy_check ok — before the fix its
// own row was summed AND its amount added, 6,000,000, and the fee phase said
// daily_limit_exceeded.
//
// Harness: withdrawPreQuote.test.ts's (the real route and policy on a temp-dir
// DB; loopd stubbed).

import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-route-own-row-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "11".repeat(32);

vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return {
    ...actual,
    getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 5_000_000 })),
    getLoopInTerms: vi.fn(async () => ({ min_swap_amount: 100_000, max_swap_amount: 5_000_000 })),
    getLoopOutQuote: vi.fn(async (amt: number) => ({
      swap_fee_sat: 5_000, prepay_amt_sat: 30_000, miner_fee: 3_000, total_cost_sats: 38_000,
      conf_target: 6, swap_payment_dest: "02" + "99".repeat(32), amt,
    })),
  };
});
vi.mock("./loopProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./loopProvider")>();
  return { ...actual, isLoopAvailable: vi.fn(async () => ({ available: true })) };
});
vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ pubkey: ME, node_role: "member", membership_status: "active_member" }) };
});
// Execute: everything past the policy is out of scope here — initiateSwap
// (which would call loopd) is stubbed, the address check passes.
const initiateSwap = vi.hoisted(() => vi.fn(async (id: string) => ({ id, status: "initiated" })));
vi.mock("./swapService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./swapService")>();
  return { ...actual, initiateSwap };
});
vi.mock("../utils/btc-address", () => ({ validateOnchainAddress: () => ({ ok: true }) }));

const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { handleMemberLoopOutQuote, handleMemberLoopOut } = await import("./swapRoutes");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

beforeEach(() => {
  db.prepare("DELETE FROM swap_requests").run();
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, local_reserve_sat, remote_reserve_sat, is_initiator)
    VALUES ('800000x1x0', ?, 12000000, 10000000, 1900000, 1, 0, ?, 50000, 50000, 0)
  `).run(HUB, Date.now());
});

async function quote(amount: number): Promise<{ status: number; body: any }> {
  const req: any = new EventEmitter();
  req.headers = { "content-type": "application/json" };
  let status = 0;
  let body = "";
  const res: any = { writeHead(s: number) { status = s; return res; }, end(c?: string) { if (c) body += c; return res; } };
  const done = handleMemberLoopOutQuote(req, res);
  req.emit("data", Buffer.from(JSON.stringify({ amount_sat: amount, destination_address: "bcrt1qtest" })));
  req.emit("end");
  await done;
  return { status, body: JSON.parse(body) };
}

describe("the fee phase does not count the new quote twice", () => {
  it("2,000,000 already today + a 2,000,000 quote → policy_check ok", async () => {
    db.prepare(`
      INSERT INTO swap_requests (id, created_at, updated_at, node_pubkey, role, swap_type, direction, status, amount_sat, quoted_fee_sat)
      VALUES ('earlier', ?, ?, ?, 'member', 'loop_out', 'lightning_to_chain', 'succeeded', 2000000, 8000)
    `).run(Date.now(), Date.now(), ME);
    const r = await quote(2_000_000);
    expect(r.status).toBe(200);
    expect(r.body.policy_check).toEqual({ ok: true });
  });

  it("execute: the second of two 2,000,000 Loop Outs (4,000,000 of 5,000,000) passes the policy and reaches initiation", async () => {
    const insert = db.prepare(`
      INSERT INTO swap_requests (id, created_at, updated_at, node_pubkey, role, swap_type, direction, status, amount_sat, quoted_fee_sat)
      VALUES (?, ?, ?, ?, 'member', 'loop_out', 'lightning_to_chain', ?, 2000000, 8000)
    `);
    insert.run("first", Date.now(), Date.now(), ME, "succeeded");
    insert.run("second", Date.now(), Date.now(), ME, "quote_created");
    const req: any = new EventEmitter();
    req.headers = { "content-type": "application/json" };
    let status = 0;
    let out = "";
    const res: any = { writeHead(s: number) { status = s; return res; }, end(c?: string) { if (c) out += c; return res; } };
    const done = handleMemberLoopOut(req, res);
    req.emit("data", Buffer.from(JSON.stringify({ swap_request_id: "second", destination_address: "bc1qtest" })));
    req.emit("end");
    await done;
    expect(JSON.parse(out).code).not.toBe("daily_limit_exceeded");
    expect(status).toBe(200);
    expect(initiateSwap).toHaveBeenCalledWith("second", "bc1qtest", expect.anything());
  });

  it("anti-vacuity: 4,000,000 already today + a 2,000,000 quote is still refused at the fee phase", async () => {
    db.prepare(`
      INSERT INTO swap_requests (id, created_at, updated_at, node_pubkey, role, swap_type, direction, status, amount_sat, quoted_fee_sat)
      VALUES ('earlier', ?, ?, ?, 'member', 'loop_out', 'lightning_to_chain', 'succeeded', 4000000, 8000)
    `).run(Date.now(), Date.now(), ME);
    const r = await quote(2_000_000);
    expect(r.status).toBeGreaterThanOrEqual(400); // the pre-quote phase refuses before any row
    expect(r.body.code).toBe("daily_limit_exceeded");
  });
});
