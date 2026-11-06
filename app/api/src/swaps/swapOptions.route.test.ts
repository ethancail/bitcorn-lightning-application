// Drive-mode P3, plan item 4: GET /api/swaps/options.
//   read-only     — no swap_requests row, ever (raw loopd quotes)
//   R25           — the farmer's Max is quote-based: Max + its fee ≤ room to
//                   send − the 50,000 buffer, which is what execute re-checks
//   D3.3          — exactly one card recommended; Top Up shows two cards
//   R32 / R16(3)  — Top Up's amount is the Keep-room-open level − room to send
//   the floor     — room at or below the strategy's floor recommends "now",
//                   even when fees are not calm
//   nothing movable / connection down — no cards
//   R40           — loopd quotes are cached ~60 s
//
// Harness: swapLimits.route.test.ts's (real migrations, temp-dir DB; loopd,
// lnd's wallet, node info and the cached rate stubbed). Rate $100,000/BTC, so
// $1 = 1,000 sats: farmer floors 70,000 / 140,000; merchant 200,000 / 400,000.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-swap-options-"));
process.env.DB_DIR = TMP_DB;
const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;
const ME = "02" + "11".repeat(32);

const live = vi.hoisted(() => ({
  outQuotes: 0,
  inQuotes: 0,
  chain: 100_000_000,
  quoteDown: false,
}));
vi.mock("../lightning/loop", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/loop")>();
  return {
    ...actual,
    getLoopOutTerms: vi.fn(async () => ({ min_swap_amount: 250_000, max_swap_amount: 2_000_000 })),
    getLoopInTerms: vi.fn(async () => ({ min_swap_amount: 100_000, max_swap_amount: 3_000_000 })),
    // 1% swap fee + a 3,000 sweep: the fee grows with the amount.
    getLoopOutQuote: vi.fn(async (amt: number) => {
      live.outQuotes++;
      if (live.quoteDown) throw new Error("loopd down");
      return { swap_fee_sat: Math.ceil(amt / 100), prepay_amt_sat: 30_000, miner_fee: 3_000, total_cost_sats: 0, conf_target: 6, swap_payment_dest: "" };
    }),
    getLoopInQuote: vi.fn(async (amt: number) => {
      live.inQuotes++;
      if (live.quoteDown) throw new Error("loopd down");
      return { swap_fee_sat: Math.ceil(amt / 200), htlc_publish_fee_sat: 2_000, cltv_delta: 0, conf_target: 6, total_cost_sats: 0 };
    }),
  };
});
vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndChainBalance: vi.fn(async () => ({ chain_balance: live.chain })),
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
const { clearSwapOptionsQuoteCache, QUOTE_CACHE_MS, getSwapOptions } = await import("./swapOptions");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

/** A non-funder hub channel (no headroom term): room to send = local − 10,000,
 *  room to receive = remote − 10,000. */
function hub(local: number, remote: number, active: 0 | 1 = 1) {
  db.prepare("DELETE FROM lnd_channels").run();
  db.prepare(`
    INSERT INTO lnd_channels (channel_id, peer_pubkey, capacity_sat, local_balance_sat, remote_balance_sat,
      active, private, updated_at, local_reserve_sat, remote_reserve_sat, commit_fee_sat, commitment_type, is_initiator)
    VALUES ('800000x1x0', ?, 1000000, ?, ?, ?, 0, ?, 10000, 10000, 872, 'anchor', 0)
  `).run(HUB, local, remote, active, Date.now());
}

function settings(o: { strategy?: string; feeUsdCents?: number } = {}) {
  db.prepare("DELETE FROM member_transfer_settings").run();
  db.prepare("INSERT INTO member_transfer_settings (id, strategy, fee_limit_usd_cents) VALUES (1, ?, ?)")
    .run(o.strategy ?? null, o.feeUsdCents ?? null);
}

/** 8 days of 10-minute samples at 10 sat/vB, then a current one. */
function fees(current: number) {
  const now = Date.now();
  for (let i = 8 * 144; i >= 1; i--) {
    db.prepare("INSERT INTO fee_estimate_samples (sampled_at, sat_per_vbyte) VALUES (?, ?)").run(now - i * 600_000, 10);
  }
  db.prepare("INSERT INTO fee_estimate_samples (sampled_at, sat_per_vbyte) VALUES (?, ?)").run(now, current);
}

beforeEach(() => {
  clearSwapOptionsQuoteCache();
  live.outQuotes = 0;
  live.inQuotes = 0;
  live.chain = 100_000_000;
  live.quoteDown = false;
  db.prepare("DELETE FROM swap_requests").run();
  db.prepare("DELETE FROM fee_estimate_samples").run();
  settings();
});

async function options(direction: string): Promise<{ status: number; body: any }> {
  let status = 0;
  let out = "";
  const res: any = { setHeader() {}, writeHead(s: number) { status = s; return res; }, end(c?: string) { if (c) out += c; return res; } };
  await handleRequest({ method: "GET", url: `/api/swaps/options?direction=${direction}`, headers: {} } as any, res);
  return { status, body: JSON.parse(out) };
}

const swapRows = () => (db.prepare("SELECT COUNT(*) AS n FROM swap_requests").get() as { n: number }).n;
const recommended = (b: any) => b.cards.filter((c: any) => c.recommended).map((c: any) => c.key);

describe("read-only", () => {
  it("Withdraw and Top Up options write no swap_requests row", async () => {
    hub(600_000, 390_000);
    expect(swapRows()).toBe(0);
    expect((await options("loop_out")).status).toBe(200);
    expect((await options("loop_in")).status).toBe(200);
    expect(swapRows()).toBe(0);
    expect(live.outQuotes + live.inQuotes, "anti-vacuity: loopd was quoted").toBeGreaterThan(0);
  });

  it("a bad direction is a 400", async () => {
    expect((await options("sideways")).status).toBe(400);
  });
});

describe("R25 — the quote-based Max", () => {
  it("Max + its quoted fee ≤ room to send − 50,000 (here 540,000), and Max is the largest such amount", async () => {
    hub(600_000, 390_000); // room to send 590,000 → spendable 540,000
    const { body } = await options("loop_out");
    const now = body.cards.find((c: any) => c.key === "now");
    expect(now.amount_sats + now.fee_sats).toBeLessThanOrEqual(540_000);
    expect(now.amount_sats).toBe(531_600); // 540,000 − fee(540,000) = 540,000 − 8,400; fee(531,600) = 8,316
    expect(now.fee_sats).toBe(8_316);
    expect(body.quote_state).toBe("ok");
  });

  it("loopd can't quote: the card falls back to today's figure, flagged unavailable", async () => {
    hub(600_000, 390_000);
    live.quoteDown = true;
    const { body } = await options("loop_out");
    expect(body.quote_state).toBe("unavailable");
    expect(body.cards.find((c: any) => c.key === "now").amount_sats).toBe(540_000);
  });
});

describe("D3.3 — exactly one recommended", () => {
  const cases: Array<[string, () => void, string]> = [
    ["farmer, over the fee limit", () => hub(600_000, 390_000), "loop_out"],
    ["farmer, within the limit", () => { hub(600_000, 390_000); settings({ feeUsdCents: 5_000 }); }, "loop_out"],
    ["farmer, at the floor", () => hub(915_000, 75_000), "loop_out"],
    ["merchant, below the floor", () => hub(150_000, 840_000), "loop_in"],
    ["merchant, between floor and level", () => hub(300_000, 690_000), "loop_in"],
    ["merchant, above the level", () => hub(500_000, 490_000), "loop_in"],
    ["merchant, wallet too low", () => { hub(150_000, 840_000); live.chain = 120_000; }, "loop_in"],
  ];
  for (const [why, setup, dir] of cases) {
    it(why, async () => {
      setup();
      const { body } = await options(dir);
      expect(body.cards.length).toBe(2);
      expect(recommended(body).length).toBe(1);
    });
  }
});

describe("the recommendation", () => {
  it("farmer: room at the floor → now, even with fees not calm", async () => {
    hub(915_000, 75_000); // room to receive 65,000 ≤ the 70,000 floor
    fees(50);
    const { body } = await options("loop_out");
    expect(body.calm).toBe("not_calm");
    expect(recommended(body)).toEqual(["now"]);
    expect(body.reason).toBe("room_low");
    expect(body.cards.map((c: any) => c.key)).toEqual(["now", "wait_calm"]);
  });

  it("farmer: over the fee limit → wait for a bigger transfer, and the card says over", async () => {
    hub(600_000, 390_000); // fee 8,316 > the $3 limit (3,000)
    const { body } = await options("loop_out");
    expect(body.cards.find((c: any) => c.key === "now").over_fee_limit).toBe(true);
    expect(recommended(body)).toEqual(["wait_bigger"]);
    expect(body.reason).toBe("over_fee_limit");
  });

  it("calm unknown (under 7 days of samples): the reason never claims fees are low or high", async () => {
    hub(600_000, 390_000);
    settings({ feeUsdCents: 5_000 });
    const { body } = await options("loop_out");
    expect(body.calm).toBe("unknown");
    expect(["fees_low", "fees_high"]).not.toContain(body.reason);
  });

  it("calm, within the limit → now (fees low)", async () => {
    hub(600_000, 390_000);
    settings({ feeUsdCents: 5_000 });
    fees(8);
    const { body } = await options("loop_out");
    expect(recommended(body)).toEqual(["now"]);
    expect(body.reason).toBe("fees_low");
  });

  it("merchant: room to send at the floor → top up now", async () => {
    hub(150_000, 840_000); // room to send 140,000 ≤ 200,000
    fees(50);
    const { body } = await options("loop_in");
    expect(recommended(body)).toEqual(["now"]);
    expect(body.reason).toBe("room_low");
  });

  it("merchant: wallet too low → deposit bitcoin first, and wait", async () => {
    hub(150_000, 840_000);
    live.chain = 120_000;
    const { body } = await options("loop_in");
    expect(body.cards.map((c: any) => c.key)).toEqual(["deposit_first", "wait"]);
    expect(recommended(body)).toEqual(["deposit_first"]);
  });
});

describe("R32 / R16(3) — Top Up's amount", () => {
  it("the Keep-room-open level ($400 = 400,000) − room to send (140,000) = 260,000", async () => {
    hub(150_000, 840_000);
    const { body } = await options("loop_in");
    expect(body.cards.find((c: any) => c.key === "now").amount_sats).toBe(260_000);
  });

  it("capped by room to receive", async () => {
    hub(150_000, 130_000); // room to receive 120,000
    const { body } = await options("loop_in");
    expect(body.cards.find((c: any) => c.key === "now").amount_sats).toBe(120_000);
  });

  it("above the level: Loop's minimum, never below it", async () => {
    hub(500_000, 490_000);
    const { body } = await options("loop_in");
    expect(body.cards.find((c: any) => c.key === "now").amount_sats).toBe(100_000);
  });
});

describe("no cards", () => {
  it("nothing movable (Withdraw): no card, and the trigger for the honest line", async () => {
    hub(200_000, 790_000); // room to send 190,000 − 50,000 < 250,000
    const { body } = await options("loop_out");
    expect(body.state).toBe("nothing_movable");
    expect(body.cards).toEqual([]);
    expect(body.trigger_sats).toBeGreaterThan(250_000);
    expect(live.outQuotes, "nothing to quote").toBe(0);
  });

  it("no card below Loop's minimum on Top Up (the connection can't take 100,000)", async () => {
    hub(150_000, 60_000); // room to receive 50,000
    const { body } = await options("loop_in");
    expect(body.state).toBe("nothing_movable");
    expect(body.cards).toEqual([]);
  });

  it("connection down: no card", async () => {
    hub(600_000, 390_000, 0);
    const { body } = await options("loop_out");
    expect(body.state).toBe("connection_down");
    expect(body.cards).toEqual([]);
  });
});

describe("R40 — loopd quotes are cached ~60 s", () => {
  it("a second read within the window quotes nothing new; after it, it re-quotes", async () => {
    hub(600_000, 390_000);
    const t0 = Date.now();
    await getSwapOptions("loop_out", ME, t0);
    const first = live.outQuotes;
    expect(first).toBeGreaterThan(0);
    await getSwapOptions("loop_out", ME, t0 + 30_000);
    expect(live.outQuotes).toBe(first);
    await getSwapOptions("loop_out", ME, t0 + QUOTE_CACHE_MS + 1);
    expect(live.outQuotes).toBeGreaterThan(first);
  });
});
