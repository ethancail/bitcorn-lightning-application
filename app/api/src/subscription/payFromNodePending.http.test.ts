// Route-level tests for GET /api/subscription/pay-from-node/pending — the
// "payment sent, waiting for confirmation" read (drive-mode R45, ruling 1).
//
// The route reads this node's own send markers (migration 073) and nothing
// else: it never fetches the treasury's status and never clears a marker.
// Clearing stays with clearMarkersOnCredit (the auto-pay scheduler's tick and
// the send path), so a read can never lift the double-send guard.
//
// ⚠ PRE-CHANGE RUN: run against 297429d, before the route existed. Red there —
// the GET fell through the dispatch chain.
//
// ⚠ NO LND, NO TREASURY. getNodeInfo is a double; SQLite and the migration
// chain are real. Global fetch and the status client are spies that fail the
// test if the route reaches for the treasury.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-pending-db-"));
process.env.DB_DIR = TMP_DB;

const MEMBER = "02" + "a1".repeat(32);
const OTHER = "02" + "a2".repeat(32);

const roleState = vi.hoisted(() => ({ node: null as { node_role?: string; pubkey?: string } | null }));
vi.mock("../api/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/read")>();
  return { ...actual, getNodeInfo: () => roleState.node };
});

// The treasury read the route must never make. Counted, not stubbed to succeed:
// a call is a failure whatever it returns.
const statusCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("./memberStatusClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memberStatusClient")>();
  return {
    ...actual,
    fetchLocalSubscriptionStatus: (...a: unknown[]) => {
      statusCalls.n++;
      return (actual as any).fetchLocalSubscriptionStatus(...a);
    },
    deriveLocalMemberStatus: (...a: unknown[]) => {
      statusCalls.n++;
      return (actual as any).deriveLocalMemberStatus(...a);
    },
  };
});

const { handleRequest } = await import("../index");
const { runMigrations } = await import("../db/migrate");
const { db } = await import("../db");

const URL = "/api/subscription/pay-from-node/pending";

async function get(): Promise<{ status: number | null; body: any }> {
  const captured = { status: null as number | null, body: "" };
  const res: any = {
    setHeader() {},
    writeHead(status: number) {
      captured.status = status;
      return res;
    },
    end(chunk?: string) {
      if (chunk) captured.body += chunk;
      return res;
    },
  };
  await handleRequest({ method: "GET", url: URL, headers: {} } as any, res);
  let body: any = null;
  try {
    body = JSON.parse(captured.body);
  } catch {
    body = null;
  }
  return { status: captured.status, body };
}

function seedMarker(m: {
  member?: string;
  amount?: number;
  created_at: number;
  txid?: string | null;
  cleared_at?: number | null;
  origin?: "manual" | "auto";
  paid_through_at_write?: number | null;
}): void {
  db.prepare(
    `INSERT INTO subscription_send_marker
       (member_pubkey, origin, amount_sats, deposit_address, paid_through_at_write,
        last_payment_txid_at_write, created_at, txid, cleared_at, cleared_reason)
     VALUES (?, ?, ?, 'bcrt1qdeposit', ?, NULL, ?, ?, ?, ?)`,
  ).run(
    m.member ?? MEMBER,
    m.origin ?? "manual",
    m.amount ?? 50_000,
    m.paid_through_at_write ?? 1_790_000_000_000,
    m.created_at,
    m.txid ?? null,
    m.cleared_at ?? null,
    m.cleared_at != null ? "credited_txid" : null,
  );
}

const activeCount = () =>
  (db.prepare("SELECT COUNT(*) AS n FROM subscription_send_marker WHERE cleared_at IS NULL").get() as { n: number }).n;

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  runMigrations();
});

beforeEach(() => {
  roleState.node = { node_role: "member", pubkey: MEMBER };
  statusCalls.n = 0;
  db.exec("DELETE FROM subscription_send_marker;");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("the pending route must not fetch");
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  fs.rmSync(TMP_DB, { recursive: true, force: true });
});

describe("GET /api/subscription/pay-from-node/pending", () => {
  it("runs on the pinned Node 20", () => {
    expect(process.versions.node.split(".")[0]).toBe("20");
  });

  it("PERMITTING CONTROL: an active marker is returned with its fields", async () => {
    seedMarker({ created_at: 1_790_000_100, txid: "ab".repeat(32), amount: 42_000, origin: "auto" });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      pending: {
        amount_sats: 42_000,
        txid: "ab".repeat(32),
        sent_at: 1_790_000_100,
        origin: "auto",
        paid_through_at_write: 1_790_000_000_000,
        count: 1,
      },
    });
  });

  it("no marker → { pending: null }", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ pending: null });
  });

  it("a cleared marker is not pending", async () => {
    seedMarker({ created_at: 1_790_000_100, txid: "ab".repeat(32), cleared_at: 1_790_000_900 });
    const r = await get();
    expect(r.body).toEqual({ pending: null });
  });

  it("a txid-less marker (the broadcast threw) is returned with txid null", async () => {
    seedMarker({ created_at: 1_790_000_100, txid: null });
    const r = await get();
    expect(r.body.pending).toMatchObject({ txid: null, count: 1 });
  });

  it("two active → the newest, with count 2", async () => {
    seedMarker({ created_at: 1_790_000_100, txid: "aa".repeat(32), amount: 50_000 });
    seedMarker({ created_at: 1_790_000_500, txid: "bb".repeat(32), amount: 51_000 });
    const r = await get();
    expect(r.body.pending).toMatchObject({ txid: "bb".repeat(32), amount_sats: 51_000, sent_at: 1_790_000_500, count: 2 });
  });

  it("another member's marker is not this node's", async () => {
    seedMarker({ member: OTHER, created_at: 1_790_000_100, txid: "ab".repeat(32) });
    const r = await get();
    expect(r.body).toEqual({ pending: null });
  });

  it("treasury node → 403 member_required", async () => {
    roleState.node = { node_role: "treasury", pubkey: MEMBER };
    seedMarker({ created_at: 1_790_000_100, txid: "ab".repeat(32) });
    const r = await get();
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("member_required");
  });

  it("reads only: no treasury status read, no fetch, and no marker cleared", async () => {
    seedMarker({ created_at: 1_790_000_100, txid: "ab".repeat(32) });
    const r = await get();
    expect(r.status).toBe(200);
    expect(statusCalls.n).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(activeCount()).toBe(1);
  });
});
