// code-audit-2, Loop and money-path env parses (the F02 follow-up): the swap
// policy's env-driven guards still enforce when their value is malformed, and
// an empty value does not zero them. Before the fix each was Number(v ?? d):
// "abc" gave NaN, every comparison against NaN is false, and the guard
// switched off; "" gave 0, which refused every swap (the caps) or dropped the
// buffer (the reserves). Each ⚠ case was red on that code.
//
// Harness: as swapPolicy.dailyCapEnv.test.ts — the real policy on a migrated
// temp-dir DB; only Loop terms and lnd's chain reads are stubbed. ENV is read
// at module load, so each case re-imports after setting the env.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-loop-env-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02" + "b7".repeat(32);
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "11".repeat(32);
// Migration 031 seeds ACINQ as an enabled egress peer.
const ACINQ = "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f";

const s = vi.hoisted(() => ({ chainBalance: 100_000_000 }));

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
    getLndChainBalance: vi.fn(async () => ({ chain_balance: s.chainBalance })),
    getLndChainFeeRate: vi.fn(async () => ({ tokens_per_vbyte: 10 })),
    probeRouteToLoopServer: vi.fn(async () => ({ routable: true })),
  };
});

const VARS = [
  "LOOP_MAX_SWAP_FEE_PCT",
  "MEMBER_MAX_WITHDRAWAL_SAT",
  "MEMBER_MAX_REFILL_SAT",
  "SWAP_MEMBER_ROUTING_BUFFER_SAT",
  "SWAP_TREASURY_EGRESS_RESERVE_SAT",
  "MEMBER_ONCHAIN_RESERVE_SAT",
] as const;
type Var = (typeof VARS)[number];

afterEach(() => {
  for (const v of VARS) delete process.env[v];
  s.chainBalance = 100_000_000;
  vi.restoreAllMocks();
});

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

async function load(
  env: Partial<Record<Var, string>>,
  opts: { hubLocal?: number; treasuryNode?: boolean; egressLocal?: number } = {},
) {
  vi.resetModules();
  for (const v of VARS) {
    if (env[v] === undefined) delete process.env[v];
    else process.env[v] = env[v];
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  const { db } = await import("../db");
  db.prepare("DELETE FROM swap_requests").run();
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare("DELETE FROM lnd_node_info").run();
  // One active hub channel (non-funder: room = local − reserve, 1% of capacity
  // when the reserve column is unset).
  const hubLocal = opts.hubLocal ?? 10_000_000;
  db.prepare(`
    INSERT INTO lnd_channels
      (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at, is_initiator)
    VALUES ('800000x1x0', ?, ?, ?, 2000000, 1, 0, ?, 0)
  `).run(HUB, hubLocal + 2_000_000, hubLocal, Date.now());
  if (opts.treasuryNode) {
    db.prepare(`
      INSERT INTO lnd_node_info (id, pubkey, network, updated_at, node_role)
      VALUES (1, ?, 'regtest', ?, 'treasury')
    `).run(ME, Date.now());
    db.prepare(`
      INSERT INTO lnd_channels
        (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at, is_initiator)
      VALUES ('800001x1x0', ?, 5000000, ?, 1000000, 1, 0, ?, 1)
    `).run(ACINQ, opts.egressLocal ?? 4_000_000, Date.now());
  }
  const policy = await import("./swapPolicy");
  const { capacityOf } = await import("../lightning/capacity");
  const { getHubChannel } = await import("../lightning/hubChannel");
  const room = capacityOf(getHubChannel()!).room_to_send_sats;
  const swapLimits = await import("./swapLimits");
  return { policy, room, swapLimits };
}

const AMOUNT = 1_000_000;
const FEE_16PCT = 160_000; // over the default 15% cap
const FEE_1PCT = 10_000;

describe("LOOP_MAX_SWAP_FEE_PCT — the 15% swap-fee cap (default 15)", () => {
  it("⚠ \"abc\": member Loop Out, a 16% quote is refused at the default cap", async () => {
    const { policy } = await load({ LOOP_MAX_SWAP_FEE_PCT: "abc" });
    const r = await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: AMOUNT, quotedFeeSat: FEE_16PCT });
    expect(r).toMatchObject({ ok: false, code: "fee_exceeds_cap" });
    expect((r as { reason: string }).reason).toContain("150000");
  });

  it("⚠ \"abc\": treasury Loop Out, a 16% quote is refused", async () => {
    const { policy } = await load({ LOOP_MAX_SWAP_FEE_PCT: "abc" });
    expect(await policy.checkTreasuryLoopOutPolicy({ amountSat: AMOUNT, quotedFeeSat: FEE_16PCT }))
      .toMatchObject({ ok: false, code: "fee_exceeds_cap" });
  });

  it("⚠ \"abc\": member Loop In (phase 2), a 16% quote is refused", async () => {
    const { policy } = await load({ LOOP_MAX_SWAP_FEE_PCT: "abc" });
    expect(await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: AMOUNT, quotedFeeSat: FEE_16PCT, minerFeeSat: 1_000 }))
      .toMatchObject({ ok: false, code: "fee_exceeds_cap" });
  });

  it("⚠ empty: a 1% quote passes on all three (the cap is the default, not 0)", async () => {
    const { policy } = await load({ LOOP_MAX_SWAP_FEE_PCT: "" });
    expect(await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: AMOUNT, quotedFeeSat: FEE_1PCT })).toEqual({ ok: true });
    expect(await policy.checkTreasuryLoopOutPolicy({ amountSat: AMOUNT, quotedFeeSat: FEE_1PCT })).toEqual({ ok: true });
    expect(await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: AMOUNT, quotedFeeSat: FEE_1PCT, minerFeeSat: 1_000 }))
      .toEqual({ ok: true });
  });

  it("control: a configured 20 lets the 16% quote through; 2.5 refuses a 3% one", async () => {
    const at20 = await load({ LOOP_MAX_SWAP_FEE_PCT: "20" });
    expect(await at20.policy.checkTreasuryLoopOutPolicy({ amountSat: AMOUNT, quotedFeeSat: FEE_16PCT })).toEqual({ ok: true });
    const at2_5 = await load({ LOOP_MAX_SWAP_FEE_PCT: "2.5" });
    expect(await at2_5.policy.checkTreasuryLoopOutPolicy({ amountSat: AMOUNT, quotedFeeSat: 30_000 }))
      .toMatchObject({ ok: false, code: "fee_exceeds_cap" });
    expect(await at2_5.policy.checkTreasuryLoopOutPolicy({ amountSat: AMOUNT, quotedFeeSat: 25_000 })).toEqual({ ok: true });
  });
});

describe("MEMBER_MAX_WITHDRAWAL_SAT — the per-swap withdrawal max (default 2,000,000)", () => {
  it("⚠ \"abc\": 3,000,000 is refused at the default max", async () => {
    const { policy } = await load({ MEMBER_MAX_WITHDRAWAL_SAT: "abc" });
    const r = await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: 3_000_000 });
    expect(r).toMatchObject({ ok: false, code: "above_maximum" });
    expect((r as { reason: string }).reason).toContain("2,000,000");
  });

  it("⚠ empty: 1,000,000 passes (the max is the default, not 0)", async () => {
    const { policy } = await load({ MEMBER_MAX_WITHDRAWAL_SAT: "" });
    expect(await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: AMOUNT })).toEqual({ ok: true });
  });

  it("control: a configured 3,500,000 lets 3,000,000 through", async () => {
    const { policy } = await load({ MEMBER_MAX_WITHDRAWAL_SAT: "3500000" });
    expect(await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: 3_000_000 })).toEqual({ ok: true });
  });
});

describe("MEMBER_MAX_REFILL_SAT — the per-swap refill max (default 3,000,000)", () => {
  it("⚠ \"abc\": 4,000,000 is refused at the default max", async () => {
    const { policy } = await load({ MEMBER_MAX_REFILL_SAT: "abc" });
    const r = await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: 4_000_000 });
    expect(r).toMatchObject({ ok: false, code: "above_maximum" });
    expect((r as { reason: string }).reason).toContain("3,000,000");
  });

  it("⚠ empty: 1,000,000 passes (the max is the default, not 0)", async () => {
    const { policy } = await load({ MEMBER_MAX_REFILL_SAT: "" });
    expect(await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: AMOUNT })).toEqual({ ok: true });
  });

  it("control: a configured 4,500,000 lets 4,000,000 through", async () => {
    const { policy } = await load({ MEMBER_MAX_REFILL_SAT: "4500000" });
    expect(await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: 4_000_000 })).toEqual({ ok: true });
  });
});

describe("SWAP_MEMBER_ROUTING_BUFFER_SAT — the hub-channel swap buffer (default 50,000)", () => {
  // A small hub channel, so the amount stays under the withdrawal max and the
  // buffer is the check that decides: amount = room − 20,000, inside the buffer.
  const HUB_LOCAL = 1_000_000;

  it("⚠ \"abc\": an amount that eats into the buffer is refused", async () => {
    const { policy, room } = await load({ SWAP_MEMBER_ROUTING_BUFFER_SAT: "abc" }, { hubLocal: HUB_LOCAL });
    const r = await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: room - 20_000 });
    expect(r).toMatchObject({ ok: false, code: "insufficient_treasury_channel" });
    expect((r as { reason: string }).reason).toContain("50,000 buffer");
  });

  it("control: a configured 0 is kept — the same amount passes", async () => {
    const { policy, room } = await load({ SWAP_MEMBER_ROUTING_BUFFER_SAT: "0" }, { hubLocal: HUB_LOCAL });
    expect(await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: room - 20_000 })).toEqual({ ok: true });
  });
});

describe("SWAP_TREASURY_EGRESS_RESERVE_SAT — the treasury egress reserve (default 100,000)", () => {
  // Egress local 1,050,000: with the 100,000 reserve, 950,000 is available.
  it("⚠ \"abc\": 1,000,000 is refused on a treasury node", async () => {
    const { policy } = await load({ SWAP_TREASURY_EGRESS_RESERVE_SAT: "abc" }, { treasuryNode: true, egressLocal: 1_050_000 });
    const r = await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: AMOUNT });
    expect(r).toMatchObject({ ok: false, code: "insufficient_egress_capacity" });
    expect((r as { reason: string }).reason).toContain("100,000 reserve");
  });

  it("control: a configured 0 is kept — 1,000,000 passes", async () => {
    const { policy } = await load({ SWAP_TREASURY_EGRESS_RESERVE_SAT: "0" }, { treasuryNode: true, egressLocal: 1_050_000 });
    expect(await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: AMOUNT })).toEqual({ ok: true });
  });
});

describe("MEMBER_ONCHAIN_RESERVE_SAT — Top Up's on-chain reserve (default 50,000)", () => {
  // Phase 2 (quoted fee and miner fee given): no route probe, no daily cap —
  // the on-chain rule decides. Balance = amount + overhead − 1 at the default.
  const MINER_FEE = 1_000;

  it("⚠ \"abc\": a wallet one sat short of amount + reserve + fees is refused", async () => {
    const { policy, swapLimits } = await load({ MEMBER_ONCHAIN_RESERVE_SAT: "abc" });
    const rule = await swapLimits.loopInOnchainRule(MINER_FEE);
    const atDefault = 50_000 + MINER_FEE + rule.anchor_reserve_sats;
    s.chainBalance = AMOUNT + atDefault - 1;
    const r = await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: AMOUNT, quotedFeeSat: FEE_1PCT, minerFeeSat: MINER_FEE });
    expect(r).toMatchObject({ ok: false, code: "insufficient_onchain" });
    expect((r as { reason: string }).reason).toContain("50,000 reserve");
  });

  it("control: a configured 0 is kept — the same wallet passes", async () => {
    const { policy, swapLimits } = await load({ MEMBER_ONCHAIN_RESERVE_SAT: "0" });
    const rule = await swapLimits.loopInOnchainRule(MINER_FEE);
    s.chainBalance = AMOUNT + 50_000 + MINER_FEE + rule.anchor_reserve_sats - 1;
    expect(await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: AMOUNT, quotedFeeSat: FEE_1PCT, minerFeeSat: MINER_FEE }))
      .toEqual({ ok: true });
  });
});
