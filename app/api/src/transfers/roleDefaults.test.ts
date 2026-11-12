// R59(3) [RELAYED — drive-mode arc chat, 2026-11-12]: "Most you'll pay per
// transfer" defaults by the member's channel_role (memberRole()): farmer $3
// (300 cents), merchant $5 (500), unknown $3. Saved figures stay saved; an
// empty column follows the role. The option cards take the role from
// memberRole() too, not from the swap's direction.
//
// Harness: noFeePercent.test.ts's (real migrations on a temp-dir DB; loopd,
// lnd's wallet, node info and the cached rate stubbed). Rate $100,000/BTC, so
// $1 = 1,000 sats.

import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-role-defaults-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "11".repeat(32);

vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return {
    ...actual,
    getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 2_000_000 })),
    getLoopInTerms: vi.fn(async () => ({ min_swap_amount: 100_000, max_swap_amount: 3_000_000 })),
    getLoopOutQuote: vi.fn(async (amt: number) => ({ swap_fee_sat: Math.ceil(amt / 100), prepay_amt_sat: 30_000, miner_fee: 3_000, total_cost_sats: 0, conf_target: 6, swap_payment_dest: "" })),
    getLoopInQuote: vi.fn(async (amt: number) => ({ swap_fee_sat: Math.ceil(amt / 200), htlc_publish_fee_sat: 2_000, cltv_delta: 0, conf_target: 6, total_cost_sats: 0 })),
  };
});
vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndChainBalance: vi.fn(async () => ({ chain_balance: 100_000_000 })),
    getLndChainFeeRate: vi.fn(async () => ({ tokens_per_vbyte: 2 })),
  };
});
vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ pubkey: ME, node_role: "member", membership_status: "active_member" }) };
});
vi.mock("../price/btcUsdCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../price/btcUsdCache")>();
  return { ...actual, getBtcUsd: () => ({ usd: 100_000, source: "coinbase", fetched_at: 1, age_ms: 0, state: "fresh" }) };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");
const { clearSwapOptionsQuoteCache } = await import("../swaps/swapOptions");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

function hub(local: number, remote: number) {
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, local_reserve_sat, remote_reserve_sat, commit_fee_sat, commitment_type, is_initiator)
    VALUES ('800000x1x0', ?, 1000000, ?, ?, 1, 0, ?, 10000, 10000, 872, 'anchor', 0)
  `).run(HUB, local, remote, Date.now());
}

function role(r: "farmer" | "merchant" | "unknown") {
  db.prepare("UPDATE member_liquidity_advisor_config SET channel_role = ? WHERE id = 1").run(r);
}

beforeEach(() => {
  clearSwapOptionsQuoteCache();
  db.prepare("DELETE FROM member_transfer_settings").run();
  db.prepare("DELETE FROM fee_estimate_samples").run();
  role("unknown");
});

async function get(url: string): Promise<any> {
  let out = "";
  const res: any = { setHeader() {}, writeHead() { return res; }, end(c?: string) { if (c) out += c; return res; } };
  await handleRequest({ method: "GET", url, headers: {} } as any, res);
  return JSON.parse(out);
}

async function patch(body: unknown): Promise<number> {
  const req: any = new EventEmitter();
  req.method = "PATCH";
  req.url = "/api/transfers/settings";
  req.headers = { "content-type": "application/json" };
  let status = 0;
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const res: any = { setHeader() {}, writeHead(s: number) { status = s; return res; }, end() { done(); return res; } };
  const handled = handleRequest(req, res);
  await new Promise((r) => setImmediate(r));
  req.emit("data", Buffer.from(JSON.stringify(body)));
  req.emit("end");
  await handled;
  await finished;
  return status;
}

const settingsBody = () => get("/api/transfers/settings");
const topUpNow = async () => (await get("/api/swaps/options?direction=loop_in")).cards.find((c: any) => c.key === "now");

describe("runtime", () => {
  it("runs on Node 20 (the pinned runtime)", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });
});

describe("the default follows channel_role", () => {
  it("merchant: $5 (500 cents), in defaults and in what applies", async () => {
    role("merchant");
    const b = await settingsBody();
    expect(b.member.role, "anti-vacuity: the role was read").toBe("merchant");
    expect(b.defaults.fee_limit_usd_cents).toBe(500);
    expect(b.settings.fee_limit_usd_cents).toBe(500);
  });

  it("farmer: $3 (300 cents)", async () => {
    role("farmer");
    const b = await settingsBody();
    expect(b.defaults.fee_limit_usd_cents).toBe(300);
    expect(b.settings.fee_limit_usd_cents).toBe(300);
  });

  it("unknown: $3, the lower", async () => {
    const b = await settingsBody();
    expect(b.member.role).toBe("unknown");
    expect(b.settings.fee_limit_usd_cents).toBe(300);
  });

  it("the other defaults do not depend on the role ($10 a day in fees, $500 moved)", async () => {
    role("merchant");
    const b = await settingsBody();
    expect(b.defaults).toMatchObject({ strategy: "save", daily_fee_budget_usd_cents: 1_000, max_moved_per_day_usd_cents: 50_000 });
  });
});

describe("a role change", () => {
  it("nothing saved: the default follows the new role", async () => {
    role("farmer");
    expect((await settingsBody()).settings.fee_limit_usd_cents).toBe(300);
    role("merchant");
    expect((await settingsBody()).settings.fee_limit_usd_cents).toBe(500);
  });

  it("a saved figure stays saved across a role change", async () => {
    role("farmer");
    expect(await patch({ fee_limit_usd_cents: 400 })).toBe(200);
    role("merchant");
    const b = await settingsBody();
    expect(b.settings.fee_limit_usd_cents).toBe(400);
    expect(b.stored.fee_limit_usd_cents).toBe(400);
    expect(b.defaults.fee_limit_usd_cents).toBe(500);
  });
});

describe("the option cards take the role from memberRole()", () => {
  // hub(150,000, 840,000): Top Up's amount is 260,000 (the $400 level −
  // 140,000 room to send); fee 1,300 + 2,000 = 3,300 sats = $3.30.
  it("merchant: a $3.30 top-up fee is inside the $5 default", async () => {
    role("merchant");
    hub(150_000, 840_000);
    const now = await topUpNow();
    expect(now.fee_sats).toBe(3_300);
    expect(now.over_fee_limit).toBe(false);
  });

  it("a farmer reading Top Up keeps the farmer's $3: the same fee is over (the role, not the direction, decides)", async () => {
    role("farmer");
    hub(150_000, 840_000);
    const now = await topUpNow();
    expect(now.fee_sats).toBe(3_300);
    expect(now.over_fee_limit).toBe(true);
  });
});
