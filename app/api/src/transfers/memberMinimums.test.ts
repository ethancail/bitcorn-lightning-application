// Drive-mode P3: the Automatic transfers page's minimum sizes are the one
// formula's, from live inputs — the member's role, the hub channel (its
// commitment fee and capacity), the cached rate, Loop's effective minimum for
// the role's direction and the member's own fee-limit rail. Read through
// GET /api/transfers/settings → member.
//
// Harness: real migrations on a temp-dir DB; loopd's terms and the cached
// rate are stubbed.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-member-minimums-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;

const live = vi.hoisted(() => ({
  out: { min_swap_amount: 250_000, max_swap_amount: 5_000_000 } as any,
  in: { min_swap_amount: 100_000, max_swap_amount: 5_000_000 } as any,
  usd: 76_848.88 as number | null,
  termsCalls: 0,
}));
vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return {
    ...actual,
    getLoopOutTerms: vi.fn(async () => { live.termsCalls++; if (!live.out) throw new Error("loopd down"); return live.out; }),
    getLoopInTerms: vi.fn(async () => { live.termsCalls++; if (!live.in) throw new Error("loopd down"); return live.in; }),
  };
});
vi.mock("../price/btcUsdCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../price/btcUsdCache")>();
  return {
    ...actual,
    getBtcUsd: () => ({ usd: live.usd, source: "coinbase", fetched_at: 1, age_ms: 0, state: live.usd == null ? "none" : "fresh" }),
  };
});

const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { memberMinimumConnections } = await import("./memberMinimums");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

function role(r: string) {
  db.prepare("UPDATE member_liquidity_advisor_config SET channel_role = ? WHERE id = 1").run(r);
}
function hub(o: { capacity?: number; active?: 0 | 1; commitFee?: number | null } = {}) {
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, local_reserve_sat, remote_reserve_sat, commit_fee_sat, commitment_type, is_initiator)
    VALUES ('800000x1x0', ?, ?, 100000, 200000, ?, 0, ?, 3500, 3500, ?, 'anchor', 1)
  `).run(HUB, o.capacity ?? 350_000, o.active ?? 1, Date.now(), o.commitFee === undefined ? 872 : o.commitFee);
}

beforeEach(() => {
  live.out = { min_swap_amount: 250_000, max_swap_amount: 5_000_000 };
  live.in = { min_swap_amount: 100_000, max_swap_amount: 5_000_000 };
  live.usd = 76_848.88;
  live.termsCalls = 0;
  db.prepare("DELETE FROM member_transfer_settings").run();
  role("farmer");
  hub();
});

describe("the member's minimums, live", () => {
  it("farmer at r5's price, A = 872: 406,055 / 499,002; capacity 350,000", async () => {
    const m = await memberMinimumConnections();
    expect(m.role).toBe("farmer");
    expect(m.capacity_sats).toBe(350_000);
    expect(m.save!.sats).toBe(406_055);
    expect(m.open!.sats).toBe(499_002);
  });

  it("merchant: 370,605 / 636,167, from Loop IN's minimum", async () => {
    role("merchant");
    const m = await memberMinimumConnections();
    expect(m.save!.sats).toBe(370_605);
    expect(m.open!.sats).toBe(636_167);
  });

  it("loopd's stricter minimum is used (S_min = 300,000)", async () => {
    live.out = { min_swap_amount: 300_000, max_swap_amount: 5_000_000 };
    expect((await memberMinimumConnections()).save!.S_min).toBe(300_000);
  });

  it("loopd down: the env minimum (250,000) still gives a figure", async () => {
    live.out = null;
    expect((await memberMinimumConnections()).save!.S_min).toBe(250_000);
  });

  it("the member's own fee limit feeds Q (1% → 2,500)", async () => {
    db.prepare("INSERT INTO member_transfer_settings (id, fee_limit_pct_bps) VALUES (1, 100)").run();
    expect((await memberMinimumConnections()).save!.Q).toBe(2_500);
  });

  it("no rate: no figures", async () => {
    live.usd = null;
    const m = await memberMinimumConnections();
    expect(m.save).toBeNull();
    expect(m.open).toBeNull();
  });

  it("an inactive hub channel still gives the capacity, for display", async () => {
    hub({ active: 0 });
    const m = await memberMinimumConnections();
    expect(m.capacity_sats).toBe(350_000);
    expect(m.hub_active).toBe(false);
  });

  it("unknown role: no figures, and loopd is not asked", async () => {
    role("unknown");
    const m = await memberMinimumConnections();
    expect(m.save).toBeNull();
    expect(live.termsCalls).toBe(0);
  });
});
