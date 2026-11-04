// Drive-mode P1 item 8 (spec P1 item 8; D1.10; R16(9), R18(10)): Top Up
// follows one rule, stated by the server —
//   needed on-chain = amount + 50,000 reserve + the HTLC's network fee
//                     + min(10,000 × anchor channels, 100,000)
// The 50,000 is ADDED to the fee and the anchor reserve, not replaced by them
// (R18(10)). The fee is lnd's fee rate × the HTLC transaction's assumed vsize
// at check time, and the stored quote's miner fee at execute. Anchor channels
// are counted as lnd counts them: public channels whose commitment type has
// anchor outputs (lnd lnwallet/wallet.go CurrentNumAnchorChans skips private
// channels).
//
// The boundary table runs the policy's pre-quote phase at the minimum top-up
// and compares it with the floor and the maximum the limits route states, at
// every wallet balance around the floor, with one and with two anchor
// channels.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-topup-rule-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "11".repeat(32);

const chain = vi.hoisted(() => ({ balance: 0, feeRate: 10 }));
vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return {
    ...actual,
    getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 5_000_000 })),
    getLoopInTerms: vi.fn(async () => ({ min_swap_amount: 100_000, max_swap_amount: 5_000_000 })),
  };
});
vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndChainBalance: vi.fn(async () => ({ chain_balance: chain.balance })),
    getLndChainFeeRate: vi.fn(async () => ({ tokens_per_vbyte: chain.feeRate })),
    probeRouteToLoopServer: vi.fn(async () => ({ routable: true })),
  };
});

const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { checkMemberLoopInPolicy, getMemberSwapLimits } = await import("./swapPolicy");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

const MIN = 100_000;
const RESERVE = 50_000;
const VBYTES = 221;
const FEE = 10 * VBYTES; // 2,210 at 10 sat/vB

function channels(publicAnchors: number) {
  db.prepare("DELETE FROM lnd_channels").run();
  const add = (id: string, type: string, priv: number) => db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, commitment_type)
    VALUES (?, ?, 2000000, 100000, 1800000, 1, ?, ?, ?)
  `).run(id, id === "800000x1x0" ? HUB : "03" + id.replace(/x/g, "").padStart(64, "0").slice(0, 64), priv, Date.now(), type);
  add("800000x1x0", publicAnchors >= 1 ? "anchor" : "original", 0);
  if (publicAnchors >= 2) add("800001x1x0", "simplified_taproot", 0);
  add("800002x1x0", "anchor", 1);        // private: lnd does not count it
  add("800003x1x0", "original", 0);      // no anchors
}

beforeEach(() => {
  db.prepare("DELETE FROM swap_requests").run();
  chain.feeRate = 10;
});

for (const anchors of [1, 2]) {
  const anchorReserve = 10_000 * anchors;
  const floor = MIN + RESERVE + FEE + anchorReserve;

  describe(`D1.10 — ${anchors} anchor channel(s): floor ${floor.toLocaleString()}`, () => {
    beforeEach(() => channels(anchors));

    it("the limits route states the floor and the rule's parts", async () => {
      chain.balance = floor;
      const l = (await getMemberSwapLimits(ME)).loop_in;
      expect(l.onchain_floor_sats).toBe(floor);
      expect(l.onchain_rule).toEqual({
        reserve_sats: RESERVE,
        anchor_channels: anchors,
        anchor_reserve_sats: anchorReserve,
        fee_rate_sat_per_vbyte: 10,
        htlc_tx_vbytes: VBYTES,
        estimated_htlc_fee_sats: FEE,
      });
    });

    const balances = [0, 60_000, 150_000, floor - 1, floor, floor + 1, floor + 10_000];
    for (const balance of balances) {
      it(`wallet ${balance.toLocaleString()}: policy, floor and maximum agree`, async () => {
        chain.balance = balance;
        const policy = await checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: MIN });
        const l = (await getMemberSwapLimits(ME)).loop_in;
        const allowed = balance >= floor;
        expect(policy.ok, "the policy at the minimum").toBe(allowed);
        if (!allowed) expect(policy).toMatchObject({ code: "insufficient_onchain" });
        expect(l.available_now_sats >= MIN, "the stated maximum reaches the minimum").toBe(allowed);
        expect(l.available_now_sats).toBe(Math.max(0, Math.min(5_000_000, balance - RESERVE - FEE - anchorReserve)));
      });
    }
  });
}

describe("R18(10) — at execute the stored quote's miner fee replaces the estimate", () => {
  it("needed = amount + reserve + the quoted miner fee + the anchor reserve", async () => {
    channels(1);
    const quotedMiner = 7_777;
    const floorAtExecute = MIN + RESERVE + quotedMiner + 10_000;
    chain.balance = floorAtExecute - 1;
    expect(await checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: MIN, quotedFeeSat: 8_000, minerFeeSat: quotedMiner }))
      .toMatchObject({ ok: false, code: "insufficient_onchain" });
    chain.balance = floorAtExecute;
    expect(await checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: MIN, quotedFeeSat: 8_000, minerFeeSat: quotedMiner }))
      .toEqual({ ok: true });
  });
});

describe("the anchor reserve is capped at 100,000", () => {
  it("12 public anchor channels reserve 100,000, not 120,000", async () => {
    db.prepare("DELETE FROM lnd_channels").run();
    for (let i = 0; i < 12; i++) {
      db.prepare(`
        INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
          active, private, updated_at, commitment_type)
        VALUES (?, ?, 1000000, 1, 1, 1, 0, ?, 'anchor')
      `).run(`9000${i}x1x0`, "03" + String(i).padStart(64, "a"), Date.now());
    }
    chain.balance = 1_000_000;
    const r = (await getMemberSwapLimits(ME)).loop_in.onchain_rule!;
    expect(r.anchor_channels).toBe(12);
    expect(r.anchor_reserve_sats).toBe(100_000);
  });
});
