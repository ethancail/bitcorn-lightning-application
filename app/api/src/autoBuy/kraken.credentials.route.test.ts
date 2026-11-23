// kraken-autobuy P4d: the Kraken credential routes (POST, DELETE, verify) and
// the setup-time STOP 2 warning, through the real handleRequest against a
// temp-dir DB built by the migration runner, with real credential encryption.
// Only global fetch (Kraken, routed by path) and the valuation are stubbed.
//
//   K1 input refusals          K6 an unverified match is not a match
//   K2 K1's allow-list         K7 ambiguity refuses and stores nothing
//   K3 a refused key           K8 Coinbase active: config untouched
//   K4 a match stores the ids  K9 verify
//   K5 no match stores the key K10 delete      K11 the setup-time warning

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const DIRS = vi.hoisted(() => {
  const fsm = require("fs");
  const p = require("path");
  const o = require("os");
  const dbDir = fsm.mkdtempSync(p.join(o.tmpdir(), "bitcorn-kraken-creds-db-"));
  const secrets = fsm.mkdtempSync(p.join(o.tmpdir(), "bitcorn-kraken-creds-secrets-"));
  process.env.DB_DIR = dbDir;
  process.env.SECRETS_DIR = secrets;
  return { dbDir, secrets } as { dbDir: string; secrets: string };
});

const stubs = vi.hoisted(() => ({ getCurrent: vi.fn() }));
vi.mock("./valuationClient", () => ({ getCurrent: stubs.getCurrent }));
vi.mock("./coinbaseClient", () => ({
  listAccounts: vi.fn(), placeMarketBuy: vi.fn(), pollOrder: vi.fn(), placeWithdraw: vi.fn(), pollWithdraw: vi.fn(),
}));

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let decrypt: typeof import("./credentials").decrypt;
let db: Database.Database;

const SECRET = "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==";
const NODE_ADDRESS = "bcrt1qnodeaddress";
const M_LIGHTNING = "11111111-2222-3333-4444-555555555555";
const M_BITCOIN = "d4ec4d52-b159-428e-ba64-f45455a978a1";
const ADDRESS_ID = "ABR6SXP-SF6CY-VJMONY";
const FIVE = ["query-funds", "query-open-trades", "query-closed-trades", "modify-trades", "withdraw-funds"];

type Call = { method: string; path: string; search: string };
let calls: Call[];
let state: {
  permissions: string[];
  keyInfo?: () => Response;
  methods: string[];
  addresses: Record<string, Array<{ address_id: string; verified: boolean; address: string }>>;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ok0 = (result: unknown) => json({ error: [], result });

function call(method: string, url: string, body?: unknown): Promise<{ status: number; body: any }> {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { "content-type": "application/json" };
  (req as any).socket = { remoteAddress: "127.0.0.1" };
  return new Promise((resolve) => {
    let status = 0;
    let chunks = "";
    const res = {
      setHeader() {}, getHeader() {},
      writeHead(s: number) { status = s; return res; },
      write(c: any) { if (c) chunks += c.toString(); return true; },
      end(c?: any) { if (c) chunks += c.toString(); resolve({ status, body: chunks ? JSON.parse(chunks) : null }); },
    } as unknown as http.ServerResponse;
    void handleRequest(req, res);
    setImmediate(() => { (req as unknown as PassThrough).end(body === undefined ? "" : JSON.stringify(body)); });
  });
}

const save = (over: Record<string, unknown> = {}) =>
  call("POST", "/api/autobuy/kraken/credentials", { api_key: "PUBLIC-KEY", api_secret: SECRET, ...over });
const credsRow = () => db.prepare(`SELECT * FROM kraken_credentials WHERE id = 1`).get() as any;
const config = () => db.prepare(`SELECT provider, enabled, paused_reason, withdraw_address_whitelisted_at FROM autobuy_config WHERE id = 1`).get() as any;
const paths = () => calls.map((c) => `${c.method} ${c.path}`);

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  ({ handleRequest } = await import("../index"));
  ({ decrypt } = await import("./credentials"));
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  db = new Database(path.join(DIRS.dbDir, "bitcorn.sqlite"));
  db.prepare(`INSERT OR REPLACE INTO lnd_node_info (id, pubkey, alias, network, updated_at, node_role) VALUES (1, 'pk', 't', 'regtest', 1, 'member')`).run();
});

afterAll(() => {
  vi.restoreAllMocks();
  db?.close();
  fs.rmSync(DIRS.dbDir, { recursive: true, force: true });
  fs.rmSync(DIRS.secrets, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  state = {
    permissions: [...FIVE],
    methods: [M_LIGHTNING, M_BITCOIN],
    addresses: {
      [M_LIGHTNING]: [{ address_id: "ABLIGHT-NINGA-DDRESS", verified: true, address: "lnbc-not-the-node" }],
      [M_BITCOIN]: [{ address_id: ADDRESS_ID, verified: true, address: NODE_ADDRESS }],
    },
  };
  db.prepare(`DELETE FROM kraken_credentials`).run();
  db.prepare(
    `UPDATE autobuy_config SET provider = 'kraken', enabled = 0, paused_reason = 'no_credentials', withdraw_address = ?,
       withdraw_address_whitelisted_at = NULL, base_unit_usd = 100,
       zone_multipliers = '{"extreme_buy":3,"undervalued":2,"fair_value":1,"elevated":0.5,"overvalued":0.25,"extreme_sell":0}'
     WHERE id = 1`,
  ).run(NODE_ADDRESS);
  stubs.getCurrent.mockResolvedValue({ ok: true, value: { z_score: 0, zone: "fair_value", price_usd: 99900, updated_at: new Date().toISOString() } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const c: Call = { method: init.method ?? "GET", path: u.pathname, search: u.search };
    calls.push(c);
    switch (`${c.method} ${c.path}`) {
      case "POST /0/private/GetApiKeyInfo": return state.keyInfo ? state.keyInfo() : ok0({ permissions: state.permissions, api_key_name: "farm" });
      case "GET /funding/v1/methods/withdraw": return json({ methods: state.methods.map((m) => ({ method_id: m, fees: {} })) });
      case "GET /funding/v1/addresses": {
        const m = u.searchParams.get("scope[method_id]")!;
        return json({ addresses: (state.addresses[m] ?? []).map((a) => ({ ...a, scope: { method_id: m }, address_details: { crypto: { address: a.address } } })) });
      }
      case "POST /0/private/BalanceEx": return ok0({ ZUSD: { balance: "250", hold_trade: "50" }, XXBT: { balance: "0.002", hold_trade: "0" } });
      case "GET /0/public/AssetPairs": return ok0({ XXBTZUSD: { altname: "XBTUSD", ordermin: "0.0001", costmin: "0.5" } });
      default: throw new Error(`unrouted ${c.method} ${c.path}`);
    }
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/autobuy/kraken/credentials", () => {
  it("K1 missing or malformed fields are refused before any Kraken call, and nothing is stored", async () => {
    expect((await save({ api_key: "" })).body).toEqual({ error: "api_key_and_api_secret_required" });
    expect((await save({ api_secret: undefined })).status).toBe(400);
    expect((await save({ api_secret: "not base64!" })).body).toEqual({ error: "invalid_kraken_key_format" });
    expect((await save({ api_secret: "c2hvcnQ=" })).body).toEqual({ error: "invalid_kraken_key_format" }); // decodes to 5 bytes
    expect(calls).toHaveLength(0);
    expect(credsRow()).toBeUndefined();
  });

  it.each([
    ["add-withdraw-address", ["add-withdraw-address"]],
    ["update-withdraw-address", ["update-withdraw-address"]],
    ["query-ledger (any permission outside the five)", ["query-ledger"]],
  ])("K2 a key that also holds %s is refused as too broad; nothing stored, no funding call", async (_name, extra) => {
    state.permissions = [...FIVE, ...extra];
    expect(await save()).toEqual({ status: 400, body: { ok: false, error: "key_permissions_too_broad", extra } });
    expect(credsRow()).toBeUndefined();
    expect(paths()).toEqual(["POST /0/private/GetApiKeyInfo"]);
  });

  it("K2b a key missing one of the five (query-closed-trades, ruling K1) is refused as missing", async () => {
    state.permissions = FIVE.filter((p) => p !== "query-closed-trades");
    expect(await save()).toEqual({ status: 400, body: { ok: false, error: "key_permissions_missing", missing: ["query-closed-trades"] } });
    expect(credsRow()).toBeUndefined();
  });

  it("K3 a key Kraken refuses → 401 verification_failed; an unavailable Kraken → 502; nothing stored", async () => {
    state.keyInfo = () => json({ error: ["EAPI:Invalid key"] });
    expect(await save()).toMatchObject({ status: 401, body: { error: "verification_failed", detail: "EAPI:Invalid key" } });
    state.keyInfo = () => json({ error: ["EService:Unavailable"] });
    expect((await save()).status).toBe(502);
    expect(credsRow()).toBeUndefined();
  });

  it("K4 a verified match on exactly one method: the ids stored, the secret encrypted under kraken-autobuy, the whitelist set, the pause cleared", async () => {
    const r = await save();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, address_status: "matched" });
    const row = credsRow();
    expect(row).toMatchObject({ api_key: "PUBLIC-KEY", withdraw_method_id: M_BITCOIN, withdraw_address_id: ADDRESS_ID });
    expect(decrypt({ ciphertext: row.encrypted_secret, nonce: row.nonce }, "kraken-autobuy")).toBe(SECRET);
    expect(() => decrypt({ ciphertext: row.encrypted_secret, nonce: row.nonce })).toThrow(/credentials_corrupted/); // not under Coinbase's label
    expect(Buffer.from(row.encrypted_secret).toString("utf8")).not.toContain(SECRET.slice(0, 20));
    expect(config()).toMatchObject({ paused_reason: null });
    expect(config().withdraw_address_whitelisted_at).toBeGreaterThan(0);
    // Both methods' address lists were read; the address chose the method.
    expect(calls.filter((c) => c.path === "/funding/v1/addresses").map((c) => new URLSearchParams(c.search).get("scope[method_id]")))
      .toEqual([M_LIGHTNING, M_BITCOIN]);
  });

  it("K5 no saved address matches: the key IS stored with NULL ids (address_status not_found), and /enable refuses", async () => {
    state.addresses[M_BITCOIN] = [];
    expect((await save()).body).toMatchObject({ ok: true, address_status: "not_found" });
    expect(credsRow()).toMatchObject({ withdraw_method_id: null, withdraw_address_id: null });
    expect(config().withdraw_address_whitelisted_at).toBeNull();
    expect(await call("POST", "/api/autobuy/enable")).toEqual({ status: 400, body: { error: "address_not_whitelisted" } });
  });

  it("K6 the node's address saved but NOT verified on Kraken is not a match (address_status not_verified)", async () => {
    state.addresses[M_BITCOIN] = [{ address_id: ADDRESS_ID, verified: false, address: NODE_ADDRESS }];
    expect((await save()).body).toMatchObject({ address_status: "not_verified" });
    expect(credsRow()).toMatchObject({ withdraw_address_id: null });
  });

  it("K7 the address verified under two methods: 409 ambiguous_withdraw_method, nothing stored (D-P4-12)", async () => {
    state.addresses[M_LIGHTNING] = [{ address_id: "ABOTHER-AAAAA-BBBBBB", verified: true, address: NODE_ADDRESS }];
    expect(await save()).toEqual({ status: 409, body: { error: "ambiguous_withdraw_method", method_ids: [M_LIGHTNING, M_BITCOIN] } });
    expect(credsRow()).toBeUndefined();
  });

  it("K8 with Coinbase active, saving a Kraken key leaves the config (whitelist, pause) untouched", async () => {
    db.prepare(`UPDATE autobuy_config SET provider = 'coinbase', withdraw_address_whitelisted_at = 1234, paused_reason = 'no_credentials' WHERE id = 1`).run();
    expect((await save()).status).toBe(200);
    expect(config()).toMatchObject({ provider: "coinbase", withdraw_address_whitelisted_at: 1234, paused_reason: "no_credentials" });
    expect(credsRow()).toMatchObject({ withdraw_address_id: ADDRESS_ID });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("verify and delete", () => {
  it("K9 verify: no key → 400; a key → the lookup re-run, balances and address status returned, last_verified_at set", async () => {
    expect(await call("POST", "/api/autobuy/kraken/credentials/verify")).toEqual({ status: 400, body: { error: "no_credentials" } });
    await save();
    db.prepare(`UPDATE kraken_credentials SET withdraw_method_id = NULL, withdraw_address_id = NULL, last_verified_at = 1 WHERE id = 1`).run();
    const r = await call("POST", "/api/autobuy/kraken/credentials/verify");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, address_status: "matched", balances: { usd: 200, usdc: 0, btc: 0.002 } });
    expect(credsRow()).toMatchObject({ withdraw_address_id: ADDRESS_ID });
    expect(credsRow().last_verified_at).toBeGreaterThan(1);
  });

  it("K9b verify refuses a key whose permissions have since been widened, and changes nothing", async () => {
    await save();
    state.permissions = [...FIVE, "add-withdraw-address"];
    expect(await call("POST", "/api/autobuy/kraken/credentials/verify")).toEqual({
      status: 400, body: { ok: false, error: "key_permissions_too_broad", extra: ["add-withdraw-address"] },
    });
  });

  it("K9c verify with an unreadable secret → 500 credentials_corrupted", async () => {
    await save();
    db.prepare(`UPDATE kraken_credentials SET encrypted_secret = x'00112233445566778899aabbccddeeff00' WHERE id = 1`).run();
    expect(await call("POST", "/api/autobuy/kraken/credentials/verify")).toEqual({ status: 500, body: { error: "credentials_corrupted" } });
  });

  it("K10 delete removes the key; with Kraken active it pauses (no_credentials); with Coinbase active the config is untouched", async () => {
    await save();
    db.prepare(`UPDATE autobuy_config SET enabled = 1, paused_reason = NULL WHERE id = 1`).run();
    expect(await call("DELETE", "/api/autobuy/kraken/credentials")).toEqual({ status: 200, body: { ok: true } });
    expect(credsRow()).toBeUndefined();
    expect(config()).toMatchObject({ enabled: 0, paused_reason: "no_credentials" });

    await save();
    db.prepare(`UPDATE autobuy_config SET provider = 'coinbase', enabled = 1, paused_reason = NULL WHERE id = 1`).run();
    await call("DELETE", "/api/autobuy/kraken/credentials");
    expect(config()).toMatchObject({ enabled: 1, paused_reason: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the setup-time STOP 2 warning (D-P4-13)", () => {
  it("K11 base × the SMALLEST non-zero multiplier vs max(costmin, ordermin × price): below → warned with the figures", async () => {
    db.prepare(`UPDATE autobuy_config SET base_unit_usd = 20 WHERE id = 1`).run(); // 20 × 0.25 = 5 < 9.99
    expect((await save()).body.minimum_warning).toEqual({ below: true, smallest_buy_usd: 5, minimum_usd: 9.99, price_usd: 99900 });
    db.prepare(`UPDATE autobuy_config SET base_unit_usd = 100 WHERE id = 1`).run(); // 25 ≥ 9.99
    expect((await call("POST", "/api/autobuy/kraken/credentials/verify")).body.minimum_warning).toMatchObject({ below: false, smallest_buy_usd: 25 });
  });

  it("K11b PATCH /config carries the warning only while Kraken is active", async () => {
    const k = await call("PATCH", "/api/autobuy/config", { base_unit_usd: 20 });
    expect(k.status).toBe(200);
    expect(k.body.minimum_warning).toMatchObject({ below: true, smallest_buy_usd: 5 });
    db.prepare(`UPDATE autobuy_config SET provider = 'coinbase' WHERE id = 1`).run();
    const c = await call("PATCH", "/api/autobuy/config", { base_unit_usd: 20 });
    expect(c.status).toBe(200);
    expect(c.body).not.toHaveProperty("minimum_warning");
  });

  it("K11c no price → no warning (null), and the save still succeeds", async () => {
    stubs.getCurrent.mockResolvedValue({ ok: false, error: { kind: "unavailable" } });
    const r = await save();
    expect(r.status).toBe(200);
    expect(r.body.minimum_warning).toBeNull();
  });
});
