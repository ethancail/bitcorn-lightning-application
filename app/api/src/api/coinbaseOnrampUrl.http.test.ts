// code-audit-2 S7: GET /api/coinbase/onramp-url no longer persists the onramp
// URL. The URL carries the Coinbase sessionToken, and the row it was written
// into (coinbase_onramp_sessions, migration 019) had no reader anywhere. The
// route must still answer {url, wallet_address} and must write zero rows.
// Red before the removal: the route inserted one row per call.
//
// No network, no LND: the address and the Worker's session token are stubbed.
// The table itself stays (migrations are not rewritten); rows already written
// on deployed nodes are not purged by this change.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-onramp-url-db-"));
process.env.DB_DIR = TMP_DB;
process.env.COINBASE_APP_ID = "test-app-id";
process.env.COINBASE_WORKER_URL = "https://worker.invalid";

const ADDRESS = "bc1qtestaddress0000000000000000000000000";
const TOKEN = "session-token-abc";

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return { ...actual, createLndChainAddress: vi.fn(async () => ({ address: ADDRESS })) };
});
vi.mock("./coinbase-onramp", () => ({ getCoinbaseSessionToken: vi.fn(async () => TOKEN) }));

const { handleRequest } = await import("../index");
// Migrations run from main(), not on import (see memberStatsCertExpiry.http.test.ts).
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

async function get(url: string) {
  const captured = { status: null as number | null, body: "" };
  const res: any = {
    setHeader() {},
    writeHead(status: number) { captured.status = status; return res; },
    end(chunk?: string) { if (chunk) captured.body += chunk; return res; },
  };
  await handleRequest({ method: "GET", url, headers: {} } as any, res);
  return captured;
}

const rows = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM coinbase_onramp_sessions").get() as { n: number }).n;

describe("GET /api/coinbase/onramp-url", () => {
  it("still returns {url, wallet_address}", async () => {
    const out = await get("/api/coinbase/onramp-url");
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body);
    expect(body).toEqual({
      url: `https://pay.coinbase.com/buy/select-asset?appId=test-app-id&sessionToken=${TOKEN}`,
      wallet_address: ADDRESS,
    });
  });

  it("⚠ writes zero rows to coinbase_onramp_sessions", async () => {
    // Counted per call, not as an absolute, so the result does not depend on
    // which test ran first.
    const before = rows();
    const out1 = await get("/api/coinbase/onramp-url");
    const out2 = await get("/api/coinbase/onramp-url");
    expect([out1.status, out2.status]).toEqual([200, 200]);
    expect(rows() - before).toBe(0);
    expect(rows()).toBe(0);
  });
});
