// kraken-autobuy P4c: the Kraken path's failure behaviour, through the REAL
// runTick / runCatchUp, exchange.ts, krakenProvider.ts and krakenClient.ts.
// Stubbed: global fetch (Kraken, routed by path, overridable per case), the
// valuation, Coinbase's client, LND.
//
//   F1 STOP 1 defers below the method minimum     F6 a failed fee quote sends nothing, retries
//   F2 STOP 2 skips below the pair minimum        F7 approval_request_id → awaiting_approval
//   F3 E9: a USDC preference buys USD             F8 S5: Kraken alerts where Coinbase is silent
//   F4 an unknown buy holds its slot (amend. A)   F9 S5: Coinbase's silent paths stay silent
//   F5 an unknown withdrawal is never re-sent
//
// ONE database for the file: krakenNonceSource binds to the first DB it is
// given (see scheduler.kraken.test.ts; P4b control B6).

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
  listAccounts: vi.fn(),
  placeMarketBuy: vi.fn(),
  pollOrder: vi.fn(),
  placeWithdraw: vi.fn(),
  pollWithdraw: vi.fn(),
}));

vi.mock("./valuationClient", () => ({ getCurrent: stubs.getCurrent }));
vi.mock("./coinbaseClient", () => ({
  listAccounts: stubs.listAccounts,
  placeMarketBuy: stubs.placeMarketBuy,
  pollOrder: stubs.pollOrder,
  placeWithdraw: stubs.placeWithdraw,
  pollWithdraw: stubs.pollWithdraw,
}));
vi.mock("./credentials", () => ({ decrypt: () => "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==" }));
vi.mock("../lightning/lnd", () => ({ createLndChainAddress: vi.fn(async () => ({ address: "bcrt1qstub" })) }));

import { clientOrderIdFor, runCatchUp, runTick } from "./scheduler";

const MIGRATIONS = path.join(__dirname, "../db/migrations");
const METHOD_ID = "d4ec4d52-b159-428e-ba64-f45455a978a1";
const ADDRESS_ID = "ABR6SXP-SF6CY-VJMONY";
const NODE_ADDRESS = "bcrt1qnodeaddress";
const TXID = "OU22CG-KLAF2-FWUDD7";
const WD_ID = "FTVZiTI-e02T84mm87JmibnObWNdnW";
/** Mon 2030-01-07 12:00:00 UTC. */
const T0 = 1894017600;
const MONDAY = 1;
const PRICE = 99900;

let db: Database.Database;
type Call = { method: string; path: string; body: string | undefined };
let calls: Call[];
type Handler = (c: Call) => Response;
let overrides: Record<string, Handler>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok0 = (result: unknown) => json({ error: [], result });
const err0 = (...errors: string[]) => json({ error: errors });

const ORDER_CLOSED = { status: "closed", cl_ord_id: "x", vol_exec: "0.00100000", cost: "99.90", fee: "0.10", opentm: T0, closetm: T0 + 30 };
const CREATED = {
  withdrawal_id: WD_ID,
  net_amount: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.000985" } },
  gross_amount: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.001" } },
  fee: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.000015" } },
};

const DEFAULTS: Record<string, Handler> = {
  "POST /0/private/BalanceEx": () => ok0({ ZUSD: { balance: "1000", hold_trade: "0" }, USDC: { balance: "1000", hold_trade: "0" }, XXBT: { balance: "0.01", hold_trade: "0" } }),
  "GET /0/public/AssetPairs": () => ok0({ XXBTZUSD: { altname: "XBTUSD", ordermin: "0.0001", costmin: "0.5" } }),
  "POST /0/private/OpenOrders": () => ok0({ open: {} }),
  "POST /0/private/ClosedOrders": () => ok0({ closed: {}, count: 0 }),
  "POST /0/private/AddOrder": () => ok0({ descr: { order: "buy" }, txid: [TXID] }),
  "POST /0/private/QueryOrders": () => ok0({ [TXID]: { status: "open", vol_exec: "0", cost: "0", fee: "0", opentm: T0 } }),
  "GET /funding/v1/methods/withdraw": () => json({ methods: [{ method_id: METHOD_ID, minimum_amount: "0.000218", fees: {} }] }),
  [`GET /funding/v1/fees/${METHOD_ID}`]: () => json({ fee: { asset: {}, amount: "0.000015" }, gross_amount: { asset: {}, amount: "0.001" }, net_amount: { asset: {}, amount: "0.000985" }, fee_details: {}, withdrawal_fee_token: "TOKEN-1" }),
  "POST /funding/v1/withdrawals": () => json(CREATED),
  "GET /funding/v1/withdrawals": () => json({ withdrawals: [] }),
};

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

const count = (key: string) => calls.filter((c) => `${c.method} ${c.path}` === key).length;
const runs = () => db.prepare(`SELECT id, status, provider, coinbase_order_id, intended_buy_usd, error_code, currency_used, currencies_checked FROM autobuy_runs ORDER BY id`).all() as any[];
const sweeps = () => db.prepare(`SELECT id, status, provider, coinbase_tx_id, error_code FROM autobuy_sweeps ORDER BY id`).all() as any[];
const alerts = () =>
  (db.prepare(`SELECT type, severity, status, context_json FROM autobuy_alerts ORDER BY id`).all() as any[])
    .map(({ context_json, ...a }) => ({ ...a, context: context_json ? JSON.parse(context_json) : null }));
const active = (type: string) => alerts().filter((a) => a.type === type && a.status === "active");
const config = () => db.prepare(`SELECT enabled, paused_reason, consecutive_failures, next_run_at FROM autobuy_config WHERE id = 1`).get() as any;

/** A run already through its hold, waiting for today's sweep. */
function seedAssigned(btc: number): void {
  db.prepare(
    `INSERT INTO autobuy_runs (scheduled_for, status, filled_btc, filled_usd, filled_at, coinbase_order_id, created_at, updated_at, provider)
     VALUES (?, 'sweep_assigned', ?, 100, ?, 'OLD', ?, ?, 'kraken')`,
  ).run(T0 - 30 * 86400, btc, T0 - 20 * 86400, T0 - 30 * 86400, T0 - 30 * 86400);
}

beforeAll(() => {
  db = buildDb();
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  for (const t of ["autobuy_runs", "autobuy_sweeps", "autobuy_alerts", "kraken_credentials", "coinbase_credentials"]) db.prepare(`DELETE FROM ${t}`).run();
  calls = [];
  overrides = {};
  for (const s of [stubs.listAccounts, stubs.placeMarketBuy, stubs.pollOrder, stubs.placeWithdraw, stubs.pollWithdraw]) {
    s.mockReset();
    s.mockImplementation(() => { throw new Error("Coinbase client called unexpectedly"); });
  }
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const c: Call = { method: init.method ?? "GET", path: u.pathname, body: init.body === undefined ? undefined : String(init.body) };
    calls.push(c);
    const key = `${c.method} ${c.path}`;
    const h = overrides[key] ?? DEFAULTS[key];
    if (!h) throw new Error(`unrouted ${key}`);
    return h(c);
  }));
  stubs.getCurrent.mockImplementation(async () => ({
    ok: true,
    value: { z_score: -0.4, zone: "fair_value", price_usd: PRICE, updated_at: new Date(Date.now()).toISOString() },
  }));
  db.prepare(
    `UPDATE autobuy_config
        SET enabled = 1, provider = 'kraken', base_unit_usd = 100, frequency = 'monthly', consecutive_failures = 0,
            paused_reason = NULL, currency_preference = 'usd_only', withdraw_address = ?, withdraw_address_whitelisted_at = ?,
            sweep_day_of_week = ?, next_run_at = ?,
            zone_multipliers = '{"extreme_buy":3,"undervalued":2,"fair_value":1,"elevated":0.5,"overvalued":0.25,"extreme_sell":0}'
      WHERE id = 1`,
  ).run(NODE_ADDRESS, T0 - 86400, (MONDAY + 3) % 7, T0 - 60);
  db.prepare(
    `INSERT INTO kraken_credentials (id, api_key, encrypted_secret, nonce, connected_at, withdraw_method_id, withdraw_address_id)
     VALUES (1, 'PUBLIC-KEY', x'00', x'00', 1, ?, ?)`,
  ).run(METHOD_ID, ADDRESS_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Make today the sweep day and put the next buy far off, so a tick is a sweep tick. */
function sweepDayOnly(): void {
  db.prepare(`UPDATE autobuy_config SET sweep_day_of_week = ?, next_run_at = ? WHERE id = 1`).run(MONDAY, T0 + 365 * 86400);
}

// ─────────────────────────────────────────────────────────────────────────────
describe("STOP 1 and STOP 2", () => {
  it("F1 a sweep below the method's minimum_amount DEFERS (no quote, no withdrawal, rows untouched); above it, it goes", async () => {
    sweepDayOnly();
    seedAssigned(0.0002); // ≥ SWEEP_MIN_BTC 0.0001, < Kraken's 0.000218
    await tickAt(T0);
    expect(count("GET /funding/v1/methods/withdraw")).toBe(1);
    expect(count(`GET /funding/v1/fees/${METHOD_ID}`)).toBe(0);
    expect(count("POST /funding/v1/withdrawals")).toBe(0);
    expect(runs()[0].status).toBe("sweep_assigned");
    expect(sweeps()).toEqual([]);
    expect(alerts()).toEqual([]);

    db.prepare(`DELETE FROM autobuy_runs`).run();
    seedAssigned(0.0003);
    await tickAt(T0 + 900);
    expect(count("POST /funding/v1/withdrawals")).toBe(1);
    expect(sweeps()).toMatchObject([{ status: "placed", provider: "kraken" }]);
  });

  it("F2 a buy below the pair minimum is skipped (own status, warning), NEVER rounded up, not a failure, next interval scheduled", async () => {
    db.prepare(`UPDATE autobuy_config SET base_unit_usd = 5 WHERE id = 1`).run(); // 5 < 0.0001 × 99 900 = 9.99
    await tickAt(T0);
    expect(count("POST /0/private/AddOrder")).toBe(0);
    expect(runs()).toMatchObject([{ status: "skipped_below_minimum", provider: "kraken", intended_buy_usd: 5, error_code: "minimum_usd=9.99" }]);
    expect(active("AUTOBUY_BUY_BELOW_MINIMUM")).toMatchObject([{ severity: "warning", context: { intended_buy_usd: 5, minimum_usd: 9.99, source: "pre_check" } }]);
    expect(config()).toMatchObject({ consecutive_failures: 0, enabled: 1 });
    expect(config().next_run_at).toBeGreaterThan(T0);
  });

  it("F2b Kraken's own 'minimum not met' refusal takes the same skip: no failed_buy, no failure counted", async () => {
    overrides["POST /0/private/AddOrder"] = () => err0("EOrder:Cost minimum not met");
    await tickAt(T0);
    expect(runs()).toMatchObject([{ status: "skipped_below_minimum", intended_buy_usd: 100 }]);
    expect(active("AUTOBUY_BUY_BELOW_MINIMUM")).toMatchObject([{ context: { source: "exchange_refused", minimum_usd: null } }]);
    expect(config().consecutive_failures).toBe(0);
  });

  it("F3 E9: a usdc_only preference on Kraken buys USD (checked and used)", async () => {
    db.prepare(`UPDATE autobuy_config SET currency_preference = 'usdc_only' WHERE id = 1`).run();
    await tickAt(T0);
    expect(count("POST /0/private/AddOrder")).toBe(1);
    expect(runs()).toMatchObject([{ status: "buy_placed", currency_used: "USD", currencies_checked: "USD" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("unknown outcomes", () => {
  const hang: Handler = () => { throw new TypeError("fetch failed: socket hang up"); };

  it("F4 an unknown buy holds its slot (no row, next_run_at unchanged), counts a failure (amendment A); the next tick finds the order and records it, placed ONCE", async () => {
    overrides["POST /0/private/AddOrder"] = hang;
    await tickAt(T0);
    expect(runs()).toEqual([]);
    expect(config()).toMatchObject({ next_run_at: T0 - 60, consecutive_failures: 1, enabled: 1 });
    expect(active("AUTOBUY_ORDER_FAILED")).toMatchObject([{ severity: "warning", context: { error_code: "outcome_unknown", intended_buy_usd: 100, provider: "kraken" } }]);

    // Kraken did take it: the retry's lookup finds it under the same cl_ord_id.
    const slotId = clientOrderIdFor("scheduled", T0 - 60);
    overrides["POST /0/private/ClosedOrders"] = () => ok0({ closed: { [TXID]: { ...ORDER_CLOSED, cl_ord_id: slotId } }, count: 1 });
    await tickAt(T0 + 900);
    expect(runs()).toMatchObject([{ coinbase_order_id: TXID, provider: "kraken" }]);
    expect(count("POST /0/private/AddOrder")).toBe(1);
    const ids = calls.filter((c) => c.path === "/0/private/ClosedOrders").map((c) => new URLSearchParams(c.body).get("cl_ord_id"));
    expect([...new Set(ids)]).toEqual([slotId]); // every lookup used the same slot-keyed id
  });

  it("F4b amendment A: repeated unknown buys pause Auto-Buy at the failure threshold (3), and then nothing more is sent", async () => {
    overrides["POST /0/private/AddOrder"] = hang;
    for (let i = 0; i < 3; i++) await tickAt(T0 + i * 900);
    expect(config()).toMatchObject({ enabled: 0, paused_reason: "consecutive_failures", consecutive_failures: 3 });
    expect(count("POST /0/private/AddOrder")).toBe(3);
    await tickAt(T0 + 3 * 900);
    expect(count("POST /0/private/AddOrder")).toBe(3);
    expect(runs()).toEqual([]);
  });

  it("F5 an unknown withdrawal (create 502, not listed) ends failed_withdraw/withdraw_outcome_unknown with SWEEP_FAILED, and is NEVER re-sent", async () => {
    sweepDayOnly();
    seedAssigned(0.001);
    overrides["POST /funding/v1/withdrawals"] = () => json({ message: "bad gateway" }, 502);
    await tickAt(T0);
    expect(sweeps()).toMatchObject([{ status: "failed", error_code: "withdraw_outcome_unknown" }]);
    expect(runs()[0].status).toBe("failed_withdraw");
    expect(active("AUTOBUY_SWEEP_FAILED")).toMatchObject([{ severity: "critical", context: { error_code: "withdraw_outcome_unknown" } }]);
    expect(count("GET /funding/v1/withdrawals")).toBeGreaterThanOrEqual(1); // the List check ran
    for (const t of [T0 + 900, T0 + 7 * 86400, T0 + 14 * 86400]) await tickAt(t);
    expect(count("POST /funding/v1/withdrawals")).toBe(1);
  });

  it("F6 a failed fee quote sends nothing: no sweep row, rows still sweep_assigned, a RATE_LIMITED warning; a later tick the same day sweeps", async () => {
    sweepDayOnly();
    seedAssigned(0.001);
    overrides[`GET /funding/v1/fees/${METHOD_ID}`] = () => json({ message: "busy" }, 503);
    await tickAt(T0);
    expect(count("POST /funding/v1/withdrawals")).toBe(0);
    expect(sweeps()).toEqual([]);
    expect(runs()[0].status).toBe("sweep_assigned");
    expect(active("AUTOBUY_RATE_LIMITED")).toMatchObject([{ context: { source: "fee_quote" } }]);
    expect(config().consecutive_failures).toBe(0);
    delete overrides[`GET /funding/v1/fees/${METHOD_ID}`];
    await tickAt(T0 + 900);
    expect(sweeps()).toMatchObject([{ status: "placed" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("approval_request_id (G1)", () => {
  beforeEach(() => {
    sweepDayOnly();
    seedAssigned(0.001);
    overrides["POST /funding/v1/withdrawals"] = () => json({ ...CREATED, approval_request_id: "APR-1" });
    overrides["GET /funding/v1/withdrawals"] = () => json({ withdrawals: [{ withdrawal_id: WD_ID, status: "pending", address_id: ADDRESS_ID }] });
  });

  it("F7 parked → an awaiting_approval sweep and a WARNING; granted (success) → confirmed, the approval alert resolved", async () => {
    await tickAt(T0);
    expect(sweeps()).toMatchObject([{ status: "awaiting_approval", coinbase_tx_id: WD_ID }]);
    expect(runs()[0].status).toBe("withdraw_placed");
    expect(active("AUTOBUY_WITHDRAWAL_AWAITING_APPROVAL")).toMatchObject([{ severity: "warning", context: { withdrawal_id: WD_ID } }]);
    overrides["GET /funding/v1/withdrawals"] = () => json({ withdrawals: [{ withdrawal_id: WD_ID, status: "success", onchain_transaction: "ab".repeat(32) }] });
    await tickAt(T0 + 900);
    expect(sweeps()[0].status).toBe("confirmed");
    expect(runs()[0].status).toBe("withdraw_confirmed");
    expect(active("AUTOBUY_WITHDRAWAL_AWAITING_APPROVAL")).toEqual([]);
  });

  it("F7b parked, then refused (failed) → failed_withdraw with SWEEP_FAILED; the approval alert resolved", async () => {
    await tickAt(T0);
    overrides["GET /funding/v1/withdrawals"] = () => json({ withdrawals: [{ withdrawal_id: WD_ID, status: "failed" }] });
    await tickAt(T0 + 900);
    expect(sweeps()[0].status).toBe("failed");
    expect(runs()[0].status).toBe("failed_withdraw");
    expect(active("AUTOBUY_SWEEP_FAILED")).toHaveLength(1);
    expect(active("AUTOBUY_WITHDRAWAL_AWAITING_APPROVAL")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("S5 — the Kraken path alerts where Coinbase's is silent", () => {
  function seedPlacedSweep(): void {
    db.prepare(`INSERT INTO autobuy_sweeps (swept_at, btc_amount, coinbase_tx_id, status, provider) VALUES (?, 0.001, ?, 'placed', 'kraken')`).run(T0 - 3600, WD_ID);
    db.prepare(`UPDATE autobuy_config SET next_run_at = ? WHERE id = 1`).run(T0 + 365 * 86400);
  }

  it("F8a an order-poll failure → RATE_LIMITED (source order_poll)", async () => {
    db.prepare(`UPDATE autobuy_config SET next_run_at = ? WHERE id = 1`).run(T0 + 365 * 86400);
    db.prepare(`INSERT INTO autobuy_runs (scheduled_for, status, coinbase_order_id, created_at, updated_at, provider) VALUES (?, 'buy_placed', ?, ?, ?, 'kraken')`).run(T0, TXID, T0, T0);
    overrides["POST /0/private/QueryOrders"] = () => err0("EService:Unavailable");
    await tickAt(T0);
    expect(active("AUTOBUY_RATE_LIMITED")).toMatchObject([{ context: { source: "order_poll" } }]);
  });

  it("F8b withdraw poll with no Kraken credentials → paused no_credentials + AUTH_FAILURE", async () => {
    seedPlacedSweep();
    db.prepare(`DELETE FROM kraken_credentials`).run();
    await tickAt(T0);
    expect(config()).toMatchObject({ enabled: 0, paused_reason: "no_credentials" });
    expect(active("AUTOBUY_AUTH_FAILURE")).toMatchObject([{ severity: "critical", context: { paused_reason: "no_credentials", source: "withdraw_poll" } }]);
  });

  it("F8c withdraw poll whose balance read is refused for auth → paused credentials_invalid + AUTH_FAILURE", async () => {
    seedPlacedSweep();
    overrides["POST /0/private/BalanceEx"] = () => err0("EAPI:Invalid key");
    await tickAt(T0);
    expect(config()).toMatchObject({ enabled: 0, paused_reason: "credentials_invalid" });
    expect(active("AUTOBUY_AUTH_FAILURE")).toMatchObject([{ context: { source: "withdraw_poll" } }]);
  });

  it("F8d withdraw poll whose withdrawal lookup fails → RATE_LIMITED (source withdraw_poll)", async () => {
    seedPlacedSweep();
    overrides["GET /funding/v1/withdrawals"] = () => json({ message: "unavailable" }, 503);
    await tickAt(T0);
    expect(active("AUTOBUY_RATE_LIMITED")).toMatchObject([{ context: { source: "withdraw_poll" } }]);
  });

  it("F8e catch-up whose balance read fails → the refusal AND a RATE_LIMITED alert (source catch_up_balance)", async () => {
    vi.setSystemTime(T0 * 1000);
    db.prepare(`UPDATE autobuy_config SET next_run_at = ? WHERE id = 1`).run(T0 + 7 * 86400);
    db.prepare(
      `INSERT INTO autobuy_runs (scheduled_for, base_unit_usd, intended_buy_usd, status, error_code, created_at, updated_at, provider)
       VALUES (?, 100, 100, 'skipped_missed_interval', 'clamped_past_interval', ?, ?, 'kraken')`,
    ).run(T0 - 7 * 86400, T0, T0);
    overrides["POST /0/private/BalanceEx"] = () => err0("EService:Busy");
    const r = await runCatchUp(db, { intervals: 1, usd: 100 });
    expect(r).toMatchObject({ ok: false, code: "account_check_failed" });
    expect(active("AUTOBUY_RATE_LIMITED")).toMatchObject([{ context: { source: "catch_up_balance" } }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("S5 — Coinbase's silent paths stay silent (pinned)", () => {
  beforeEach(() => {
    db.prepare(`UPDATE autobuy_config SET provider = 'coinbase', next_run_at = ? WHERE id = 1`).run(T0 + 365 * 86400);
    db.prepare(`INSERT INTO coinbase_credentials (id, key_name, encrypted_private_key, nonce, connected_at) VALUES (1, 'k', x'00', x'00', 1)`).run();
  });

  it("F9a a Coinbase order-poll failure raises nothing", async () => {
    db.prepare(`INSERT INTO autobuy_runs (scheduled_for, status, coinbase_order_id, created_at, updated_at, provider) VALUES (?, 'buy_placed', 'cb-1', ?, ?, 'coinbase')`).run(T0, T0, T0);
    stubs.pollOrder.mockImplementation(async () => ({ ok: false, status: 503, error: "unavailable" }));
    // The other Coinbase calls record and refuse instead of throwing (P6, P7's
    // tightening, as S4): a Kraken-only step that wrongly ran on Coinbase then
    // fails the `not.toHaveBeenCalled()` below cleanly, not by an exception.
    const others = [stubs.listAccounts, stubs.placeMarketBuy, stubs.placeWithdraw, stubs.pollWithdraw];
    for (const s of others) s.mockImplementation(async () => ({ ok: false, status: 503, error: "coinbase stub: not expected to be called" }));
    await tickAt(T0);
    expect(stubs.pollOrder).toHaveBeenCalledTimes(1);
    for (const s of others) expect(s).not.toHaveBeenCalled();
    expect(alerts()).toEqual([]);
  });

  it("F9b a Coinbase withdraw poll whose balance read is refused (401) raises nothing and does not pause", async () => {
    db.prepare(`INSERT INTO autobuy_sweeps (swept_at, btc_amount, coinbase_tx_id, status, provider) VALUES (?, 0.001, 'cb-tx', 'placed', 'coinbase')`).run(T0 - 3600);
    stubs.listAccounts.mockImplementation(async () => ({ ok: false, status: 401, error: "unauthorized" }));
    await tickAt(T0);
    expect(stubs.listAccounts).toHaveBeenCalledTimes(1);
    expect(alerts()).toEqual([]);
    expect(config()).toMatchObject({ enabled: 1, paused_reason: null });
  });
});
