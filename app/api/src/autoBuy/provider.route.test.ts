// kraken-autobuy P4b: POST /api/autobuy/provider (the switch and D2's drain
// guard, rulings D-P4-2/-4/-7) and POST /api/autobuy/enable on the ACTIVE
// provider's credentials. Driven through the real handleRequest, against a
// temp-dir DB built by the migration runner (catchup.route.test.ts's harness).
//
// Also: a STRUCTURAL check that every INSERT into autobuy_runs/autobuy_sweeps
// in the API source names the provider column explicitly.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import Database from "better-sqlite3";
import ts from "typescript";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-provider-route-"));
process.env.DB_DIR = TMP_DB;

vi.mock("./valuationClient", () => ({ getCurrent: vi.fn(async () => ({ ok: false, error: { kind: "unavailable" } })) }));
vi.mock("./coinbaseClient", () => ({
  listAccounts: vi.fn(), placeMarketBuy: vi.fn(), pollOrder: vi.fn(), placeWithdraw: vi.fn(), pollWithdraw: vi.fn(),
}));

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let db: Database.Database;

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

const config = () => db.prepare(`SELECT provider, enabled, paused_reason, withdraw_address, withdraw_address_whitelisted_at FROM autobuy_config WHERE id = 1`).get() as any;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handleRequest } = await import("../index"));
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  db = new Database(path.join(TMP_DB, "bitcorn.sqlite"));
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info (id, pubkey, alias, network, updated_at, node_role) VALUES (1, 'pk', 'test', 'regtest', 1, 'member')`,
  ).run();
});

afterAll(() => {
  vi.restoreAllMocks();
  db?.close();
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare(`DELETE FROM autobuy_runs`).run();
  db.prepare(`DELETE FROM autobuy_sweeps`).run();
  db.prepare(`DELETE FROM coinbase_credentials`).run();
  db.prepare(`DELETE FROM kraken_credentials`).run();
  db.prepare(
    `UPDATE autobuy_config SET provider = 'coinbase', enabled = 1, paused_reason = NULL,
       withdraw_address = 'bcrt1qnode', withdraw_address_whitelisted_at = 1000 WHERE id = 1`,
  ).run();
});

const IN_FLIGHT_RUNS = ["buy_placed", "buy_filled", "awaiting_withdraw_hold", "sweep_assigned", "withdraw_placed"];
const SETTLED_RUNS = ["scheduled", "withdraw_confirmed", "failed_buy", "failed_withdraw", "skipped_zero_multiplier", "skipped_missed_interval", "skipped_below_minimum"];

describe("POST /api/autobuy/provider — the switch and the drain guard", () => {
  it("P1 refuses anything but coinbase|kraken (400) and changes nothing", async () => {
    for (const bad of [undefined, "binance", "", 7]) {
      expect((await call("POST", "/api/autobuy/provider", { provider: bad })).status).toBe(400);
    }
    expect(config().provider).toBe("coinbase");
  });

  it("P2 the current provider again: 200 with changed=false, and nothing is paused or cleared", async () => {
    expect(await call("POST", "/api/autobuy/provider", { provider: "coinbase" })).toEqual({ status: 200, body: { ok: true, provider: "coinbase", changed: false } });
    expect(config()).toMatchObject({ enabled: 1, paused_reason: null, withdraw_address_whitelisted_at: 1000 });
  });

  it.each(IN_FLIGHT_RUNS)("P3 a run in %s refuses the switch (409) and leaves the provider", async (status) => {
    db.prepare(`INSERT INTO autobuy_runs (scheduled_for, status, created_at, updated_at, provider) VALUES (1, ?, 1, 1, 'coinbase')`).run(status);
    const r = await call("POST", "/api/autobuy/provider", { provider: "kraken" });
    expect(r).toEqual({ status: 409, body: { error: "provider_switch_in_flight", in_flight_runs: 1, in_flight_sweeps: 0 } });
    expect(config()).toMatchObject({ provider: "coinbase", enabled: 1 });
  });

  it.each(["placed", "awaiting_approval"])("P4 a sweep in %s refuses the switch (409)", async (status) => {
    db.prepare(`INSERT INTO autobuy_sweeps (swept_at, btc_amount, status, provider) VALUES (1, 0.001, ?, 'coinbase')`).run(status);
    expect(await call("POST", "/api/autobuy/provider", { provider: "kraken" })).toEqual({
      status: 409, body: { error: "provider_switch_in_flight", in_flight_runs: 0, in_flight_sweeps: 1 },
    });
  });

  it("P5 with only settled rows: the switch happens, Auto-Buy is paused (provider_changed), the whitelist is cleared, the address kept", async () => {
    for (const s of SETTLED_RUNS) db.prepare(`INSERT INTO autobuy_runs (scheduled_for, status, created_at, updated_at, provider) VALUES (1, ?, 1, 1, 'coinbase')`).run(s);
    for (const s of ["confirmed", "failed"]) db.prepare(`INSERT INTO autobuy_sweeps (swept_at, btc_amount, status, provider) VALUES (1, 0.001, ?, 'coinbase')`).run(s);
    expect(await call("POST", "/api/autobuy/provider", { provider: "kraken" })).toEqual({ status: 200, body: { ok: true, provider: "kraken", changed: true } });
    expect(config()).toEqual({ provider: "kraken", enabled: 0, paused_reason: "provider_changed", withdraw_address: "bcrt1qnode", withdraw_address_whitelisted_at: null });
  });
});

describe("POST /api/autobuy/enable checks the ACTIVE provider's credentials", () => {
  const seedKraken = (addressId: string | null) =>
    db.prepare(
      `INSERT INTO kraken_credentials (id, api_key, encrypted_secret, nonce, connected_at, withdraw_method_id, withdraw_address_id)
       VALUES (1, 'k', x'00', x'00', 1, 'd4ec4d52-b159-428e-ba64-f45455a978a1', ?)`,
    ).run(addressId);
  const seedCoinbase = () =>
    db.prepare(`INSERT INTO coinbase_credentials (id, key_name, encrypted_private_key, nonce, connected_at) VALUES (1, 'k', x'00', x'00', 1)`).run();

  it("E1 Kraken active: no Kraken key → no_credentials, even with a Coinbase key present", async () => {
    seedCoinbase();
    db.prepare(`UPDATE autobuy_config SET provider = 'kraken', enabled = 0 WHERE id = 1`).run();
    expect(await call("POST", "/api/autobuy/enable")).toEqual({ status: 400, body: { error: "no_credentials" } });
  });

  it("E2 Kraken active: a key whose address was never matched → address_not_whitelisted", async () => {
    seedKraken(null);
    db.prepare(`UPDATE autobuy_config SET provider = 'kraken', enabled = 0 WHERE id = 1`).run();
    expect(await call("POST", "/api/autobuy/enable")).toEqual({ status: 400, body: { error: "address_not_whitelisted" } });
  });

  it("E3 Kraken active: a matched key and a whitelisted address → enabled", async () => {
    seedKraken("ABR6SXP-SF6CY-VJMONY");
    db.prepare(`UPDATE autobuy_config SET provider = 'kraken', enabled = 0 WHERE id = 1`).run();
    expect(await call("POST", "/api/autobuy/enable")).toEqual({ status: 200, body: { ok: true, enabled: true } });
  });

  it("E4 Coinbase active: a Kraken key does not count", async () => {
    seedKraken("ABR6SXP-SF6CY-VJMONY");
    db.prepare(`UPDATE autobuy_config SET enabled = 0 WHERE id = 1`).run();
    expect(await call("POST", "/api/autobuy/enable")).toEqual({ status: 400, body: { error: "no_credentials" } });
    seedCoinbase();
    expect((await call("POST", "/api/autobuy/enable")).status).toBe(200);
  });
});

describe("every INSERT into autobuy_runs / autobuy_sweeps writes provider explicitly (P4b)", () => {
  it("S1 the API source (tests excluded) has no insert into either table that omits the provider column", () => {
    const SRC = path.join(__dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) files.push(p);
      }
    };
    walk(SRC);
    const INSERT = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(autobuy_runs|autobuy_sweeps)\s*\(([^)]*)\)/gi;
    const found: string[] = [];
    const missing: string[] = [];
    for (const f of files) {
      const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node) => {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
          const text = n.getText();
          for (const m of text.matchAll(INSERT)) {
            const where = `${path.relative(SRC, f)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${m[1]}`;
            found.push(where);
            if (!m[2].split(",").map((c) => c.trim()).includes("provider")) missing.push(where);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(found.length, "the scan must find the scheduler's seven inserts (not a vacuous pass)").toBeGreaterThanOrEqual(7);
    expect(missing, "inserts that omit provider:").toEqual([]);
  });
});
