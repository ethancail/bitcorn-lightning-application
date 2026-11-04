// Drive-mode P1 item 6 (spec P1 item 6, §3.3; D1.8): the effective member swap
// limits are read, not hard-coded —
//   GET /api/swaps/limits → per direction, the stricter of Bitcorn's env limits
//   and loopd's live terms, plus the daily maximum and what is left of it today;
//   with loopd down, the env limits and loop_available: false.
// The route's minimum is exactly where the member policy stops refusing for
// bounds, so a UI that offers the route's minimum never offers a refusal.
//
// Env defaults (env.ts): withdrawal 250,000–2,000,000, 5,000,000/day; refill
// 100,000–3,000,000, 5,000,000/day.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-limits-route-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "11".repeat(32);

const terms = vi.hoisted(() => ({
  out: { min_swap_amount: 300_000, max_swap_amount: 1_500_000 } as any,
  in: { min_swap_amount: 150_000, max_swap_amount: 2_500_000 } as any,
}));
vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return {
    ...actual,
    getLoopOutTerms: vi.fn(async () => { if (!terms.out) throw new Error("loopd down"); return terms.out; }),
    getLoopInTerms: vi.fn(async () => { if (!terms.in) throw new Error("loopd down"); return terms.in; }),
  };
});
vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndChainBalance: vi.fn(async () => ({ chain_balance: 100_000_000 })),
    // Top Up's on-chain rule reads lnd's fee rate (drive-mode P1 item 8).
    getLndChainFeeRate: vi.fn(async () => ({ tokens_per_vbyte: 2 })),
    probeRouteToLoopServer: vi.fn(async () => ({ routable: true })),
  };
});
vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ pubkey: ME, node_role: "member", membership_status: "active" }) };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { checkMemberLoopOutPolicy, checkMemberLoopInPolicy } = await import("./swapPolicy");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

beforeEach(() => {
  terms.out = { min_swap_amount: 300_000, max_swap_amount: 1_500_000 };
  terms.in = { min_swap_amount: 150_000, max_swap_amount: 2_500_000 };
  db.prepare("DELETE FROM swap_requests").run();
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, local_reserve_sat, remote_reserve_sat)
    VALUES ('800000x1x0', ?, 10000000, 9000000, 900000, 1, 0, ?, 100000, 100000)
  `).run(HUB, Date.now());
});

async function limits(): Promise<{ status: number | null; body: any }> {
  let status: number | null = null;
  let body = "";
  const res: any = { setHeader() {}, writeHead(s: number) { status = s; return res; }, end(c?: string) { if (c) body += c; return res; } };
  await handleRequest({ method: "GET", url: "/api/swaps/limits", headers: {} } as any, res);
  return { status, body: JSON.parse(body) };
}

describe("D1.8 — GET /api/swaps/limits", () => {
  it("loopd's terms stricter than env → loopd's figures", async () => {
    const r = await limits();
    expect(r.status).toBe(200);
    expect(r.body.loop_available).toBe(true);
    expect(r.body.loop_out).toMatchObject({ min_sats: 300_000, max_sats: 1_500_000, daily_max_sats: 5_000_000 });
    expect(r.body.loop_in).toMatchObject({ min_sats: 150_000, max_sats: 2_500_000, daily_max_sats: 5_000_000 });
  });

  it("env stricter than loopd's terms → env's figures", async () => {
    terms.out = { min_swap_amount: 100_000, max_swap_amount: 10_000_000 };
    terms.in = { min_swap_amount: 50_000, max_swap_amount: 10_000_000 };
    const r = await limits();
    expect(r.body.loop_out).toMatchObject({ min_sats: 250_000, max_sats: 2_000_000 });
    expect(r.body.loop_in).toMatchObject({ min_sats: 100_000, max_sats: 3_000_000 });
  });

  it("loopd down → env's figures, loop_available false", async () => {
    terms.out = null;
    terms.in = null;
    const r = await limits();
    expect(r.status).toBe(200);
    expect(r.body.loop_available).toBe(false);
    expect(r.body.loop_out).toMatchObject({ min_sats: 250_000, max_sats: 2_000_000 });
    expect(r.body.loop_in).toMatchObject({ min_sats: 100_000, max_sats: 3_000_000 });
  });

  it("daily remaining counts today's live swaps, as the policy does", async () => {
    const add = (type: string, amount: number, status: string) => db.prepare(`
      INSERT INTO swap_requests (id, created_at, updated_at, node_pubkey, role, swap_type, direction, status, amount_sat)
      VALUES (?, ?, ?, ?, 'member', ?, ?, ?, ?)
    `).run(Math.random().toString(36), Date.now(), Date.now(), ME, type,
      type === "loop_out" ? "lightning_to_chain" : "chain_to_lightning", status, amount);
    add("loop_out", 1_200_000, "succeeded");
    add("loop_out", 700_000, "failed"); // not counted
    add("loop_in", 400_000, "initiated");
    const r = await limits();
    expect(r.body.loop_out.daily_remaining_sats).toBe(3_800_000);
    expect(r.body.loop_in.daily_remaining_sats).toBe(4_600_000);
  });
});

describe("the route's minimum is where the policy stops refusing for bounds", () => {
  for (const stricter of ["terms", "env"] as const) {
    it(`Loop Out, ${stricter} stricter`, async () => {
      if (stricter === "env") terms.out = { min_swap_amount: 100_000, max_swap_amount: 10_000_000 };
      const min = (await limits()).body.loop_out.min_sats;
      const below = await checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: min - 1, quotedFeeSat: 0 });
      const at = await checkMemberLoopOutPolicy({ nodePubkey: ME, amountSat: min, quotedFeeSat: 0 });
      expect(below).toMatchObject({ ok: false });
      expect(["below_minimum", "below_loop_minimum"]).toContain((below as any).code);
      expect(at).toEqual({ ok: true });
    });

    it(`Loop In, ${stricter} stricter`, async () => {
      if (stricter === "env") terms.in = { min_swap_amount: 50_000, max_swap_amount: 10_000_000 };
      const min = (await limits()).body.loop_in.min_sats;
      const below = await checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: min - 1 });
      const at = await checkMemberLoopInPolicy({ nodePubkey: ME, amountSat: min });
      expect(["below_minimum", "below_loop_minimum"]).toContain((below as any).code);
      expect(at).toEqual({ ok: true });
    });
  }
});
