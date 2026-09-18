// Controls for the scheduleNext clamp and the passed-over-interval record.
//
// Authority: bitcorn-research/specs/2026-09-14-autobuy-scheduler-catchup-clamp-spec.md
// §2 (C1–C5), §3 (R1–R5), §7 (K-1, K-2, K-3 leg 1, K-6).
//
// ─── WHY THROUGH runTick AND NOT BY EXPORTING scheduleNext ──────────────────
// scheduleNext is module-private and stays that way (settled by Ethan). The
// spec's §2 option B: seed a stale cursor, stub the three external modules at
// their module boundary, drive the exported runTick. That is the only option
// that can see C1 (cursor position), C2 (one evaluation) and C3 (rows written)
// at once — a unit test of the arithmetic sees only C1.
//
// runTick(db) takes the handle as a PARAMETER, so an in-memory fixture injects
// with no db mock at all. Sequential awaited calls never overlap, so the
// tickInFlight guard needs no reset between them.
//
// ─── THE OTHER RED FIRST (spec §7 K-6) ──────────────────────────────────────
// Before any red here was read as the cursor's, the harness was run with the
// ./coinbaseClient mock deleted. Every case died at
// `error:1E08010C:DECODER routines::unsupported` — the real client building a
// JWT from the stub PEM, which is NOT a network failure and happens earlier
// than one. A different site, a different reason, and it takes down the three
// permitting legs that the cursor red leaves green. Both outputs are in the
// Phase 2 closing report.

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

vi.hoisted(() => {
  process.env.AUTOBUY_ENABLED = "true";
  process.env.AUTOBUY_MAX_SINGLE_BUY_USD = "1000";
  process.env.AUTOBUY_MAX_7D_USD = "2000";
  process.env.AUTOBUY_MAX_30D_USD = "5000";
  process.env.AUTOBUY_STALE_DATA_MAX_HOURS = "48";
  process.env.AUTOBUY_FAILURE_PAUSE_THRESHOLD = "3";
});

const stubs = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  listAccounts: vi.fn(),
  placeMarketBuy: vi.fn(),
  pollOrder: vi.fn(),
  placeWithdraw: vi.fn(),
  pollWithdraw: vi.fn(),
}));

vi.mock("./valuationClient", () => ({ getCurrent: stubs.getCurrent }));
vi.mock("./coinbaseClient", () => ({
  listAccounts: stubs.listAccounts,
  placeMarketBuy: stubs.placeMarketBuy,
  pollOrder: stubs.pollOrder,
  placeWithdraw: stubs.placeWithdraw,
  pollWithdraw: stubs.pollWithdraw,
}));
vi.mock("./credentials", () => ({
  decrypt: () => "-----BEGIN EC PRIVATE KEY-----\nstub\n-----END EC PRIVATE KEY-----",
}));
vi.mock("../lightning/lnd", () => ({
  createLndChainAddress: vi.fn(async () => "bcrt1qstubaddress"),
}));

import { runTick } from "./scheduler";

const MIG = (f: string) => fs.readFileSync(path.join(__dirname, "../db/migrations", f), "utf8");

const WEEK = 7 * 86400;
/** Fixed wall clock for every tick in a case. 2026-09-14T12:00:00Z. */
const NOW = 1789646400;

let db: Database.Database;

function seedConfig(over: Record<string, unknown> = {}): void {
  const row = {
    enabled: 1,
    base_unit_usd: 100,
    frequency: "weekly",
    withdraw_address: "bcrt1qstubaddress",
    withdraw_address_whitelisted_at: NOW - 10 * WEEK,
    next_run_at: NOW - 4 * WEEK,
    ...over,
  };
  db.prepare(
    `UPDATE autobuy_config
        SET enabled = ?, base_unit_usd = ?, frequency = ?, withdraw_address = ?,
            withdraw_address_whitelisted_at = ?, next_run_at = ?
      WHERE id = 1`,
  ).run(
    row.enabled, row.base_unit_usd, row.frequency, row.withdraw_address,
    row.withdraw_address_whitelisted_at, row.next_run_at,
  );
  db.prepare(
    `INSERT OR REPLACE INTO coinbase_credentials
       (id, key_name, encrypted_private_key, nonce, connected_at)
     VALUES (1, 'stub-key', ?, ?, ?)`,
  ).run(Buffer.from("x"), Buffer.from("y"), NOW - WEEK);
}

const cursor = () =>
  (db.prepare(`SELECT next_run_at FROM autobuy_config WHERE id = 1`).get() as { next_run_at: number })
    .next_run_at;

const rowsOf = (status: string) =>
  db.prepare(`SELECT * FROM autobuy_runs WHERE status = ? ORDER BY id ASC`).all(status) as any[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);

  db = new Database(":memory:");
  db.exec(MIG("034_coinbase_autobuy.sql"));
  db.exec(MIG("049_currency_adaptive_autobuy.sql"));
  db.exec(MIG("050_autobuy_alerts.sql"));
  db.exec(MIG("054_autobuy_missed_interval_claim.sql"));

  stubs.getCurrent.mockResolvedValue({
    ok: true,
    value: {
      z_score: -0.4,
      zone: "fair_value",
      updated_at: new Date(NOW * 1000).toISOString(),
    },
  });
  stubs.listAccounts.mockResolvedValue({
    ok: true,
    data: { accounts: [{ currency: "USDC", available_balance: { value: "100000" } }] },
  });
  let orderSeq = 0;
  stubs.placeMarketBuy.mockImplementation(async () => ({ ok: true, order_id: `order-${++orderSeq}` }));
  // OPEN leaves buy_placed rows untouched, so the buy step's output is what the
  // assertions read — the poll step cannot quietly rewrite it.
  stubs.pollOrder.mockResolvedValue({ ok: true, order: { status: "OPEN" } });
  stubs.placeWithdraw.mockResolvedValue({ ok: false, status: 0, error: "stub" });
  stubs.pollWithdraw.mockResolvedValue({ ok: false, status: 0, error: "stub" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// K-1 — the decision's negative control. A cursor four intervals stale must
// produce ONE buy and THREE missed-interval records, not a burst of buys.
// ─────────────────────────────────────────────────────────────────────────────
describe("K-1 · a stale cursor fires once and records what it passed over", () => {
  it("four intervals stale -> 1 buy_placed, 3 skipped_missed_interval, cursor at now+increment", async () => {
    seedConfig({ next_run_at: NOW - 4 * WEEK });

    for (let i = 0; i < 5; i++) await runTick(db);

    expect(rowsOf("buy_placed")).toHaveLength(1);
    expect(rowsOf("skipped_missed_interval")).toHaveLength(3);
    expect(cursor()).toBe(NOW + WEEK);
    expect(stubs.placeMarketBuy).toHaveBeenCalledTimes(1);
  });

  it("the missed rows carry the ORIGINAL slots, not the moment of discovery", async () => {
    seedConfig({ next_run_at: NOW - 4 * WEEK });
    await runTick(db);

    const missed = rowsOf("skipped_missed_interval");
    expect(missed.map((r) => r.scheduled_for)).toEqual([
      NOW - 3 * WEEK,
      NOW - 2 * WEEK,
      NOW - 1 * WEEK,
    ]);
  });

  it("a missed row states the amount and refuses to invent a retroactive valuation", async () => {
    seedConfig({ next_run_at: NOW - 4 * WEEK });
    await runTick(db);

    const [first] = rowsOf("skipped_missed_interval");
    expect(first.intended_buy_usd).toBe(100);
    expect(first.error_code).toBe("clamped_past_interval");
    // The valuation AT the missed moment is unknowable now. A stored number
    // here would be a guess wearing a fact's clothes.
    expect(first.multiplier).toBeNull();
    expect(first.z_score).toBeNull();
    expect(first.zone).toBeNull();
    expect(first.claimed_by_run_id).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K-2 — anti-vacuity. "cursor >= now" passes on ANY forward move, including
// now + 10·increment. These assert the EXACT landing point.
// ─────────────────────────────────────────────────────────────────────────────
describe("K-2 · the tick lands where expected, not merely forward", () => {
  it("the cursor is exactly now + one increment — not merely >= now", async () => {
    seedConfig({ next_run_at: NOW - 4 * WEEK });
    await runTick(db);

    // The weak assertion, kept ADJACENT to the strong one so the difference is
    // visible: this one survives a clamp mutated to now + 2·increment.
    expect(cursor()).toBeGreaterThanOrEqual(NOW);
    // The strong assertion. This is the one that dies under that mutation.
    expect(cursor()).toBe(NOW + WEEK);
  });

  it("the missed slots are the exact skipped slots, evenly spaced by one increment", async () => {
    seedConfig({ next_run_at: NOW - 6 * WEEK });
    await runTick(db);

    const slots = rowsOf("skipped_missed_interval").map((r) => r.scheduled_for);
    expect(slots).toHaveLength(5);
    expect(slots).toEqual([
      NOW - 5 * WEEK, NOW - 4 * WEEK, NOW - 3 * WEEK, NOW - 2 * WEEK, NOW - 1 * WEEK,
    ]);
    for (let i = 1; i < slots.length; i++) expect(slots[i] - slots[i - 1]).toBe(WEEK);
  });

  it("a daily cadence clamps on ITS increment — the quantity is not hardcoded weekly", async () => {
    seedConfig({ frequency: "daily", next_run_at: NOW - 3 * 86400 });
    await runTick(db);

    expect(cursor()).toBe(NOW + 86400);
    expect(rowsOf("skipped_missed_interval").map((r) => r.scheduled_for)).toEqual([
      NOW - 2 * 86400, NOW - 1 * 86400,
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K-3 leg 1 — THE PERMITTING CONTROL. A suite that only forbids the burst is
// passed by a scheduler with scheduleNext deleted, or one that never buys
// again. These assert the scheduler STILL BUYS on the paths it always bought.
// ─────────────────────────────────────────────────────────────────────────────
describe("K-3 leg 1 · the non-stale paths are unchanged — the scheduler still buys", () => {
  it("a CURRENT cursor still places exactly one buy and advances one increment", async () => {
    seedConfig({ next_run_at: NOW });
    await runTick(db);

    expect(rowsOf("buy_placed")).toHaveLength(1);
    expect(rowsOf("skipped_missed_interval")).toHaveLength(0);
    expect(cursor()).toBe(NOW + WEEK);
  });

  it("a NULL cursor behaves as today: base = now, one buy, no missed rows (C4)", async () => {
    seedConfig({ next_run_at: null });
    await runTick(db);

    expect(rowsOf("buy_placed")).toHaveLength(1);
    expect(rowsOf("skipped_missed_interval")).toHaveLength(0);
    expect(cursor()).toBe(NOW + WEEK);
  });

  it("a FUTURE cursor is untouched: no buy, no rows, cursor unmoved (C4)", async () => {
    seedConfig({ next_run_at: NOW + 3 * WEEK });
    await runTick(db);

    expect(rowsOf("buy_placed")).toHaveLength(0);
    expect(rowsOf("skipped_missed_interval")).toHaveLength(0);
    expect(cursor()).toBe(NOW + 3 * WEEK);
    expect(stubs.placeMarketBuy).not.toHaveBeenCalled();
  });

  it("stale by LESS than one interval records nothing — no whole interval was passed", async () => {
    seedConfig({ next_run_at: NOW - Math.floor(WEEK / 2) });
    await runTick(db);

    expect(rowsOf("buy_placed")).toHaveLength(1);
    expect(rowsOf("skipped_missed_interval")).toHaveLength(0);
    expect(cursor()).toBe(NOW + WEEK);
  });

  it("the clamp does not smuggle past a skip: a stale cursor on a stale valuation still skips, and still records", async () => {
    // The buy path must be REACHED and DECLINED on its own terms. If the clamp
    // short-circuited the tick, this would show zero rows of either kind.
    stubs.getCurrent.mockResolvedValue({
      ok: true,
      value: { z_score: -0.4, zone: "fair_value", updated_at: new Date((NOW - 30 * 86400) * 1000).toISOString() },
    });
    seedConfig({ next_run_at: NOW - 3 * WEEK });
    await runTick(db);

    expect(rowsOf("skipped_stale_data")).toHaveLength(1);
    expect(rowsOf("buy_placed")).toHaveLength(0);
    expect(rowsOf("skipped_missed_interval")).toHaveLength(2);
    expect(cursor()).toBe(NOW + WEEK);
  });
});
