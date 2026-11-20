// code-audit-2 F02 regression pins: the payment rate limits ENFORCE when their
// env values are malformed. Before the fix, parseInt("abc") gave NaN, every
// comparison against NaN is false, and all four checks in assertRateLimit
// switched off; the `?? n` fallbacks in rate-limit.ts could never fire (NaN is
// not nullish). These tests were red on that code: each assertRateLimit below
// returned instead of throwing.
//
// Real assertRateLimit, real migrations, a temp-dir DB; nothing is mocked.
// rate-limit.ts reads ENV once at module load, so each case re-imports it
// after setting the env (vi.resetModules).

import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const TMP_DB = fs.mkdtempSync(path.join(os.tmpdir(), "bitcorn-rate-limit-env-"));
process.env.DB_DIR = TMP_DB;

const LIMIT_VARS = [
  "RATE_LIMIT_TX_PER_MINUTE",
  "RATE_LIMIT_SATS_PER_MINUTE",
  "RATE_LIMIT_SATS_PER_HOUR",
  "RATE_LIMIT_MAX_SINGLE_PAYMENT",
] as const;

afterEach(() => {
  for (const v of LIMIT_VARS) delete process.env[v];
  vi.restoreAllMocks();
});

afterAll(() => fs.rmSync(TMP_DB, { recursive: true, force: true }));

async function load(env: Partial<Record<(typeof LIMIT_VARS)[number], string>>) {
  vi.resetModules();
  for (const v of LIMIT_VARS) {
    if (env[v] === undefined) delete process.env[v];
    else process.env[v] = env[v];
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { runMigrations } = await import("../db/migrate");
  runMigrations();
  const { db } = await import("../db");
  db.prepare("DELETE FROM payments_outbound").run();
  const { assertRateLimit } = await import("./rate-limit");
  const pay = (tokens: number, agoMs: number, status = "succeeded") =>
    db.prepare(`
      INSERT INTO payments_outbound (payment_hash, payment_request, destination, tokens, fee, status, created_at)
      VALUES (?, 'lnbc', NULL, ?, 0, ?, ?)
    `).run(`h-${Math.random()}`, tokens, status, Date.now() - agoMs);
  return { assertRateLimit, pay };
}

const ALL_MALFORMED = {
  RATE_LIMIT_TX_PER_MINUTE: "abc",
  RATE_LIMIT_SATS_PER_MINUTE: "abc",
  RATE_LIMIT_SATS_PER_HOUR: "abc",
  RATE_LIMIT_MAX_SINGLE_PAYMENT: "abc",
};

describe("⚠ every limit set to \"abc\" still enforces, at the code default", () => {
  it("single payment: 50,000,001 sats is refused (default 50,000,000)", async () => {
    const { assertRateLimit } = await load(ALL_MALFORMED);
    expect(() => assertRateLimit(50_000_001)).toThrow(/exceeds maximum 50000000 sats/);
  });

  it("single payment: exactly 50,000,000 sats on an empty table passes", async () => {
    const { assertRateLimit } = await load(ALL_MALFORMED);
    expect(() => assertRateLimit(50_000_000)).not.toThrow();
  });

  it("count: the 11th payment within a minute is refused (default 10)", async () => {
    const { assertRateLimit, pay } = await load(ALL_MALFORMED);
    for (let i = 0; i < 10; i++) pay(1, 1_000);
    expect(() => assertRateLimit(1)).toThrow(/10 payments in last minute \(max: 10\)/);
  });

  it("sats per minute: past 50,000,000 within a minute is refused", async () => {
    const { assertRateLimit, pay } = await load(ALL_MALFORMED);
    pay(49_999_999, 1_000);
    expect(() => assertRateLimit(2)).toThrow(/50000001 sats in last minute \(max: 50000000\)/);
  });

  it("sats per hour: past 200,000,000 of succeeded payments within an hour is refused", async () => {
    const { assertRateLimit, pay } = await load(ALL_MALFORMED);
    // 30 minutes ago: inside the hour, outside the minute.
    for (let i = 0; i < 4; i++) pay(50_000_000, 30 * 60_000);
    expect(() => assertRateLimit(1)).toThrow(/200000001 sats in last hour \(max: 200000000\)/);
  });
});

describe("a correct configured value still reaches the check", () => {
  it("RATE_LIMIT_MAX_SINGLE_PAYMENT=1000: 1000 passes, 1001 is refused", async () => {
    const { assertRateLimit } = await load({ RATE_LIMIT_MAX_SINGLE_PAYMENT: "1000" });
    expect(() => assertRateLimit(1000)).not.toThrow();
    expect(() => assertRateLimit(1001)).toThrow(/exceeds maximum 1000 sats/);
  });

  it("RATE_LIMIT_TX_PER_MINUTE=3: the 4th payment within a minute is refused", async () => {
    const { assertRateLimit, pay } = await load({ RATE_LIMIT_TX_PER_MINUTE: "3" });
    for (let i = 0; i < 2; i++) pay(1, 1_000);
    expect(() => assertRateLimit(1)).not.toThrow();
    pay(1, 1_000);
    expect(() => assertRateLimit(1)).toThrow(/3 payments in last minute \(max: 3\)/);
  });
});
