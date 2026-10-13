// Boot must schedule the expired-SIWE-challenge sweep: once at boot, then hourly.
//
// sweepExpiredChallenges (stablecoin/nonceStore.ts) existed with no caller, so
// expired siwe_challenge_nonce rows were never deleted. This drives
// bootSideEffects() — the function main() calls on every node, treasury and
// member alike — not the sweep directly: a test of the helper alone would pass
// whether or not boot ever runs it.
//
// The three LND-facing boot calls are stubbed (no LND under test); the DB,
// migrations and the sweep are real. Fake timers own every timer boot creates
// — the hourly sweep and the 15s LND sync interval — and are cleared in
// afterAll, so the test leaves nothing running.
//
// Rows straddle the read path's rule (getChallengeNonce treats
// expires_at <= now as expired): one expired, one exactly at now, one live.
// The live row must SURVIVE every sweep — a sweep that deletes everything
// would satisfy the other two assertions on its own.

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it, vi } from "vitest";

// index.ts imports ./db, which opens SQLite at DB_DIR at module scope.
const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-sweep-test-"));
process.env.DB_DIR = TMP_DB;

vi.mock("./lightning/persist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lightning/persist")>()),
  persistNodeInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./lightning/sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lightning/sync")>()),
  syncLndState: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./subscription/detector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subscription/detector")>()),
  scanSubscriptionDeposits: vi.fn().mockResolvedValue(undefined),
}));

const { bootSideEffects } = await import("./index");
const { db } = await import("./db");
const { runMigrations } = await import("./db/migrate");

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const MEMBER = "02" + "cd".repeat(32);
const wallet = (tag: string) => "0x" + tag.repeat(20);

function insert(walletAddress: string, issuedAt: number, expiresAt: number) {
  db.prepare(
    `INSERT INTO siwe_challenge_nonce (member_pubkey, wallet_address, nonce, issued_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(MEMBER, walletAddress, "nonce-" + walletAddress.slice(2, 14), issuedAt, expiresAt);
}

function remaining(): string[] {
  return (db.prepare(`SELECT wallet_address FROM siwe_challenge_nonce ORDER BY wallet_address`).all() as Array<{ wallet_address: string }>)
    .map((r) => r.wallet_address);
}

afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("bootSideEffects schedules the expired-challenge sweep", () => {
  it("sweeps expired and boundary rows at boot and again an hour later, and keeps live rows", async () => {
    // Table must exist before seeding; boot's own runMigrations() is then a no-op.
    runMigrations();
    vi.useFakeTimers({ now: T0 });

    const EXPIRED = wallet("a1");     // expired before boot
    const BOUNDARY = wallet("a2");    // expires_at === boot time
    const LIVE = wallet("a3");        // live through both sweeps
    insert(EXPIRED, T0 - 10 * 60_000, T0 - 1);
    insert(BOUNDARY, T0 - 5 * 60_000, T0);
    insert(LIVE, T0 - 60_000, T0 + 2 * HOUR);
    expect(remaining()).toEqual([EXPIRED, BOUNDARY, LIVE]);

    bootSideEffects();
    await vi.advanceTimersByTimeAsync(0);

    expect(remaining()).not.toContain(EXPIRED);
    expect(remaining()).not.toContain(BOUNDARY);
    expect(remaining()).toContain(LIVE);

    // Rows that are live at boot but due within the hour.
    const EXPIRED_2 = wallet("b1");   // expires just before the hourly tick
    const BOUNDARY_2 = wallet("b2");  // expires_at === the hourly tick
    const LIVE_2 = wallet("b3");      // live past the hourly tick
    insert(EXPIRED_2, T0, T0 + HOUR - 1);
    insert(BOUNDARY_2, T0, T0 + HOUR);
    insert(LIVE_2, T0, T0 + 3 * HOUR);
    expect(remaining()).toEqual([LIVE, EXPIRED_2, BOUNDARY_2, LIVE_2]);

    await vi.advanceTimersByTimeAsync(HOUR);

    expect(remaining()).not.toContain(EXPIRED_2);
    expect(remaining()).not.toContain(BOUNDARY_2);
    expect(remaining()).toContain(LIVE);
    expect(remaining()).toContain(LIVE_2);
  });
});
