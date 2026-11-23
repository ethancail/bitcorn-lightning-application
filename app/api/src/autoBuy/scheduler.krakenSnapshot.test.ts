// kraken-autobuy P5: the balance snapshot and the low-funds warning, through
// the REAL runTick, exchange.ts, krakenProvider.ts and krakenClient.ts.
// Stubbed: global fetch (Kraken, routed by path, overridable), the valuation,
// Coinbase's client (must never be called on the Kraken path), LND.
//
//   S1 a quiet tick: exactly one BalanceEx, the snapshot written (buying power)
//   S2 a tick that already read reuses it: no second BalanceEx
//   S3 an hour of quiet ticks: 4 BalanceEx (≈4 an hour, S3)
//   S4 Coinbase active, or Kraken paused: no call, no snapshot
//   L1 fewer than 2 buys covered → AUTOBUY_LOW_FUNDS (warning), before any buy is due
//   L2 the CURRENT multiplier decides (2× warns, 0.25× does not)
//   L3 USD only: USDC never counts on Kraken
//   L4 once per episode, cleared by funds_ok when 2+ are covered
//   L5 never from a stale snapshot; never in a zone that buys nothing
//
// ONE database for the file: krakenNonceSource binds to the first DB it is
// given (scheduler.kraken.test.ts; P4b control B6).

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AUTOBUY_ENABLED = "true";
  process.env.AUTOBUY_MAX_SINGLE_BUY_USD = "1000";
  process.env.AUTOBUY_MAX_7D_USD = "2000";
  process.env.AUTOBUY_MAX_30D_USD = "5000";
  process.env.AUTOBUY_STALE_DATA_MAX_HOURS = "48";
  process.env.AUTOBUY_FAILURE_PAUSE_THRESHOLD = "3";
});

const stubs = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  coinbase: vi.fn(() => { throw new Error("Coinbase client called"); }),
}));

vi.mock("./valuationClient", () => ({ getCurrent: stubs.getCurrent }));
vi.mock("./coinbaseClient", () => ({
  listAccounts: stubs.coinbase, placeMarketBuy: stubs.coinbase, pollOrder: stubs.coinbase,
  placeWithdraw: stubs.coinbase, pollWithdraw: stubs.coinbase,
}));
vi.mock("./credentials", () => ({ decrypt: () => "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==" }));
vi.mock("../lightning/lnd", () => ({ createLndChainAddress: vi.fn(async () => ({ address: "bcrt1qstub" })) }));

import { runTick } from "./scheduler";

const MIGRATIONS = path.join(__dirname, "../db/migrations");
const METHOD_ID = "d4ec4d52-b159-428e-ba64-f45455a978a1";
const ADDRESS_ID = "ABR6SXP-SF6CY-VJMONY";
const WD_ID = "FTVZiTI-e02T84mm87JmibnObWNdnW";
/** Mon 2030-01-07 12:00:00 UTC. */
const T0 = 1894017600;
const MULTIPLIERS = { extreme_buy: 3, undervalued: 2, fair_value: 1, elevated: 0.5, overvalued: 0.25, extreme_sell: 0 };

let db: Database.Database;
let calls: string[];
let balance: { usd: string; usdc: string; btc: string };
let zone: string;
let balanceFails: boolean;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok0 = (result: unknown) => json({ error: [], result });

function buildDb(): Database.Database {
  const d = new Database(":memory:");
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    try { d.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8")); } catch (e: any) {
      if (!/duplicate column|already exists/.test(e.message)) throw e;
    }
  }
  return d;
}

async function tickAt(unixSec: number): Promise<void> {
  vi.setSystemTime(unixSec * 1000);
  await runTick(db);
}

const balanceReads = () => calls.filter((c) => c === "POST /0/private/BalanceEx").length;
const snapshot = () => db.prepare(`SELECT * FROM autobuy_balance_snapshot`).all() as any[];
const lowFunds = () =>
  (db.prepare(`SELECT severity, status, consecutive_count, context_json FROM autobuy_alerts WHERE type = 'AUTOBUY_LOW_FUNDS' ORDER BY id`).all() as any[])
    .map(({ context_json, ...a }) => ({ ...a, context: JSON.parse(context_json) }));

beforeAll(() => {
  db = buildDb();
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  for (const t of ["autobuy_runs", "autobuy_sweeps", "autobuy_alerts", "autobuy_balance_snapshot", "kraken_credentials"]) db.prepare(`DELETE FROM ${t}`).run();
  calls = [];
  balance = { usd: "1000", usdc: "0", btc: "0" };
  zone = "fair_value";
  balanceFails = false;
  stubs.coinbase.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    calls.push(key);
    switch (key) {
      case "POST /0/private/BalanceEx":
        return balanceFails
          ? json({ error: ["EService:Unavailable"] })
          : ok0({ ZUSD: { balance: balance.usd, hold_trade: "0" }, USDC: { balance: balance.usdc, hold_trade: "0" }, XXBT: { balance: balance.btc, hold_trade: "0" } });
      case "GET /funding/v1/withdrawals":
        return json({ withdrawals: [{ withdrawal_id: WD_ID, status: "pending", address_id: ADDRESS_ID }] });
      default:
        throw new Error(`unrouted ${key}`);
    }
  }));
  stubs.getCurrent.mockImplementation(async () => ({
    ok: true,
    value: { z_score: 0, zone, price_usd: 99900, updated_at: new Date(Date.now()).toISOString() },
  }));
  // Enabled Kraken node, nothing due: no buy for a year, no sweep day this week.
  db.prepare(
    `UPDATE autobuy_config
        SET enabled = 1, provider = 'kraken', base_unit_usd = 100, frequency = 'monthly', consecutive_failures = 0,
            paused_reason = NULL, currency_preference = 'usd_only', withdraw_address = 'bcrt1qnode',
            withdraw_address_whitelisted_at = 1, sweep_day_of_week = 4, next_run_at = ?, zone_multipliers = ?
      WHERE id = 1`,
  ).run(T0 + 365 * 86400, JSON.stringify(MULTIPLIERS));
  db.prepare(
    `INSERT INTO kraken_credentials (id, api_key, encrypted_secret, nonce, connected_at, withdraw_method_id, withdraw_address_id)
     VALUES (1, 'PUBLIC-KEY', x'00', x'00', 1, ?, ?)`,
  ).run(METHOD_ID, ADDRESS_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the snapshot (S3, Q1)", () => {
  it("S1 a quiet tick on an enabled Kraken node: exactly one BalanceEx, and the snapshot stores buying power at read_at", async () => {
    balance = { usd: "1000", usdc: "40", btc: "0.002" };
    await tickAt(T0);
    expect(calls).toEqual(["POST /0/private/BalanceEx"]);
    expect(snapshot()).toEqual([{ provider: "kraken", usd_available: 1000, usdc_available: 40, btc_available: 0.002, read_at: T0 }]);
  });

  it("S2 a tick that already read balances (a withdraw poll) reuses that read: no second BalanceEx", async () => {
    db.prepare(`INSERT INTO autobuy_sweeps (swept_at, btc_amount, coinbase_tx_id, status, provider) VALUES (?, 0.001, ?, 'placed', 'kraken')`).run(T0 - 3600, WD_ID);
    await tickAt(T0);
    expect(calls).toEqual(["POST /0/private/BalanceEx", "GET /funding/v1/withdrawals"]);
    expect(balanceReads()).toBe(1);
    expect(snapshot()[0].read_at).toBe(T0);
  });

  it("S3 an hour of quiet 15-minute ticks makes 4 BalanceEx calls (the ≈4 an hour S3 predicts)", async () => {
    for (let i = 0; i < 4; i++) await tickAt(T0 + i * 900);
    expect(balanceReads()).toBe(4);
    expect(snapshot()[0].read_at).toBe(T0 + 3 * 900);
  });

  it("S4 Coinbase active, or Kraken paused: no Kraken call, no snapshot (Coinbase unchanged)", async () => {
    db.prepare(`UPDATE autobuy_config SET provider = 'coinbase' WHERE id = 1`).run();
    await tickAt(T0);
    expect(calls).toEqual([]);
    expect(stubs.coinbase).not.toHaveBeenCalled();
    expect(snapshot()).toEqual([]);

    db.prepare(`UPDATE autobuy_config SET provider = 'kraken', enabled = 0, paused_reason = 'user_paused' WHERE id = 1`).run();
    await tickAt(T0 + 900);
    expect(calls).toEqual([]);
    expect(snapshot()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the low-funds warning (E3, G3)", () => {
  it("L1 USD covering fewer than 2 next buys raises AUTOBUY_LOW_FUNDS, a WARNING, with no buy due", async () => {
    balance = { usd: "150", usdc: "0", btc: "0" }; // next buy 100 → covers 1
    await tickAt(T0);
    expect(lowFunds()).toEqual([{
      severity: "warning", status: "active", consecutive_count: 1,
      context: { currency: "USD", usd_available: 150, next_buy_usd: 100, buys_covered: 1, multiplier: 1, read_at: T0 },
    }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM autobuy_runs`).get()).toEqual({ n: 0 }); // no buy happened
  });

  it("L1b exactly 2 buys covered does not warn", async () => {
    balance = { usd: "200", usdc: "0", btc: "0" };
    await tickAt(T0);
    expect(lowFunds()).toEqual([]);
  });

  it("L2 the CURRENT multiplier decides: $300 at 2× (next $200) warns; $60 at 0.25× (next $25) does not", async () => {
    balance = { usd: "300", usdc: "0", btc: "0" };
    zone = "undervalued";
    await tickAt(T0);
    expect(lowFunds()).toMatchObject([{ context: { next_buy_usd: 200, buys_covered: 1, multiplier: 2 } }]);

    db.prepare(`DELETE FROM autobuy_alerts`).run();
    balance = { usd: "60", usdc: "0", btc: "0" };
    zone = "overvalued";
    await tickAt(T0 + 900);
    expect(lowFunds()).toEqual([]);
  });

  it("L3 USD only: $50 USD with $1,000 USDC still warns (USDC never counts on Kraken)", async () => {
    balance = { usd: "50", usdc: "1000", btc: "0" };
    await tickAt(T0);
    expect(lowFunds()).toMatchObject([{ context: { currency: "USD", usd_available: 50, buys_covered: 0 } }]);
  });

  it("L4 raised once per episode (no count creep), and cleared by funds_ok once 2+ buys are covered", async () => {
    balance = { usd: "150", usdc: "0", btc: "0" };
    for (let i = 0; i < 3; i++) await tickAt(T0 + i * 900);
    expect(lowFunds()).toMatchObject([{ status: "active", consecutive_count: 1 }]);
    balance = { usd: "500", usdc: "0", btc: "0" };
    await tickAt(T0 + 3 * 900);
    expect(lowFunds()).toMatchObject([{ status: "resolved" }]);
  });

  it("L5 never from a STALE snapshot (a failed read leaves a 2-hour-old low one): no warning, and the read failure alerts instead", async () => {
    db.prepare(`INSERT INTO autobuy_balance_snapshot (provider, usd_available, usdc_available, btc_available, read_at) VALUES ('kraken', 10, 0, 0, ?)`).run(T0 - 7200);
    balanceFails = true;
    await tickAt(T0);
    expect(lowFunds()).toEqual([]);
    const rl = db.prepare(`SELECT context_json FROM autobuy_alerts WHERE type = 'AUTOBUY_RATE_LIMITED' AND status = 'active'`).get() as { context_json: string };
    expect(JSON.parse(rl.context_json)).toMatchObject({ source: "balance_snapshot" });
  });

  it("L5b a zone that buys nothing (multiplier 0) neither warns nor clears", async () => {
    balance = { usd: "1", usdc: "0", btc: "0" };
    zone = "extreme_sell";
    await tickAt(T0);
    expect(lowFunds()).toEqual([]);
  });
});
