// kraken-autobuy P4a: the Kraken adapter (krakenProvider.ts), exchange.ts's
// static branch, and the Kraken classifier.
//
// Real pieces: an in-memory SQLite DB built from EVERY migration, real
// credential encryption under the "kraken-autobuy" label (SECRETS_DIR in a temp
// dir), the real nonce source. Mocked: global fetch only, routed by URL path to
// documented response shapes. No request leaves the process.
//
// One DB for the whole file: krakenNonceSource is one per process and binds to
// the first database it is given.

import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SECRETS = vi.hoisted(() => {
  const dir = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "bitcorn-kraken-provider-"));
  process.env.SECRETS_DIR = dir;
  return dir as string;
});

import { encrypt } from "./credentials";
import * as kraken from "./krakenProvider";
import * as exchange from "./exchange";
import type { ExchangeSession } from "./exchangeProvider";
import type { KrakenFailure } from "./krakenClient";

const MIGRATIONS = path.join(__dirname, "../db/migrations");
const METHOD_ID = "d4ec4d52-b159-428e-ba64-f45455a978a1";
const OTHER_METHOD = "11111111-2222-3333-4444-555555555555";
const ADDRESS_ID = "ABR6SXP-SF6CY-VJMONY";
const NODE_ADDRESS = "bc1qnodeaddress";
const TXID = "OU22CG-KLAF2-FWUDD7";
const SECRET = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==";

function buildDb(maxNumber = Infinity): Database.Database {
  const db = new Database(":memory:");
  for (const f of fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    if (parseInt(f.slice(0, 3), 10) > maxNumber) continue;
    try { db.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8")); } catch (e: any) {
      if (!/duplicate column|already exists/.test(e.message)) throw e;
    }
  }
  return db;
}

let db: Database.Database;
type Call = { method: string; path: string; search: string; body: string | undefined };
let calls: Call[];
type Route = (c: Call) => Response | Promise<Response>;
let routes: Record<string, Route | Route[]>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok0 = (result: unknown) => json({ error: [], result });
const err0 = (...errors: string[]) => json({ error: errors });
const hang: Route = () => new Promise((_, reject) => setTimeout(() => reject(new TypeError("fetch failed: socket hang up")), 0));

const ORDER = { status: "closed", cl_ord_id: "bcab-tx5kq0", vol_exec: "0.00025000", cost: "24.90", fee: "0.10", price: "99600", opentm: 1894017600.1, closetm: 1894017660.9, reason: null };
const WD_CREATED = {
  withdrawal_id: "FTVZiTI-e02T84mm87JmibnObWNdnW",
  net_amount: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.00121456" } },
  gross_amount: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.00123456" } },
  fee: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.00002000" } },
};
const QUOTE = { fee: { asset: {}, amount: "0.00002" }, gross_amount: { asset: {}, amount: "0.00123456" }, net_amount: { asset: {}, amount: "0.00121456" }, fee_details: {}, withdrawal_fee_token: "TOKEN-1" };

beforeAll(() => {
  db = buildDb();
});

afterAll(() => {
  db.close();
  fs.rmSync(SECRETS, { recursive: true, force: true });
});

function seedCredentials(over: { methodId?: string | null; addressId?: string | null } = {}): void {
  const { ciphertext, nonce } = encrypt(SECRET, "kraken-autobuy");
  db.prepare(
    `INSERT OR REPLACE INTO kraken_credentials (id, api_key, encrypted_secret, nonce, connected_at, withdraw_method_id, withdraw_address_id)
     VALUES (1, 'PUBLIC-KEY', ?, ?, 1, ?, ?)`,
  ).run(ciphertext, nonce, over.methodId === undefined ? METHOD_ID : over.methodId, over.addressId === undefined ? ADDRESS_ID : over.addressId);
}

function session(): ExchangeSession {
  const s = kraken.openSession(db);
  if (s.kind !== "ok") throw new Error(`session ${s.kind}`);
  return s.session;
}

beforeEach(() => {
  db.prepare("DELETE FROM kraken_credentials").run();
  db.prepare("UPDATE autobuy_config SET provider = 'coinbase', withdraw_address = ? WHERE id = 1").run(NODE_ADDRESS);
  seedCredentials();
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const c: Call = { method: init.method ?? "GET", path: u.pathname, search: u.search, body: init.body === undefined ? undefined : String(init.body) };
    calls.push(c);
    const key = `${c.method} ${c.path}`;
    const r = routes[key] ?? routes[`${c.method} ${c.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}$/, ":id")}`];
    if (!r) throw new Error(`unrouted ${key}`);
    if (Array.isArray(r)) {
      const next = r.length > 1 ? r.shift()! : r[0];
      return next(c);
    }
    return r(c);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const paths = () => calls.map((c) => `${c.method} ${c.path}`);

// ─────────────────────────────────────────────────────────────────────────────
describe("KA · session and balances", () => {
  it("KA1 openSession: absent with no row; corrupted when the secret does not decrypt under kraken-autobuy; ok otherwise", () => {
    expect(kraken.openSession(db).kind).toBe("ok");
    const coinbaseLabelled = encrypt(SECRET); // the Coinbase label: must NOT decrypt as Kraken's
    db.prepare("UPDATE kraken_credentials SET encrypted_secret = ?, nonce = ? WHERE id = 1").run(coinbaseLabelled.ciphertext, coinbaseLabelled.nonce);
    expect(kraken.openSession(db).kind).toBe("corrupted");
    db.prepare("DELETE FROM kraken_credentials").run();
    expect(kraken.openSession(db).kind).toBe("absent");
  });

  it("KA2 getBalances: available ZUSD / USDC / XXBT; a key Kraken does not list reads 0, never null", async () => {
    routes["POST /0/private/BalanceEx"] = () => ok0({ ZUSD: { balance: "120", hold_trade: "20" }, USDC: { balance: "5", hold_trade: "0" } });
    expect(await kraken.getBalances(session())).toEqual({ ok: true, balances: { usd: 100, usdc: 5, btc: 0 } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("KB · buy, idempotent by client order id", () => {
  const ADD = "POST /0/private/AddOrder";

  it("KB1 an order already carrying the id is returned, and NO AddOrder is sent", async () => {
    routes["POST /0/private/OpenOrders"] = () => ok0({ open: {} });
    routes["POST /0/private/ClosedOrders"] = () => ok0({ closed: { [TXID]: ORDER }, count: 1 });
    expect(await kraken.buy(session(), 25, "USD", "bcab-tx5kq0")).toEqual({ ok: true, orderId: TXID });
    expect(paths()).not.toContain(ADD);
  });

  it("KB2 no such order: AddOrder is sent with the id, and its txid returned", async () => {
    routes["POST /0/private/OpenOrders"] = () => ok0({ open: {} });
    routes["POST /0/private/ClosedOrders"] = () => ok0({ closed: {}, count: 0 });
    routes[ADD] = () => ok0({ descr: { order: "buy 25.00 XBTUSD @ market" }, txid: [TXID] });
    expect(await kraken.buy(session(), 25, "USD", "bcab-tx5kq0")).toEqual({ ok: true, orderId: TXID });
    const add = calls.find((c) => `${c.method} ${c.path}` === ADD)!;
    expect(new URLSearchParams(add.body).get("cl_ord_id")).toBe("bcab-tx5kq0");
    expect(paths()).toEqual(["POST /0/private/OpenOrders", "POST /0/private/ClosedOrders", ADD]);
  });

  it("KB3 USDC and a missing client order id are refused before any call (E9; not_sent)", async () => {
    expect(await kraken.buy(session(), 25, "USDC", "bcab-tx5kq0")).toMatchObject({ ok: false, delivery: "not_sent", detail: expect.stringContaining("kraken_usd_only") });
    expect(await kraken.buy(session(), 25, "USD")).toMatchObject({ ok: false, delivery: "not_sent", detail: "kraken_client_order_id_required" });
    expect(calls).toHaveLength(0);
  });

  it("KB4 an AddOrder that fails ambiguously is looked up again: found → success; not found → delivery unknown; never placed twice", async () => {
    routes["POST /0/private/OpenOrders"] = () => ok0({ open: {} });
    routes["POST /0/private/ClosedOrders"] = [() => ok0({ closed: {}, count: 0 }), () => ok0({ closed: { [TXID]: ORDER }, count: 1 })];
    routes[ADD] = hang;
    expect(await kraken.buy(session(), 25, "USD", "bcab-tx5kq0")).toEqual({ ok: true, orderId: TXID });
    expect(paths().filter((p) => p === ADD)).toHaveLength(1);

    calls = [];
    routes["POST /0/private/ClosedOrders"] = () => ok0({ closed: {}, count: 0 });
    routes[ADD] = () => err0("EService:Unavailable");
    expect(await kraken.buy(session(), 25, "USD", "bcab-tx5kq0")).toMatchObject({ ok: false, delivery: "unknown", errorClass: "rate_limit" });
    expect(paths().filter((p) => p === ADD)).toHaveLength(1);
  });

  it("KB5 a definite refusal is not looked up again; below-minimum refusals carry the marker", async () => {
    routes["POST /0/private/OpenOrders"] = () => ok0({ open: {} });
    routes["POST /0/private/ClosedOrders"] = () => ok0({ closed: {}, count: 0 });
    routes[ADD] = () => err0("EOrder:Insufficient funds");
    const r = await kraken.buy(session(), 25, "USD", "bcab-tx5kq0");
    expect(r).toEqual({ ok: false, errorClass: "other", httpStatus: 200, detail: "EOrder:Insufficient funds" });
    expect(paths()).toEqual(["POST /0/private/OpenOrders", "POST /0/private/ClosedOrders", ADD]);
    routes[ADD] = () => err0("EOrder:Cost minimum not met");
    expect(await kraken.buy(session(), 0.4, "USD", "bcab-tx5kq0")).toMatchObject({ ok: false, belowMinimum: true });
  });

  it("KB6 the pre-placement lookup failing sends nothing (not_sent)", async () => {
    routes["POST /0/private/OpenOrders"] = () => err0("EAPI:Rate limit exceeded");
    expect(await kraken.buy(session(), 25, "USD", "bcab-tx5kq0")).toMatchObject({ ok: false, delivery: "not_sent", errorClass: "rate_limit" });
    expect(paths()).not.toContain(ADD);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("KC · order poll", () => {
  const poll = async (o: Record<string, unknown>) => {
    routes["POST /0/private/QueryOrders"] = () => ok0({ [TXID]: { ...ORDER, ...o } });
    const r = await kraken.getOrder(session(), TXID);
    return r.ok ? r.order : r;
  };

  it("KC1 status mapping; anything executed is a fill (never stranded); USD is cost + fee; time from closetm", async () => {
    expect(await poll({})).toEqual({ state: "filled", rawStatus: "closed", filledBtc: 0.00025, filledUsd: 25, filledAt: 1894017660 });
    expect((await poll({ status: "closed", vol_exec: "0" })).state).toBe("failed");
    expect((await poll({ status: "canceled", vol_exec: "0.0001" })).state).toBe("filled");
    expect((await poll({ status: "canceled", vol_exec: "0" })).state).toBe("cancelled");
    expect((await poll({ status: "expired", vol_exec: "0" })).state).toBe("expired");
    expect((await poll({ status: "open" })).state).toBe("pending");
    expect((await poll({ status: "pending" })).state).toBe("pending");
  });

  it("KC2 an order Kraken does not return is a failure the scheduler retries (other), not a fill", async () => {
    routes["POST /0/private/QueryOrders"] = () => ok0({});
    expect(await kraken.getOrder(session(), TXID)).toMatchObject({ ok: false, errorClass: "other", detail: `order_not_found: ${TXID}` });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("KD · withdrawal", () => {
  const CREATE = "POST /funding/v1/withdrawals";
  const LIST = "GET /funding/v1/withdrawals";

  it("KD1 quote, then create with the quoted token, fee_included=true, address_id, method_id and expected_address", async () => {
    routes["GET /funding/v1/fees/:id"] = () => json(QUOTE);
    routes[CREATE] = () => json(WD_CREATED);
    expect(await kraken.withdraw(session(), NODE_ADDRESS, 0.00123456)).toEqual({ ok: true, withdrawalId: WD_CREATED.withdrawal_id, parked: false });
    expect(calls[0]).toMatchObject({ method: "GET", path: `/funding/v1/fees/${METHOD_ID}`, search: "?amount=0.00123456&fee_included=true" });
    expect(JSON.parse(calls[1].body!)).toEqual({
      scope: { method_id: METHOD_ID },
      address_id: ADDRESS_ID,
      amount: { asset_amount: { asset: { class: "currency", name: "BTC" }, amount: "0.00123456" } },
      fee: { quoted_fee: { token: "TOKEN-1" }, fee_included: true },
      expected_address: NODE_ADDRESS,
    });
  });

  it("KD2 approval_request_id → parked", async () => {
    routes["GET /funding/v1/fees/:id"] = () => json(QUOTE);
    routes[CREATE] = () => json({ ...WD_CREATED, approval_request_id: "APR-1" });
    expect(await kraken.withdraw(session(), NODE_ADDRESS, 0.00123456)).toMatchObject({ ok: true, parked: true });
  });

  it("KD3 a failed quote sends no withdrawal (not_sent); an unresolved address sends nothing at all", async () => {
    routes["GET /funding/v1/fees/:id"] = () => json({ message: "busy" }, 503);
    expect(await kraken.withdraw(session(), NODE_ADDRESS, 0.00123456)).toMatchObject({ ok: false, delivery: "not_sent", errorClass: "rate_limit" });
    expect(paths()).not.toContain(CREATE);
    calls = [];
    seedCredentials({ addressId: null });
    expect(await kraken.withdraw(session(), NODE_ADDRESS, 0.00123456)).toMatchObject({ ok: false, delivery: "not_sent", detail: "kraken_withdraw_address_unresolved" });
    expect(calls).toHaveLength(0);
  });

  it("KD4 an ambiguous create is checked in List Funding Withdrawals: listed → success; not listed → unknown; NEVER sent twice", async () => {
    const listed = { withdrawal_id: "FTlisted-x", amount: { asset: {}, amount: "0.00121456" }, fee: { asset: {}, amount: "0.00002" }, method_id: METHOD_ID, status: "pending", create_time: new Date().toISOString(), address_id: ADDRESS_ID };
    routes["GET /funding/v1/fees/:id"] = () => json(QUOTE);
    routes[CREATE] = hang;
    routes[LIST] = () => json({ withdrawals: [listed] });
    expect(await kraken.withdraw(session(), NODE_ADDRESS, 0.00123456)).toEqual({ ok: true, withdrawalId: "FTlisted-x" });
    expect(paths().filter((p) => p === CREATE)).toHaveLength(1);

    calls = [];
    routes[CREATE] = () => json({ message: "upstream" }, 502);
    routes[LIST] = () => json({ withdrawals: [{ ...listed, address_id: "ABOTHER-AAAAA-BBBBBB" }] });
    expect(await kraken.withdraw(session(), NODE_ADDRESS, 0.00123456)).toMatchObject({ ok: false, delivery: "unknown" });
    expect(paths().filter((p) => p === CREATE)).toHaveLength(1);
  });

  it("KD5 a definite 4xx is not looked up; one mentioning the address is withdraw_address_rejected (D-P4-10), others are other", async () => {
    routes["GET /funding/v1/fees/:id"] = () => json(QUOTE);
    routes[CREATE] = () => json({ errors: [{ message: "expected_address does not match the saved address" }] }, 400);
    expect(await kraken.withdraw(session(), NODE_ADDRESS, 0.00123456)).toMatchObject({ ok: false, errorClass: "withdraw_address_rejected", httpStatus: 400 });
    expect(paths()).not.toContain(LIST);
    routes[CREATE] = () => json({ errors: [{ message: "fee token expired" }] }, 400);
    const r = await kraken.withdraw(session(), NODE_ADDRESS, 0.00123456);
    expect(r).toMatchObject({ ok: false, errorClass: "other", httpStatus: 400 });
    expect(r).not.toHaveProperty("delivery");
  });

  it("KD6 getWithdrawal: success → completed with the hash; failed → failed; pages to find it; never listed → pending", async () => {
    const w = (id: string, status: string) => ({ withdrawal_id: id, status, amount: { asset: {}, amount: "0.001" }, onchain_transaction: status === "success" ? "ab".repeat(32) : undefined });
    routes[LIST] = [() => json({ withdrawals: [w("FTa-1", "pending")], next_cursor: "C2" }), () => json({ withdrawals: [w("FTb-2", "success")] })];
    expect(await kraken.getWithdrawal(session(), "FTb-2")).toEqual({ ok: true, withdrawal: { state: "completed", txHash: "ab".repeat(32) } });
    expect(calls[1].search).toBe("?cursor=C2");
    routes[LIST] = () => json({ withdrawals: [w("FTc-3", "failed")] });
    expect(await kraken.getWithdrawal(session(), "FTc-3")).toMatchObject({ ok: true, withdrawal: { state: "failed" } });
    expect(await kraken.getWithdrawal(session(), "FTzz-9")).toEqual({ ok: true, withdrawal: { state: "pending", txHash: null } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("KE · minimums and policy", () => {
  it("KE1 STOP 1: the larger of 0.0001 and the method's minimum_amount", async () => {
    const methods = (min: string) => () => json({ methods: [{ method_id: OTHER_METHOD, minimum_amount: "0.5", fees: {} }, { method_id: METHOD_ID, minimum_amount: min, fees: {} }] });
    routes["GET /funding/v1/methods/withdraw"] = methods("0.000218");
    expect(await kraken.withdrawalMinimumBtc(session())).toEqual({ ok: true, minimumBtc: 0.000218 });
    routes["GET /funding/v1/methods/withdraw"] = methods("0.00005");
    expect(await kraken.withdrawalMinimumBtc(session())).toEqual({ ok: true, minimumBtc: 0.0001 });
  });

  it("KE2 STOP 2: the larger of costmin and ordermin × price (public AssetPairs)", async () => {
    routes["GET /0/public/AssetPairs"] = () => ok0({ XXBTZUSD: { altname: "XBTUSD", ordermin: "0.0001", costmin: "0.5" } });
    expect(await kraken.buyMinimumUsd(session(), 100_000)).toEqual({ ok: true, minimumUsd: 10 });
    expect(await kraken.buyMinimumUsd(session(), 1_000)).toEqual({ ok: true, minimumUsd: 0.5 });
  });

  it("KE3 policy: Kraken alerts on Coinbase's silent paths, buys USD only, reconciles buys, keeps a balance snapshot (P5)", () => {
    expect(kraken.policy(session())).toEqual({ alertOnSilentPaths: true, usdcBuys: false, reconcileBuys: true, snapshotBalances: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("KF · the classifier", () => {
  const api = (...errors: string[]): KrakenFailure => ({ ok: false, kind: "api_error", httpStatus: 200, errors });
  const http = (s: number): KrakenFailure => ({ ok: false, kind: "http_error", httpStatus: s, body: null, text: "" });

  it.each([
    ["EAPI:Invalid key", "auth"], ["EAPI:Invalid signature", "auth"], ["EAPI:Invalid nonce", "auth"],
    ["EGeneral:Permission denied", "auth"], ["EAccount:Invalid permissions", "auth"],
    ["EAuth:Account temporary disabled", "auth"], ["EAuth:Account unconfirmed", "auth"],
    ["EAPI:Rate limit exceeded", "rate_limit"], ["EOrder:Rate limit exceeded", "rate_limit"], ["EAuth:Too many requests", "rate_limit"],
    ["EService:Unavailable", "rate_limit"], ["EService:Busy", "rate_limit"], ["EService: Throttled: 1894017600", "rate_limit"],
    ["EService:Market in cancel_only mode", "rate_limit"], ["EGeneral:Temporary lockout", "rate_limit"], ["EGeneral:Internal error:5", "rate_limit"],
    ["EOrder:Insufficient funds", "other"], ["EOrder:Order minimum not met", "other"], ["EGeneral:Invalid arguments", "other"], ["EQuery:Unknown asset pair", "other"],
  ])("KF1 %s → %s", (code, cls) => {
    expect(kraken.classifyKrakenFailure(api(code))).toBe(cls);
  });

  it("KF2 HTTP and transport: 401/403 auth; 429/5xx rate_limit; other 4xx other; timeout/network rate_limit; local kinds other", () => {
    expect([401, 403, 429, 500, 503, 520, 400, 404].map((s) => kraken.classifyKrakenFailure(http(s))))
      .toEqual(["auth", "auth", "rate_limit", "rate_limit", "rate_limit", "rate_limit", "other", "other"]);
    expect(kraken.classifyKrakenFailure({ ok: false, kind: "timeout", timeoutMs: 30_000 })).toBe("rate_limit");
    expect(kraken.classifyKrakenFailure({ ok: false, kind: "network", detail: "x" })).toBe("rate_limit");
    for (const kind of ["bad_response", "invalid_request", "local_error"] as const) {
      expect(kraken.classifyKrakenFailure({ ok: false, kind, detail: "x", httpStatus: 200 } as KrakenFailure)).toBe("other");
    }
  });

  it("KF3 an auth code anywhere in the array wins over a transient one", () => {
    expect(kraken.classifyKrakenFailure(api("EService:Busy", "EAPI:Invalid key"))).toBe("auth");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("KX · exchange.ts routes by the active provider (R1 static branch)", () => {
  it("KX1 provider 'kraken': the Kraken session, and its calls go to Kraken", async () => {
    db.prepare("UPDATE autobuy_config SET provider = 'kraken' WHERE id = 1").run();
    const opened = exchange.openSession(db);
    expect(opened.kind === "ok" && opened.session.provider).toBe("kraken");
    routes["POST /0/private/BalanceEx"] = () => ok0({ ZUSD: { balance: "7", hold_trade: "0" } });
    expect(await exchange.getBalances((opened as { session: ExchangeSession }).session)).toEqual({ ok: true, balances: { usd: 7, usdc: 0, btc: 0 } });
    routes["POST /0/private/OpenOrders"] = () => ok0({ open: {} });
    routes["POST /0/private/ClosedOrders"] = () => ok0({ closed: { [TXID]: ORDER }, count: 1 });
    expect(await exchange.buy((opened as { session: ExchangeSession }).session, 25, "USD", "bcab-tx5kq0")).toEqual({ ok: true, orderId: TXID });
    expect(exchange.policy((opened as { session: ExchangeSession }).session).usdcBuys).toBe(false);
    expect(calls.every((c) => c.path.startsWith("/0/"))).toBe(true);
  });

  it("KX2 provider 'coinbase' (the default) opens Coinbase's session, never Kraken's", () => {
    const opened = exchange.openSession(db);
    expect(opened.kind).toBe("absent"); // no coinbase_credentials row in this DB: Coinbase's answer, not Kraken's "ok"
    const pem = encrypt("pem");
    db.prepare(
      `INSERT INTO coinbase_credentials (id, key_name, encrypted_private_key, nonce, connected_at) VALUES (1, 'k', ?, ?, 1)`,
    ).run(pem.ciphertext, pem.nonce);
    const cb = exchange.openSession(db);
    expect(cb.kind === "ok" && cb.session.provider).toBe("coinbase");
    db.prepare("DELETE FROM coinbase_credentials").run();
  });

  it("KX3 a database without migration 084 reads as Coinbase (the P0 scheduler suites' schema)", () => {
    const old = buildDb(54);
    expect(exchange.activeProvider(old)).toBe("coinbase");
    old.close();
  });
});
