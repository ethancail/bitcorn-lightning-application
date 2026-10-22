// Route-level coverage for forwarded_fees on GET /api/member/stats: the 24h
// and 30d windows.
//
// payments_forwarded.created_at is MILLISECONDS — the sync loop writes
// `new Date(f.created_at).getTime()` (lightning/persist-forwarded.ts). The
// route's cutoffs were computed in seconds, so every row ever recorded sat
// "after" both cutoffs and each window reported the lifetime total. So:
//   - a fee older than 30 days must leave both windows (forbidding);
//   - the lifetime total still counts it, and a fee from an hour ago still
//     counts in both windows — the fix narrows the windows, it does not
//     empty them (permitting).
//
// Harness: memberStatsLifetimeReceived.http.test.ts's. No LND contact: the
// route's two live reads are mocked.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-memberstats-fwdfees-db-"));
process.env.DB_DIR = TMP_DB;

const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndPeers: async () => ({ peers: [{ public_key: HUB }] }),
    isKeysendEnabled: async () => true,
  };
});

vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => ({ node_role: "member", membership_status: "active" }) };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
runMigrations();
const { db } = await import("../db");

async function stats(): Promise<{ status: number | null; body: any }> {
  let status: number | null = null;
  let body = "";
  const res: any = {
    setHeader() {},
    writeHead(s: number) { status = s; return res; },
    end(chunk?: string) { if (chunk) body += chunk; return res; },
  };
  await handleRequest({ method: "GET", url: "/api/member/stats", headers: {} } as any, res);
  return { status, body: JSON.parse(body) };
}

const DAY_MS = 86_400_000;

// created_at in milliseconds, exactly as persist-forwarded.ts writes it.
function forward(incoming: string, outgoing: string, fee: number, createdAtMs: number) {
  db.prepare(
    "INSERT INTO payments_forwarded (incoming_channel, outgoing_channel, tokens, fee, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(incoming, outgoing, 1_000, fee, createdAtMs);
}

beforeEach(() => {
  db.prepare("DELETE FROM payments_forwarded").run();
});

afterAll(() => {
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

describe("GET /api/member/stats → forwarded_fees windows", () => {
  it("a 40-day-old fee leaves both windows; the lifetime total and an hour-old fee still count", async () => {
    const now = Date.now();
    forward("100x1x0", "200x1x0", 7, now - 40 * DAY_MS);
    forward("100x1x0", "200x1x0", 3, now - 3_600_000);

    const out = await stats();
    expect(out.status).toBe(200);
    const fees = out.body.forwarded_fees;

    // Forbidding: the 40-day-old 7 is outside both windows. Soft, so a
    // failure reports both windows rather than stopping at the first.
    expect.soft(fees.last_24h_sats).toBe(3);
    expect.soft(fees.last_30d_sats).toBe(3);

    // Permitting: lifetime still counts both rows; the 1h-old row is 3, not 0.
    expect(fees.total_sats).toBe(10);
  });
});
