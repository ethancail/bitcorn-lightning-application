// Drive-mode P1 item 7 (spec P1 item 7; D1.9): the member Loop Out policy runs
// BEFORE any quote — a refused amount creates no swap_requests row and asks
// loopd for nothing. The policy splits like Loop In's: a pre-quote phase (no
// fee yet) and the fee phase after the quote.
//
// And the figure Withdraw offers as its ceiling — GET /api/swaps/limits →
// loop_out.available_now_sats — is exactly the pre-quote phase's acceptance
// point: an amount at it passes, one sat more is refused.
//
// Real policy, real swapService and real migrations on a temp-dir DB; loopd is
// stubbed at lightning/loop, where the quote spy sits.

import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-withdraw-prequote-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "11".repeat(32);

const loop = vi.hoisted(() => ({
  getLoopOutQuote: vi.fn(async (amt: number) => ({
    swap_fee_sat: 500, prepay_amt_sat: 1_000, miner_fee: 3_000, total_cost_sats: 4_500,
    conf_target: 6, swap_payment_dest: "02" + "99".repeat(32), amt,
  })),
}));
vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return {
    ...actual,
    getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 5_000_000 })),
    getLoopInTerms: vi.fn(async () => ({ min_swap_amount: 100_000, max_swap_amount: 5_000_000 })),
    getLoopOutQuote: loop.getLoopOutQuote,
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

const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { handleMemberLoopOutQuote } = await import("./swapRoutes");
const { getMemberSwapLimits, checkMemberLoopOutPolicy } = await import("./swapPolicy");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

function hubLocal(local: number) {
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, local_reserve_sat, remote_reserve_sat)
    VALUES ('800000x1x0', ?, 5000000, ?, ?, 1, 0, ?, 50000, 50000)
  `).run(HUB, local, 4_900_000 - local, Date.now());
}

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

const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM swap_requests").get() as { n: number }).n;

beforeEach(() => {
  db.prepare("DELETE FROM swap_requests").run();
  loop.getLoopOutQuote.mockClear();
});

describe("D1.9 — too little in the channel: refused before any quote", () => {
  it("a 250,000 withdrawal from a channel holding 200,000 → 4xx, no loopd quote, no row", async () => {
    hubLocal(200_000);
    const r = await quote(250_000);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.body).toMatchObject({ error: "policy_violation", code: "insufficient_treasury_channel" });
    expect(loop.getLoopOutQuote).not.toHaveBeenCalled();
    expect(rows()).toBe(0);
  });

  it("an amount the channel holds is quoted as before (row created, fee phase advisory)", async () => {
    hubLocal(1_000_000);
    const r = await quote(250_000);
    expect(r.status).toBe(200);
    expect(loop.getLoopOutQuote).toHaveBeenCalledTimes(1);
    expect(rows()).toBe(1);
    expect(r.body.policy_check).toEqual({ ok: true });
  });
});

describe("available_now_sats is the pre-quote phase's acceptance point", () => {
  for (const local of [400_000, 1_000_000, 3_000_000]) {
    it(`hub local ${local.toLocaleString()}`, async () => {
      hubLocal(local);
      const now = (await getMemberSwapLimits(ME)).loop_out.available_now_sats;
      expect(await checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: now })).toEqual({ ok: true });
      expect(await checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: now + 1 })).toMatchObject({ ok: false });
    });
  }

  it("with less than the minimum withdrawable, available_now_sats is below the minimum", async () => {
    hubLocal(200_000);
    const l = (await getMemberSwapLimits(ME)).loop_out;
    expect(l.available_now_sats).toBeLessThan(l.min_sats);
  });
});
