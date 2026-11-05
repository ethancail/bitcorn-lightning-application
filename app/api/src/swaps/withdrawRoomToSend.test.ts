// Drive-mode P1 follow-up (R24 item 1): the most a member can withdraw is the
// hub channel's ROOM TO SEND — capacity.ts's headroom-aware figure (R23(i)) —
// less the 50,000 swap-only buffer (SWAP_MEMBER_ROUTING_BUFFER_SAT), never
// local balance − 50,000. Room subtracts the channel reserve and, for a funder,
// lnd's fee headroom; local − 50,000 offered a withdrawal lnd cannot route.
//
// Both sites: GET /api/swaps/limits → loop_out.available_now_sats (what
// Withdraw offers as "available now") and checkMemberLoopOutPolicy's spendable
// (what the server accepts before any quote).
//
// Fixture: a funder (is_initiator 1) anchor channel, local 1,000,000, reserve
// 20,000, commit fee 2,811 (Farmer1's on regtest). Its room to send is
//   1,000,000 − 20,000 − headroom, headroom = ceil(2,812 · 1,812 / 1,124) + 1
//                                           = 4,534 + 1 = 4,535
//   = 975,465,  and the maximum withdrawal 975,465 − 50,000 = 925,465.
// local − 50,000 would be 950,000: 24,535 sats lnd would refuse to send.
//
// Real policy, real swapService and real migrations on a temp-dir DB; loopd is
// stubbed at lightning/loop, where the quote spy sits.

import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-withdraw-room-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "33".repeat(32);

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

const LOCAL = 1_000_000;
const MAX_WITHDRAWAL = 925_465; // room to send 975,465 − buffer 50,000 (header)

function funderHub() {
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, local_reserve_sat, remote_reserve_sat, commit_fee_sat, commitment_type, is_initiator)
    VALUES ('800000x1x0', ?, 2000000, ?, 996529, 1, 0, ?, 20000, 20000, 2811, 'anchor', 1)
  `).run(HUB, LOCAL, Date.now());
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
  funderHub();
});

describe("R24 item 1 — the withdrawal maximum is room to send − 50,000, for a funder", () => {
  it(`Withdraw's available now is ${MAX_WITHDRAWAL.toLocaleString()}, not local − 50,000 (${(LOCAL - 50_000).toLocaleString()})`, async () => {
    expect((await getMemberSwapLimits(ME)).loop_out.available_now_sats).toBe(MAX_WITHDRAWAL);
  });

  it("the server's pre-quote policy accepts exactly that maximum and refuses one sat more", async () => {
    expect(await checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: MAX_WITHDRAWAL })).toEqual({ ok: true });
    expect(await checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: MAX_WITHDRAWAL + 1 }))
      .toMatchObject({ ok: false, code: "insufficient_treasury_channel" });
  });

  it("the quote route refuses maximum + 1 before any quote: 4xx, no loopd quote, no row", async () => {
    const r = await quote(MAX_WITHDRAWAL + 1);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.body).toMatchObject({ error: "policy_violation", code: "insufficient_treasury_channel" });
    expect(loop.getLoopOutQuote).not.toHaveBeenCalled();
    expect(rows()).toBe(0);
  });

  it("the quote route quotes exactly the maximum", async () => {
    const r = await quote(MAX_WITHDRAWAL);
    expect(r.status).toBe(200);
    expect(loop.getLoopOutQuote).toHaveBeenCalledTimes(1);
    expect(rows()).toBe(1);
  });
});
