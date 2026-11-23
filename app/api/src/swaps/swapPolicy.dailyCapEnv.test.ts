// code-audit-2 F02 regression pins: the member swap daily caps
// (swapPolicy.ts, Loop Out "Daily withdrawal limit" and Loop In "Daily refill
// cap") enforce when their env values are malformed, and an empty value does
// not zero them. Before the fix both were Number(v ?? d): "abc" gave NaN, so
// `total + amount > NaN` was false and the cap switched off; "" gave 0, so
// every swap was refused. Both directions were red on that code.
//
// Harness: the real policy on a migrated temp-dir DB, as in
// swapPolicy.dailyOwnRow.test.ts and topUpRule.test.ts; only Loop terms and
// lnd's chain reads are stubbed. ENV is read at module load, so each case
// re-imports after setting the env (vi.resetModules); the vi.mock factories
// below apply to every re-import.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-daily-cap-env-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02" + "b7".repeat(32);
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "11".repeat(32);

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
    getLndChainBalance: vi.fn(async () => ({ chain_balance: 100_000_000 })),
    getLndChainFeeRate: vi.fn(async () => ({ tokens_per_vbyte: 10 })),
    probeRouteToLoopServer: vi.fn(async () => ({ routable: true })),
  };
});

const CAP_VARS = ["MEMBER_MAX_DAILY_WITHDRAWAL_SAT", "MEMBER_MAX_DAILY_REFILL_SAT"] as const;

afterEach(() => {
  for (const v of CAP_VARS) delete process.env[v];
  vi.restoreAllMocks();
});

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

async function load(env: Partial<Record<(typeof CAP_VARS)[number], string>>) {
  vi.resetModules();
  for (const v of CAP_VARS) {
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
  // One active hub channel with ample room (non-funder: room = local − reserve).
  db.prepare(`
    INSERT INTO lnd_channels
      (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat, active, private, updated_at, is_initiator)
    VALUES ('800000x1x0', ?, 12000000, 10000000, 2000000, 1, 0, ?, 0)
  `).run(HUB, Date.now());
  const policy = await import("./swapPolicy");
  const swapRow = (swapType: "loop_out" | "loop_in", amount: number) =>
    db.prepare(`
      INSERT INTO swap_requests (id, created_at, updated_at, node_pubkey, role, swap_type, direction, status, amount_sat, quoted_fee_sat)
      VALUES (?, ?, ?, ?, 'member', ?, ?, 'succeeded', ?, 0)
    `).run(
      `r-${Math.random()}`, Date.now(), Date.now(), ME, swapType,
      swapType === "loop_out" ? "lightning_to_chain" : "chain_to_lightning", amount,
    );
  return { policy, swapRow };
}

describe("Loop Out daily withdrawal cap (default 5,000,000)", () => {
  it("⚠ \"abc\": 4,000,000 today + 1,500,000 is refused at the default", async () => {
    const { policy, swapRow } = await load({ MEMBER_MAX_DAILY_WITHDRAWAL_SAT: "abc" });
    swapRow("loop_out", 2_000_000);
    swapRow("loop_out", 2_000_000);
    const r = await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: 1_500_000 });
    expect(r).toMatchObject({ ok: false, code: "daily_limit_exceeded" });
    expect((r as { reason: string }).reason).toContain("5,000,000");
  });

  it("⚠ empty: 3,000,000 today + 1,500,000 passes (the cap is the default, not 0)", async () => {
    const { policy, swapRow } = await load({ MEMBER_MAX_DAILY_WITHDRAWAL_SAT: "" });
    swapRow("loop_out", 1_500_000);
    swapRow("loop_out", 1_500_000);
    const r = await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: 1_500_000 });
    expect(r).toEqual({ ok: true });
  });

  it("a configured 4,500,000: 3,000,000 + 1,500,000 passes, + 1,600,000 is refused", async () => {
    const { policy, swapRow } = await load({ MEMBER_MAX_DAILY_WITHDRAWAL_SAT: "4500000" });
    swapRow("loop_out", 1_500_000);
    swapRow("loop_out", 1_500_000);
    expect(await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: 1_500_000 })).toEqual({ ok: true });
    expect(await policy.checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: 1_600_000 }))
      .toMatchObject({ ok: false, code: "daily_limit_exceeded" });
  });
});

describe("Loop In daily refill cap (default 5,000,000)", () => {
  it("⚠ \"abc\": 4,500,000 today + 1,000,000 is refused at the default", async () => {
    const { policy, swapRow } = await load({ MEMBER_MAX_DAILY_REFILL_SAT: "abc" });
    swapRow("loop_in", 3_000_000);
    swapRow("loop_in", 1_500_000);
    const r = await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: 1_000_000 });
    expect(r).toMatchObject({ ok: false, code: "daily_limit_exceeded" });
    expect((r as { reason: string }).reason).toContain("5,000,000");
  });

  it("⚠ empty: 3,000,000 today + 1,000,000 passes (the cap is the default, not 0)", async () => {
    const { policy, swapRow } = await load({ MEMBER_MAX_DAILY_REFILL_SAT: "" });
    swapRow("loop_in", 3_000_000);
    const r = await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: 1_000_000 });
    expect(r).toEqual({ ok: true });
  });

  it("a configured 3,500,000: 2,500,000 + 1,000,000 passes, + 1,100,000 is refused", async () => {
    const { policy, swapRow } = await load({ MEMBER_MAX_DAILY_REFILL_SAT: "3500000" });
    swapRow("loop_in", 2_500_000);
    expect(await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: 1_000_000 })).toEqual({ ok: true });
    expect(await policy.checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: 1_100_000 }))
      .toMatchObject({ ok: false, code: "daily_limit_exceeded" });
  });
});
