// kraken-autobuy P4b done-when: "with stubs, a Kraken run goes buy → fill →
// hold → sweep → withdraw poll". Driven through the REAL runTick, exchange.ts,
// krakenProvider.ts and krakenClient.ts; only global fetch (Kraken), the
// valuation, Coinbase's client (which must never be called) and LND are stubbed.
//
// Also pinned here: the per-provider hold (Kraken 7 days, not Coinbase's 72 h),
// every new row's provider, and that polls only touch the ACTIVE provider's rows.

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
  coinbase: vi.fn(() => { throw new Error("Coinbase client called on the Kraken path"); }),
}));

vi.mock("./valuationClient", () => ({ getCurrent: stubs.getCurrent }));
vi.mock("./coinbaseClient", () => ({
  listAccounts: stubs.coinbase,
  placeMarketBuy: stubs.coinbase,
  pollOrder: stubs.coinbase,
  placeWithdraw: stubs.coinbase,
  pollWithdraw: stubs.coinbase,
}));
// The secret is never checked by the fetch stub; the label path is tested in krakenProvider.test.ts.
vi.mock("./credentials", () => ({ decrypt: () => "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==" }));
vi.mock("../lightning/lnd", () => ({ createLndChainAddress: vi.fn(async () => ({ address: "bcrt1qstub" })) }));

import { clientOrderIdFor, runTick } from "./scheduler";

const MIGRATIONS = path.join(__dirname, "../db/migrations");
const METHOD_ID = "d4ec4d52-b159-428e-ba64-f45455a978a1";
const ADDRESS_ID = "ABR6SXP-SF6CY-VJMONY";
const NODE_ADDRESS = "bcrt1qnodeaddress";
const TXID = "OU22CG-KLAF2-FWUDD7";
const WD_ID = "FTVZiTI-e02T84mm87JmibnObWNdnW";
const HASH = "ab".repeat(32);

/** Mon 2030-01-07 12:00:00 UTC. */
const T0 = 1894017600;
const FILLED_AT = T0 + 60;

let db: Database.Database;
type Call = { method: string; path: string; body: string | undefined };
let calls: Call[];
let state: { orderStatus: "open" | "closed"; withdrawalStatus: "pending" | "success" };

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

function krakenFetch(url: string, init: RequestInit = {}): Response {
  const u = new URL(url);
  const c: Call = { method: init.method ?? "GET", path: u.pathname, body: init.body === undefined ? undefined : String(init.body) };
  calls.push(c);
  switch (`${c.method} ${c.path}`) {
    case "POST /0/private/BalanceEx":
      return ok0({ ZUSD: { balance: "1000", hold_trade: "0" }, XXBT: { balance: "0.001", hold_trade: "0" } });
    case "GET /0/public/AssetPairs": return ok0({ XXBTZUSD: { altname: "XBTUSD", ordermin: "0.0001", costmin: "0.5" } });
    case "GET /funding/v1/methods/withdraw": return json({ methods: [{ method_id: METHOD_ID, minimum_amount: "0.000218", fees: {} }] });
    case "POST /0/private/OpenOrders": return ok0({ open: {} });
    case "POST /0/private/ClosedOrders": return ok0({ closed: {}, count: 0 });
    case "POST /0/private/AddOrder": return ok0({ descr: { order: "buy 100.00 XBTUSD @ market" }, txid: [TXID] });
    case "POST /0/private/QueryOrders":
      return ok0({
        [TXID]: state.orderStatus === "open"
          ? { status: "open", vol_exec: "0", cost: "0", fee: "0", opentm: T0 }
          : { status: "closed", vol_exec: "0.00100000", cost: "99.90", fee: "0.10", price: "99900", opentm: T0, closetm: FILLED_AT + 0.4 },
      });
    case `GET /funding/v1/fees/${METHOD_ID}`:
      return json({ fee: { asset: {}, amount: "0.000015" }, gross_amount: { asset: {}, amount: "0.001" }, net_amount: { asset: {}, amount: "0.000985" }, fee_details: {}, withdrawal_fee_token: "TOKEN-1" });
    case "POST /funding/v1/withdrawals":
      return json({
        withdrawal_id: WD_ID,
        net_amount: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.000985" } },
        gross_amount: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.001" } },
        fee: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.000015" } },
      });
    case "GET /funding/v1/withdrawals":
      return json({ withdrawals: [{ withdrawal_id: WD_ID, status: state.withdrawalStatus, amount: { asset: {}, amount: "0.000985" }, fee: { asset: {}, amount: "0.000015" }, address_id: ADDRESS_ID, onchain_transaction: state.withdrawalStatus === "success" ? HASH : undefined }] });
    default:
      throw new Error(`unrouted ${c.method} ${c.path}`);
  }
}

async function tickAt(unixSec: number): Promise<void> {
  vi.setSystemTime(unixSec * 1000);
  await runTick(db);
}

const runs = () => db.prepare(`SELECT id, status, provider, coinbase_order_id, filled_btc, filled_usd, filled_at, withdraw_txid FROM autobuy_runs ORDER BY id`).all() as any[];
const sweeps = () => db.prepare(`SELECT id, status, provider, coinbase_tx_id, btc_amount, withdraw_txid FROM autobuy_sweeps ORDER BY id`).all() as any[];
const pathsSince = (i: number) => calls.slice(i).map((c) => `${c.method} ${c.path}`);

// ONE database for the whole file. krakenNonceSource is one per process and
// binds to the FIRST database it is given; a fresh database per case would
// leave every later case's nonce store pointing at a closed handle, so every
// Kraken call would fail locally before fetch and "no calls" assertions would
// pass vacuously (found by P4b control B6). Rows are reset per case instead.
beforeAll(() => {
  db = buildDb();
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  for (const t of ["autobuy_runs", "autobuy_sweeps", "autobuy_alerts", "kraken_credentials"]) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare(`UPDATE autobuy_config SET consecutive_failures = 0, paused_reason = NULL, zone_multipliers = ? WHERE id = 1`)
    .run(JSON.stringify({ extreme_buy: 3, undervalued: 2, fair_value: 1, elevated: 0.5, overvalued: 0.25, extreme_sell: 0 }));
  calls = [];
  state = { orderStatus: "open", withdrawalStatus: "pending" };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => krakenFetch(url, init)));
  stubs.getCurrent.mockImplementation(async () => ({
    ok: true,
    value: { z_score: -0.4, zone: "fair_value", price_usd: 99900, updated_at: new Date(Date.now()).toISOString() },
  }));
  db.prepare(
    `UPDATE autobuy_config
        SET enabled = 1, provider = 'kraken', base_unit_usd = 100, frequency = 'monthly',
            currency_preference = 'usd_only', withdraw_address = ?, withdraw_address_whitelisted_at = ?,
            sweep_day_of_week = ?, next_run_at = ?
      WHERE id = 1`,
  ).run(NODE_ADDRESS, T0 - 86400, new Date((FILLED_AT + 7 * 86400 + 60) * 1000).getUTCDay(), T0 - 60);
  db.prepare(
    `INSERT INTO kraken_credentials (id, api_key, encrypted_secret, nonce, connected_at, withdraw_method_id, withdraw_address_id)
     VALUES (1, 'PUBLIC-KEY', x'00', x'00', ?, ?, ?)`,
  ).run(T0 - 86400, METHOD_ID, ADDRESS_ID);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("a Kraken run end to end through runTick (stubbed fetch)", () => {
  it("R1 buy → fill → 7-day hold (NOT 72 h) → sweep → withdraw poll → confirmed; every row Kraken's; Coinbase never called", async () => {
    // ── the buy: idempotency lookup, then AddOrder with the slot-keyed cl_ord_id
    await tickAt(T0);
    expect(pathsSince(0)).toEqual([
      "POST /0/private/BalanceEx",
      "GET /0/public/AssetPairs", // STOP 2's minimum (P4c)
      "POST /0/private/OpenOrders",
      "POST /0/private/ClosedOrders",
      "POST /0/private/AddOrder",
      "POST /0/private/QueryOrders",
      "POST /0/private/BalanceEx", // P5: the snapshot, re-read because the buy made the first read stale
    ]);
    const add = calls.find((c) => c.path === "/0/private/AddOrder")!;
    const form = new URLSearchParams(add.body);
    expect(form.get("cl_ord_id")).toBe(clientOrderIdFor("scheduled", T0 - 60));
    expect(form.get("volume")).toBe("100.00");
    expect(form.get("oflags")).toBe("viqc");
    expect(runs()).toMatchObject([{ status: "buy_placed", provider: "kraken", coinbase_order_id: TXID }]);

    // ── the fill
    state.orderStatus = "closed";
    await tickAt(T0 + 900);
    expect(runs()).toMatchObject([{ status: "awaiting_withdraw_hold", filled_btc: 0.001, filled_usd: 100, filled_at: FILLED_AT }]);

    // ── 72 h + 1 min later: Coinbase's hold would have released it; Kraken's has not
    let n = calls.length;
    await tickAt(FILLED_AT + 72 * 3600 + 60);
    expect(runs()[0].status).toBe("awaiting_withdraw_hold");
    expect(pathsSince(n)).not.toContain("POST /funding/v1/withdrawals");

    // ── 7 days + 1 min, on the sweep day: assigned, quoted, withdrawn, polled
    n = calls.length;
    await tickAt(FILLED_AT + 7 * 86400 + 60);
    expect(pathsSince(n)).toEqual([
      "POST /0/private/BalanceEx",
      "GET /funding/v1/methods/withdraw", // STOP 1's minimum (P4c)
      `GET /funding/v1/fees/${METHOD_ID}`,
      "POST /funding/v1/withdrawals",
      "POST /0/private/BalanceEx",
      "GET /funding/v1/withdrawals",
    ]);
    const create = JSON.parse(calls.find((c) => c.method === "POST" && c.path === "/funding/v1/withdrawals")!.body!);
    expect(create).toMatchObject({ address_id: ADDRESS_ID, expected_address: NODE_ADDRESS, fee: { quoted_fee: { token: "TOKEN-1" }, fee_included: true } });
    expect(create.amount.asset_amount.amount).toBe("0.00100000");
    expect(sweeps()).toMatchObject([{ status: "placed", provider: "kraken", coinbase_tx_id: WD_ID, btc_amount: 0.001 }]);
    expect(runs()[0].status).toBe("withdraw_placed");

    // ── the withdraw poll confirms it
    state.withdrawalStatus = "success";
    await tickAt(FILLED_AT + 7 * 86400 + 60 + 900);
    expect(sweeps()).toMatchObject([{ status: "confirmed", withdraw_txid: HASH }]);
    expect(runs()).toMatchObject([{ status: "withdraw_confirmed", withdraw_txid: HASH, provider: "kraken" }]);

    expect(stubs.coinbase).not.toHaveBeenCalled();
    expect(calls.every((c) => c.path.startsWith("/0/") || c.path.startsWith("/funding/v1/"))).toBe(true);
  });

  it("R2 the hold is per row's provider: with Kraken active, a Coinbase row is released at 72 h, a Kraken row only at 7 days", async () => {
    // No buy due, and no sweep day in the window: this case is the hold alone.
    const releaseDow = new Date((FILLED_AT + 7 * 86400) * 1000).getUTCDay();
    db.prepare(`UPDATE autobuy_config SET next_run_at = ?, sweep_day_of_week = ? WHERE id = 1`).run(T0 + 365 * 86400, (releaseDow + 2) % 7); // Wednesday: no tick below falls on it
    const ins = db.prepare(
      `INSERT INTO autobuy_runs (scheduled_for, status, filled_btc, filled_usd, filled_at, created_at, updated_at, provider)
       VALUES (?, 'buy_filled', 0.001, 100, ?, ?, ?, ?)`,
    );
    ins.run(T0, FILLED_AT, T0, T0, "coinbase");
    ins.run(T0, FILLED_AT, T0, T0, "kraken");
    await tickAt(FILLED_AT + 72 * 3600 + 1);
    expect(runs().map((r) => [r.provider, r.status])).toEqual([["coinbase", "sweep_assigned"], ["kraken", "awaiting_withdraw_hold"]]);
    await tickAt(FILLED_AT + 7 * 86400 - 1);
    expect(runs()[1].status).toBe("awaiting_withdraw_hold");
    await tickAt(FILLED_AT + 7 * 86400);
    expect(runs()[1].status).toBe("sweep_assigned");
  });

  it("R3 polls touch only the ACTIVE provider's rows: the Kraken row IS polled, the Coinbase row is not (and Coinbase is not called)", async () => {
    db.prepare(`UPDATE autobuy_config SET next_run_at = ? WHERE id = 1`).run(T0 + 365 * 86400);
    const ins = db.prepare(
      `INSERT INTO autobuy_runs (scheduled_for, status, coinbase_order_id, created_at, updated_at, provider)
       VALUES (?, 'buy_placed', ?, ?, ?, ?)`,
    );
    ins.run(T0, "cb-order-1", T0, T0, "coinbase");
    ins.run(T0, TXID, T0, T0, "kraken");
    db.prepare(
      `INSERT INTO autobuy_sweeps (swept_at, btc_amount, coinbase_tx_id, status, provider) VALUES (?, 0.001, 'cb-tx-1', 'placed', 'coinbase')`,
    ).run(T0);
    await tickAt(T0 + 60);
    // The permitting half: the Kraken row was polled, so the path is live (a
    // dead nonce store or a broken route would fail here, not pass silently).
    const polled = calls.filter((c) => c.path === "/0/private/QueryOrders").map((c) => new URLSearchParams(c.body).get("txid"));
    expect(polled).toEqual([TXID]);
    // The refusing half: nothing else was sent for the Coinbase row or sweep
    // (the one BalanceEx is P5's per-tick snapshot on an enabled Kraken node).
    expect(pathsSince(0)).toEqual(["POST /0/private/QueryOrders", "POST /0/private/BalanceEx"]);
    expect(stubs.coinbase).not.toHaveBeenCalled();
    expect(runs().map((r) => r.status)).toEqual(["buy_placed", "buy_placed"]);
    expect(sweeps()[0].status).toBe("placed");
  });

  it("R4 every row written on the Kraken path carries provider 'kraken' (skipped rows too)", async () => {
    db.prepare(`UPDATE autobuy_config SET zone_multipliers = ? WHERE id = 1`).run(JSON.stringify({ fair_value: 0 }));
    await tickAt(T0);
    expect(runs()).toMatchObject([{ status: "skipped_zero_multiplier", provider: "kraken" }]);
  });
});
