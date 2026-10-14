// Route-level coverage for lifetime_received_sats on GET /api/member/stats
// (P6-1, PR 6): the farmer dashboard's "Received, lifetime" detail.
//
// It is SUM(tokens) over payments_inbound — every settled inbound invoice the
// sync loop has recorded — so it must:
//   - read 0 on a node that has received nothing (a real zero, not a missing
//     field: the web shows "—" only when the field is absent);
//   - sum every row, not count them, and not only the app-made invoices that
//     network_payments links (that table marks a receipt settled only after
//     the Payments page runs its settlement sync);
//   - stay on the route's SQLite side, so it is there during an LND fault.
//
// Harness: memberStatsCertExpiry.http.test.ts's, trimmed. No LND contact: the
// route's two live reads are mocked.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-memberstats-received-db-"));
process.env.DB_DIR = TMP_DB;

const HUB = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";
process.env.TREASURY_PUBKEY = HUB;

const lndState = vi.hoisted(() => ({ throws: false }));

vi.mock("../lightning/lnd", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lightning/lnd")>();
  return {
    ...actual,
    getLndPeers: async () => {
      if (lndState.throws) throw new Error("14 UNAVAILABLE: connection refused");
      return { peers: [{ public_key: HUB }] };
    },
    isKeysendEnabled: async () => {
      if (lndState.throws) throw new Error("14 UNAVAILABLE: connection refused");
      return true;
    },
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

function receive(hash: string, tokens: number) {
  db.prepare("INSERT INTO payments_inbound (payment_hash, tokens, settled_at) VALUES (?, ?, ?)").run(hash, tokens, Date.now());
}

beforeEach(() => {
  lndState.throws = false;
  db.prepare("DELETE FROM payments_inbound").run();
  db.prepare("DELETE FROM network_payments").run();
});

afterAll(() => {
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

describe("GET /api/member/stats → lifetime_received_sats", () => {
  it("a node that has received nothing reads 0, as a number", async () => {
    const out = await stats();
    expect(out.status).toBe(200);
    expect(out.body.lifetime_received_sats).toBe(0);
  });

  it("sums the tokens of every settled inbound payment", async () => {
    receive("a".repeat(64), 50_000);
    receive("b".repeat(64), 1_250);
    receive("c".repeat(64), 7);
    expect((await stats()).body.lifetime_received_sats).toBe(51_257);
  });

  it("does not depend on the Payments page's settlement sync: a receipt counts with no network_payments row", async () => {
    receive("d".repeat(64), 30_000);
    const linked = db.prepare("SELECT COUNT(*) AS n FROM network_payments").get() as { n: number };
    expect(linked.n).toBe(0);
    expect((await stats()).body.lifetime_received_sats).toBe(30_000);
  });

  it("is still there when LND is unreachable (the route's SQLite side)", async () => {
    receive("e".repeat(64), 4_000);
    lndState.throws = true;
    const out = await stats();
    expect(out.status).toBe(200);
    expect(out.body.lnd_live_read_ok).toBe(false);
    expect(out.body.lifetime_received_sats).toBe(4_000);
  });
});
