// kraken-autobuy P2: every run the API returns carries its provider and its
// hold end (ruling S2), on GET /api/autobuy/history and on GET
// /api/autobuy/status's `recent` and `in_flight`.
//
// Harness: catchup.route.test.ts's, a synthetic request through the real
// handleRequest, against a temp-dir DB the migration runner builds.
//
// Fixture: one Coinbase run and one Kraken run, both filled at the same
// instant, plus an unfilled scheduled run. The two filled runs' hold ends
// differ by 4 days, so a route that used one constant for both goes red on
// one of them. Expected values are literal seconds, not hold.ts's expressions.

import fs from "fs";
import os from "os";
import path from "path";
import { PassThrough } from "stream";
import type http from "http";
import Database from "better-sqlite3";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-holdend-route-"));
process.env.DB_DIR = TMP_DB;

vi.mock("./valuationClient", () => ({ getCurrent: vi.fn(async () => null) }));
vi.mock("./coinbaseClient", () => ({
  listAccounts: vi.fn(), placeMarketBuy: vi.fn(), pollOrder: vi.fn(), placeWithdraw: vi.fn(), pollWithdraw: vi.fn(),
}));

let handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
let db: Database.Database;

const FILLED_AT = 1894017600;
const COINBASE_HOLD_END = 1894276800; // + 259200
const KRAKEN_HOLD_END = 1894622400;   // + 604800

function get(url: string): Promise<{ status: number; body: any }> {
  const req = new PassThrough() as unknown as http.IncomingMessage;
  (req as any).method = "GET";
  (req as any).url = url;
  (req as any).headers = {};
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
    setImmediate(() => { (req as unknown as PassThrough).end(); });
  });
}

let ids: { coinbase: number; kraken: number; scheduled: number };

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  ({ handleRequest } = await import("../index"));
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  db = new Database(path.join(TMP_DB, "bitcorn.sqlite"));
  db.prepare(
    `INSERT OR REPLACE INTO lnd_node_info (id, pubkey, alias, network, updated_at, node_role)
     VALUES (1, 'pk', 'test', 'regtest', 1, 'member')`,
  ).run();
  db.prepare(`UPDATE autobuy_config SET withdraw_address = 'bcrt1qstub' WHERE id = 1`).run();
  const ins = db.prepare(
    `INSERT INTO autobuy_runs (scheduled_for, status, filled_btc, filled_usd, filled_at, created_at, updated_at, provider)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?)`,
  );
  ids = {
    coinbase: Number(ins.run(FILLED_AT - 600, "awaiting_withdraw_hold", 0.001, 100, FILLED_AT, "coinbase").lastInsertRowid),
    kraken: Number(ins.run(FILLED_AT - 300, "awaiting_withdraw_hold", 0.001, 100, FILLED_AT, "kraken").lastInsertRowid),
    scheduled: Number(ins.run(FILLED_AT + 604800, "scheduled", null, null, null, "kraken").lastInsertRowid),
  };
});

afterAll(() => {
  vi.restoreAllMocks();
  db?.close();
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r]));

function expectHoldFields(rows: any[], where: string): void {
  const r = byId(rows);
  expect([r[ids.coinbase]?.provider, r[ids.coinbase]?.hold_ends_at], `${where} coinbase`).toEqual(["coinbase", COINBASE_HOLD_END]);
  expect([r[ids.kraken]?.provider, r[ids.kraken]?.hold_ends_at], `${where} kraken`).toEqual(["kraken", KRAKEN_HOLD_END]);
  expect(r[ids.scheduled]?.provider, `${where} scheduled`).toBe("kraken");
  expect(r[ids.scheduled], `${where} scheduled`).toHaveProperty("hold_ends_at", null);
}

describe("run rows carry provider and hold_ends_at", () => {
  it("GET /api/autobuy/history: every row", async () => {
    const { status, body } = await get("/api/autobuy/history?limit=50");
    expect(status).toBe(200);
    expect(body.rows).toHaveLength(3);
    expectHoldFields(body.rows, "history");
  });

  it("GET /api/autobuy/status: recent and in_flight (in_flight now includes filled_at)", async () => {
    const { status, body } = await get("/api/autobuy/status");
    expect(status).toBe(200);
    expectHoldFields(body.recent, "recent");
    expectHoldFields(body.in_flight, "in_flight");
    expect(byId(body.in_flight)[ids.kraken].filled_at).toBe(FILLED_AT);
  });
});
