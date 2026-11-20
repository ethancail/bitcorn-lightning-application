// P0 Suite B — characterization of the scheduler's hold, sweep and withdraw
// poll (scheduler.ts:951-1156), the failure-counter reset site (:1120), and the
// silent paths (S5).
//
// Authority: bitcorn-research/specs/2026-11-18-kraken-autobuy-slice-1-spec.md
// §3 P0 (Suite B), decisions D3, S5, S6. This suite PINS CURRENT BEHAVIOUR.
// Cases marked [N] are readings that the run confirmed; a case that reads like
// a defect (B13, B15, B26) is pinned as it is and listed in the P0 report as a
// finding; it is not fixed here.
//
// ─── MOCK BOUNDARY ─────────────────────────────────────────────────────────
// ./coinbaseClient (its five functions), ./valuationClient, ./credentials
// (decrypt, so a case can make it throw) and ../lightning/lnd (as {address},
// the shape lnd.ts declares). The scheduler, caps, alerts and alertStore are
// real. vi.mock matches by resolved module, so a later adapter that imports
// ./coinbaseClient gets these stubs too: this suite survives P1 unedited as
// long as coinbaseClient.ts keeps its path.
//
// ─── MODULE STATE ──────────────────────────────────────────────────────────
// tickInFlight (:48) is module-level. If one case left a tick hung, every
// later runTick would return at :64 doing nothing, and every "nothing was
// withdrawn" assertion after it would pass vacuously. So each case gets a
// FRESH scheduler module (vi.resetModules + dynamic import). startScheduler is
// never called, so tickHandle (:30) stays null; afterEach still stops it.
//
// ─── CLOCK ─────────────────────────────────────────────────────────────────
// SUNDAY is the sweep day under the migration's default sweep_day_of_week = 0
// (034:28), which the seed deliberately leaves unset. THURSDAY isolates the
// hold and poll cases from the sweep. next_run_at is a week ahead, so the buy
// step (:182) does nothing in any case here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  decrypt: vi.fn(),
  createLndChainAddress: vi.fn(),
}));

vi.mock("./valuationClient", () => ({ getCurrent: stubs.getCurrent }));
vi.mock("./coinbaseClient", () => ({
  listAccounts: stubs.listAccounts,
  placeMarketBuy: stubs.placeMarketBuy,
  pollOrder: stubs.pollOrder,
  placeWithdraw: stubs.placeWithdraw,
  pollWithdraw: stubs.pollWithdraw,
}));
vi.mock("./credentials", () => ({ decrypt: stubs.decrypt }));
vi.mock("../lightning/lnd", () => ({ createLndChainAddress: stubs.createLndChainAddress }));

type Scheduler = typeof import("./scheduler");
let sched: Scheduler;
let db: Database.Database;

const MIG = (f: string) => fs.readFileSync(path.join(__dirname, "../db/migrations", f), "utf8");

const HOUR = 3600;
const DAY = 86400;
const WEEK = 7 * DAY;
const HOLD = 72 * HOUR;
/** 2026-09-20T12:00:00Z, a Sunday. */
const SUNDAY = 1789905600;
/** 2026-09-20T00:00:00Z. */
const SUN_START = 1789862400;
/** 2026-09-17T12:00:00Z, a Thursday. */
const THURSDAY = 1789646400;
/** 2026-09-23T12:00:00Z, a Wednesday. */
const WEDNESDAY = SUNDAY + 3 * DAY;

const PEM = "-----BEGIN EC PRIVATE KEY-----\nstub\n-----END EC PRIVATE KEY-----";
const DEST = "bc1qsweepdestination";
const ACCOUNTS = {
  ok: true,
  status: 200,
  data: {
    accounts: [
      { uuid: "usd-uuid", name: "USD", currency: "USD", available_balance: { value: "1000", currency: "USD" } },
      { uuid: "btc-uuid", name: "BTC", currency: "BTC", available_balance: { value: "0.5", currency: "BTC" } },
    ],
  },
};

const nowSec = () => Math.floor(Date.now() / 1000);
function at(epoch: number): void {
  vi.setSystemTime(epoch * 1000);
}

function seed(over: Record<string, unknown> = {}, opts: { creds?: boolean } = {}): void {
  const now = nowSec();
  const row: Record<string, unknown> = {
    enabled: 1,
    base_unit_usd: 100,
    frequency: "weekly",
    withdraw_address: DEST,
    withdraw_address_whitelisted_at: now - 10 * WEEK,
    next_run_at: now + WEEK,
    consecutive_failures: 0,
    paused_reason: null,
    ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`UPDATE autobuy_config SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = 1`).run(
    ...cols.map((c) => row[c]),
  );
  if (opts.creds !== false) {
    db.prepare(
      `INSERT OR REPLACE INTO coinbase_credentials (id, key_name, encrypted_private_key, nonce, connected_at)
       VALUES (1, 'stub-key', ?, ?, ?)`,
    ).run(Buffer.from("x"), Buffer.from("y"), now - WEEK);
  }
}

function insertRun(r: {
  status: string;
  filled_btc?: number | null;
  filled_at?: number | null;
  coinbase_order_id?: string | null;
  withdraw_sweep_id?: number | null;
}): number {
  const now = nowSec();
  const info = db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, status, filled_btc, filled_usd, filled_at, coinbase_order_id, withdraw_sweep_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now - WEEK, r.status, r.filled_btc ?? null, r.filled_btc == null ? null : 100, r.filled_at ?? null,
    r.coinbase_order_id ?? null, r.withdraw_sweep_id ?? null, now - WEEK, now - WEEK,
  );
  return Number(info.lastInsertRowid);
}

/** A sweep_assigned run, filled well past the hold. */
const assigned = (btc: number) => insertRun({ status: "sweep_assigned", filled_btc: btc, filled_at: nowSec() - 5 * DAY });

function insertSweep(s: { status: string; swept_at?: number; btc_amount?: number; coinbase_tx_id?: string | null }): number {
  const info = db.prepare(
    `INSERT INTO autobuy_sweeps (swept_at, btc_amount, coinbase_tx_id, status) VALUES (?, ?, ?, ?)`,
  ).run(s.swept_at ?? nowSec() - WEEK, s.btc_amount ?? 0.01, s.coinbase_tx_id ?? null, s.status);
  return Number(info.lastInsertRowid);
}

/** A placed sweep with `runs` withdraw_placed runs linked to it. */
function placedSweep(txId: string, runs = 2, btcEach = 0.002): { sweepId: number; runIds: number[] } {
  const sweepId = insertSweep({ status: "placed", btc_amount: runs * btcEach, coinbase_tx_id: txId });
  const runIds: number[] = [];
  for (let i = 0; i < runs; i++) {
    runIds.push(insertRun({ status: "withdraw_placed", filled_btc: btcEach, filled_at: nowSec() - 6 * DAY + i, withdraw_sweep_id: sweepId }));
  }
  return { sweepId, runIds };
}

function insertActiveAlert(type: string): number {
  const now = nowSec();
  const info = db.prepare(
    `INSERT INTO autobuy_alerts (type, severity, status, context_json, created_at, updated_at)
     VALUES (?, 'warning', 'active', '{}', ?, ?)`,
  ).run(type, now - DAY, now - DAY);
  return Number(info.lastInsertRowid);
}

const cfg = () =>
  db.prepare(`SELECT enabled, paused_reason, consecutive_failures FROM autobuy_config WHERE id = 1`).get() as {
    enabled: number;
    paused_reason: string | null;
    consecutive_failures: number;
  };
const run = (id: number) => db.prepare(`SELECT * FROM autobuy_runs WHERE id = ?`).get(id) as any;
const runs = () => db.prepare(`SELECT * FROM autobuy_runs ORDER BY id`).all() as any[];
const sweeps = () => db.prepare(`SELECT * FROM autobuy_sweeps ORDER BY id`).all() as any[];
const sweep = (id: number) => db.prepare(`SELECT * FROM autobuy_sweeps WHERE id = ?`).get(id) as any;
const alerts = (status = "active") =>
  (db.prepare(`SELECT * FROM autobuy_alerts WHERE status = ? ORDER BY id`).all(status) as any[]).map((a) => ({
    ...a,
    context: a.context_json ? JSON.parse(a.context_json) : null,
  }));

beforeEach(async () => {
  vi.useFakeTimers();
  at(SUNDAY);

  vi.resetModules();
  sched = await import("./scheduler");

  db = new Database(":memory:");
  db.exec(MIG("034_coinbase_autobuy.sql"));
  db.exec(MIG("049_currency_adaptive_autobuy.sql"));
  db.exec(MIG("050_autobuy_alerts.sql"));
  db.exec(MIG("054_autobuy_missed_interval_claim.sql"));

  stubs.decrypt.mockReturnValue(PEM);
  stubs.getCurrent.mockResolvedValue({
    ok: true,
    value: { z_score: -0.4, zone: "fair_value", updated_at: new Date(nowSec() * 1000).toISOString() },
  });
  stubs.listAccounts.mockResolvedValue(ACCOUNTS);
  stubs.placeMarketBuy.mockResolvedValue({ ok: true, order_id: "order-x" });
  stubs.pollOrder.mockResolvedValue({ ok: true, order: { status: "OPEN" } });
  stubs.placeWithdraw.mockResolvedValue({ ok: true, transaction_id: "cb-tx-1" });
  stubs.pollWithdraw.mockResolvedValue({ ok: true, withdraw: { transaction_id: "cb-tx-1", status: "pending" } });
  stubs.createLndChainAddress.mockResolvedValue({ address: "bcrt1qunused" });
});

afterEach(() => {
  sched.stopScheduler();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.resetAllMocks();
  db.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// B1–B4 · the 72 h hold (stepAssignToSweep, :951-974). Thursday: no sweep.
// ─────────────────────────────────────────────────────────────────────────────
describe("B · the withdraw hold", () => {
  beforeEach(() => at(THURSDAY));

  it("B1 filled exactly 72 h ago -> sweep_assigned (filled_at <= cutoff is inclusive)", async () => {
    seed();
    const id = insertRun({ status: "buy_filled", filled_btc: 0.001, filled_at: nowSec() - HOLD });
    await sched.runTick(db);
    expect(run(id).status).toBe("sweep_assigned");
  });

  it("B2 filled 72 h - 1 s ago -> awaiting_withdraw_hold", async () => {
    seed();
    const id = insertRun({ status: "buy_filled", filled_btc: 0.001, filled_at: nowSec() - HOLD + 1 });
    await sched.runTick(db);
    expect(run(id).status).toBe("awaiting_withdraw_hold");
  });

  it("B3 awaiting_withdraw_hold past the hold -> sweep_assigned", async () => {
    seed();
    const id = insertRun({ status: "awaiting_withdraw_hold", filled_btc: 0.001, filled_at: nowSec() - HOLD - 10 });
    await sched.runTick(db);
    expect(run(id).status).toBe("sweep_assigned");
  });

  it("B4 buy_filled with filled_at NULL stays buy_filled", async () => {
    seed();
    const id = insertRun({ status: "buy_filled", filled_btc: 0.001, filled_at: null });
    await sched.runTick(db);
    expect(run(id).status).toBe("buy_filled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B5–B20 · the sweep's gates, in code order (stepRunSweep, :980-1030)
// ─────────────────────────────────────────────────────────────────────────────
describe("B · sweep gates", () => {
  it("B5 withdraw_address_whitelisted_at NULL -> no listAccounts, no withdrawal (and step 1 pauses address_not_whitelisted, :176-178)", async () => {
    seed({ withdraw_address_whitelisted_at: null });
    const id = assigned(0.001);
    await sched.runTick(db);
    expect(stubs.listAccounts).not.toHaveBeenCalled();
    expect(stubs.placeWithdraw).not.toHaveBeenCalled();
    expect(sweeps()).toHaveLength(0);
    expect(run(id).status).toBe("sweep_assigned");
    expect(cfg().paused_reason).toBe("address_not_whitelisted");
  });

  it("B6 Saturday 23:59:59Z -> no sweep (getUTCDay, :985)", async () => {
    at(SUN_START - 1);
    seed();
    assigned(0.001);
    await sched.runTick(db);
    expect(stubs.placeWithdraw).not.toHaveBeenCalled();
    expect(sweeps()).toHaveLength(0);
  });

  it("B7 Sunday 00:00:00Z -> sweep (default sweep_day_of_week 0, 034:28)", async () => {
    at(SUN_START);
    seed();
    assigned(0.001);
    await sched.runTick(db);
    expect(stubs.placeWithdraw).toHaveBeenCalledTimes(1);
  });

  it("B8a sweep_day_of_week = 3 sweeps on a Wednesday", async () => {
    at(WEDNESDAY);
    seed({ sweep_day_of_week: 3 });
    assigned(0.001);
    await sched.runTick(db);
    expect(stubs.placeWithdraw).toHaveBeenCalledTimes(1);
  });

  it("B8b sweep_day_of_week = 3 does not sweep on a Sunday", async () => {
    seed({ sweep_day_of_week: 3 });
    assigned(0.001);
    await sched.runTick(db);
    expect(stubs.placeWithdraw).not.toHaveBeenCalled();
  });

  it("B9 [N] a FAILED sweep row earlier today blocks a retry today (any status counts, :991-994)", async () => {
    seed();
    insertSweep({ status: "failed", swept_at: SUN_START + 60 });
    const id = assigned(0.001);
    await sched.runTick(db);
    expect(stubs.listAccounts).not.toHaveBeenCalled();
    expect(stubs.placeWithdraw).not.toHaveBeenCalled();
    expect(run(id).status).toBe("sweep_assigned");
  });

  it("B10 a sweep row at todayStart - 1 does not block", async () => {
    seed();
    insertSweep({ status: "failed", swept_at: SUN_START - 1 });
    assigned(0.001);
    await sched.runTick(db);
    expect(stubs.placeWithdraw).toHaveBeenCalledTimes(1);
  });

  it("B11 total 0.00009 BTC < SWEEP_MIN_BTC -> deferred, no listAccounts (:1001)", async () => {
    seed();
    assigned(0.00009);
    await sched.runTick(db);
    expect(stubs.listAccounts).not.toHaveBeenCalled();
    expect(stubs.placeWithdraw).not.toHaveBeenCalled();
  });

  it("B12 total exactly 0.0001 BTC (2 x 0.00005) -> proceeds", async () => {
    seed();
    assigned(0.00005);
    assigned(0.00005);
    await sched.runTick(db);
    expect(stubs.placeWithdraw).toHaveBeenCalledTimes(1);
    expect(stubs.placeWithdraw.mock.calls[0][3]).toBe(0.0001);
  });

  it("B13 [+][N] enabled = 0 STILL SWEEPS — stepRunSweep never reads enabled (:980-1001)", async () => {
    seed({ enabled: 0 });
    const id = assigned(0.001);
    await sched.runTick(db);
    expect(stubs.placeWithdraw).toHaveBeenCalledTimes(1);
    expect(run(id).status).toBe("withdraw_placed");
    expect(cfg().enabled).toBe(0);
  });

  it("B14 no credentials row -> paused no_credentials, no listAccounts (:1004)", async () => {
    seed({}, { creds: false });
    const id = assigned(0.001);
    await sched.runTick(db);
    expect(stubs.listAccounts).not.toHaveBeenCalled();
    expect(cfg()).toMatchObject({ enabled: 0, paused_reason: "no_credentials" });
    expect(run(id).status).toBe("sweep_assigned");
  });

  it("B15 [+][N] corrupted credentials: loadCredentials writes credentials_corrupted (:98), then :1004 overwrites it -> final reason no_credentials", async () => {
    seed();
    stubs.decrypt.mockImplementation(() => {
      throw new Error("credentials_corrupted");
    });
    assigned(0.001);
    await sched.runTick(db);
    expect(stubs.listAccounts).not.toHaveBeenCalled();
    expect(cfg()).toMatchObject({ enabled: 0, paused_reason: "no_credentials" });
  });

  for (const status of [401, 403]) {
    it(`B${status === 401 ? 16 : 17} listAccounts ${status} -> paused credentials_invalid + AUTH_FAILURE (source list_accounts); no sweep row; runs unchanged`, async () => {
      seed();
      const id = assigned(0.001);
      stubs.listAccounts.mockResolvedValue({ ok: false, status, error: "nope" });
      await sched.runTick(db);
      expect(cfg()).toMatchObject({ enabled: 0, paused_reason: "credentials_invalid" });
      const active = alerts();
      expect(active).toHaveLength(1);
      expect(active[0].type).toBe("AUTOBUY_AUTH_FAILURE");
      expect(active[0].latest_run_id).toBeNull();
      expect(active[0].context).toEqual({ paused_reason: "credentials_invalid", http_status: status, source: "list_accounts", error: "nope" });
      expect(stubs.placeWithdraw).not.toHaveBeenCalled();
      expect(sweeps()).toHaveLength(0);
      expect(run(id).status).toBe("sweep_assigned");
    });
  }

  it("B18 listAccounts 500 -> RATE_LIMITED alert, NO pause; no sweep row", async () => {
    seed();
    const id = assigned(0.001);
    stubs.listAccounts.mockResolvedValue({ ok: false, status: 500, error: "busy" });
    await sched.runTick(db);
    expect(cfg()).toMatchObject({ enabled: 1, paused_reason: null, consecutive_failures: 0 });
    const active = alerts();
    expect(active.map((a) => a.type)).toEqual(["AUTOBUY_RATE_LIMITED"]);
    expect(active[0].context).toEqual({ http_status: 500, retry_after: null, source: "list_accounts", error: "busy" });
    expect(sweeps()).toHaveLength(0);
    expect(run(id).status).toBe("sweep_assigned");
  });

  it("B19 no BTC account -> silent: no alert, no sweep row, no pause (S5, :1026-1030)", async () => {
    seed();
    const id = assigned(0.001);
    stubs.listAccounts.mockResolvedValue({ ok: true, status: 200, data: { accounts: [ACCOUNTS.data.accounts[0]] } });
    await sched.runTick(db);
    expect(stubs.placeWithdraw).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(0);
    expect(sweeps()).toHaveLength(0);
    expect(cfg()).toMatchObject({ enabled: 1, paused_reason: null, consecutive_failures: 0 });
    expect(run(id).status).toBe("sweep_assigned");
  });

  it("B20 a successful sweep-path listAccounts resolves active AUTH_FAILURE and RATE_LIMITED (api_ok, :1025)", async () => {
    seed();
    insertActiveAlert("AUTOBUY_AUTH_FAILURE");
    insertActiveAlert("AUTOBUY_RATE_LIMITED");
    assigned(0.001);
    await sched.runTick(db);
    expect(alerts()).toHaveLength(0);
    expect(alerts("resolved").map((a) => a.type).sort()).toEqual(["AUTOBUY_AUTH_FAILURE", "AUTOBUY_RATE_LIMITED"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B21–B22 · one summed withdrawal (:997-1000, :1032, :1074-1084)
// ─────────────────────────────────────────────────────────────────────────────
describe("B · the summed withdrawal", () => {
  it("B21 three sweep_assigned runs -> placeWithdraw ONCE with (creds, BTC uuid, withdraw_address, SUM); other statuses excluded", async () => {
    seed();
    assigned(0.001);
    assigned(0.002);
    assigned(0.003);
    insertRun({ status: "awaiting_withdraw_hold", filled_btc: 0.4, filled_at: nowSec() - HOUR });
    insertRun({ status: "withdraw_confirmed", filled_btc: 0.5, filled_at: nowSec() - 30 * DAY });
    insertRun({ status: "failed_withdraw", filled_btc: 0.7, filled_at: nowSec() - 30 * DAY });
    await sched.runTick(db);

    expect(stubs.placeWithdraw).toHaveBeenCalledTimes(1);
    const [creds, acct, to, amount] = stubs.placeWithdraw.mock.calls[0];
    expect(creds).toEqual({ keyName: "stub-key", privateKeyPem: PEM });
    expect(acct).toBe("btc-uuid");
    expect(to).toBe(DEST);
    expect(amount).toBeCloseTo(0.006, 12);
  });

  it("B22 success -> one 'placed' sweep row with coinbase_tx_id; every assigned run -> withdraw_placed + withdraw_sweep_id", async () => {
    seed();
    const ids = [assigned(0.001), assigned(0.002)];
    const other = insertRun({ status: "awaiting_withdraw_hold", filled_btc: 0.4, filled_at: nowSec() - HOUR });
    await sched.runTick(db);

    const all = sweeps();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: "placed", coinbase_tx_id: "cb-tx-1", swept_at: SUNDAY, error_code: null });
    expect(all[0].btc_amount).toBeCloseTo(0.003, 12);
    for (const id of ids) expect(run(id)).toMatchObject({ status: "withdraw_placed", withdraw_sweep_id: all[0].id });
    expect(run(other)).toMatchObject({ status: "awaiting_withdraw_hold", withdraw_sweep_id: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B23–B26 · a failed withdrawal: 400 vs other statuses (:1037-1071)
// ─────────────────────────────────────────────────────────────────────────────
describe("B · a failed withdrawal", () => {
  it("B23 400 -> sweep 'failed' address_not_whitelisted; runs failed_withdraw; paused address_not_whitelisted; counter +1; SWEEP_FAILED with full context", async () => {
    seed();
    const r1 = assigned(0.001);
    const r2 = insertRun({ status: "sweep_assigned", filled_btc: 0.002, filled_at: nowSec() - 4 * DAY });
    const longError = "e".repeat(600);
    stubs.placeWithdraw.mockResolvedValue({ ok: false, status: 400, error: longError });
    await sched.runTick(db);

    const [s] = sweeps();
    expect(s).toMatchObject({ status: "failed", error_code: "address_not_whitelisted", swept_at: SUNDAY, coinbase_tx_id: null });
    expect(s.error_message).toBe("e".repeat(500));
    for (const id of [r1, r2]) expect(run(id)).toMatchObject({ status: "failed_withdraw", error_message: "e".repeat(500) });
    expect(cfg()).toMatchObject({ enabled: 0, paused_reason: "address_not_whitelisted", consecutive_failures: 1 });
    const active = alerts();
    expect(active).toHaveLength(1);
    expect(active[0].type).toBe("AUTOBUY_SWEEP_FAILED");
    expect(active[0].latest_run_id).toBe(r2);
    expect(active[0].context).toEqual({
      sweep_id: s.id,
      latest_run_id: r2,
      btc_amount: s.btc_amount,
      buy_completed_at: nowSec() - 4 * DAY,
      error_code: "address_not_whitelisted",
      error_message: "e".repeat(500),
    });
  });

  for (const status of [500, 0]) {
    it(`B${status === 500 ? 24 : 25} ${status} -> http_${status}; NO pause; counter +1; SWEEP_FAILED`, async () => {
      seed();
      const id = assigned(0.001);
      stubs.placeWithdraw.mockResolvedValue({ ok: false, status, error: "boom" });
      await sched.runTick(db);
      expect(sweeps()[0]).toMatchObject({ status: "failed", error_code: `http_${status}` });
      expect(run(id).status).toBe("failed_withdraw");
      expect(cfg()).toMatchObject({ enabled: 1, paused_reason: null, consecutive_failures: 1 });
      expect(alerts().map((a) => a.type)).toEqual(["AUTOBUY_SWEEP_FAILED"]);
      expect(alerts()[0].context.error_code).toBe(`http_${status}`);
    });
  }

  it("B26 [+][N] a 400 with the counter at 2 (threshold 3): recordFailure (:1058) overwrites :1056 -> final reason consecutive_failures", async () => {
    seed({ consecutive_failures: 2 });
    assigned(0.001);
    stubs.placeWithdraw.mockResolvedValue({ ok: false, status: 400, error: "not whitelisted" });
    await sched.runTick(db);
    expect(cfg()).toMatchObject({ enabled: 0, paused_reason: "consecutive_failures", consecutive_failures: 3 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B27–B38 · the withdraw poll (stepPollWithdraws, :1092-1156) — the counter's
// only scheduler reset (:1120, S6) and its silent paths (S5, :1099-1108)
// ─────────────────────────────────────────────────────────────────────────────
describe("B · the withdraw poll", () => {
  it("B27 [+] a sweep placed in a tick is polled in the SAME tick (step 5 follows step 4, :73-74)", async () => {
    seed();
    assigned(0.001);
    await sched.runTick(db);
    expect(stubs.listAccounts).toHaveBeenCalledTimes(2);
    expect(stubs.pollWithdraw).toHaveBeenCalledTimes(1);
    expect(stubs.pollWithdraw.mock.calls[0].slice(1)).toEqual(["btc-uuid", "cb-tx-1"]);
  });

  describe("on a Thursday (no sweep step)", () => {
    beforeEach(() => at(THURSDAY));

    it("B28 completed -> sweep confirmed + txid; runs withdraw_confirmed + txid; counter RESET to 0; SWEEP_FAILED resolved", async () => {
      seed({ consecutive_failures: 2 });
      insertActiveAlert("AUTOBUY_SWEEP_FAILED");
      const { sweepId, runIds } = placedSweep("cb-tx-9");
      stubs.pollWithdraw.mockResolvedValue({ ok: true, withdraw: { transaction_id: "cb-tx-9", status: "completed", network_tx_hash: "chain-txid" } });
      await sched.runTick(db);

      expect(stubs.pollWithdraw.mock.calls[0].slice(1)).toEqual(["btc-uuid", "cb-tx-9"]);
      expect(sweep(sweepId)).toMatchObject({ status: "confirmed", withdraw_txid: "chain-txid" });
      for (const id of runIds) expect(run(id)).toMatchObject({ status: "withdraw_confirmed", withdraw_txid: "chain-txid" });
      expect(cfg().consecutive_failures).toBe(0);
      expect(alerts()).toHaveLength(0);
      expect(alerts("resolved").map((a) => a.type)).toEqual(["AUTOBUY_SWEEP_FAILED"]);
    });

    it("B29 completed with no network hash -> NULL txids", async () => {
      seed();
      const { sweepId, runIds } = placedSweep("cb-tx-9");
      stubs.pollWithdraw.mockResolvedValue({ ok: true, withdraw: { transaction_id: "cb-tx-9", status: "completed" } });
      await sched.runTick(db);
      expect(sweep(sweepId)).toMatchObject({ status: "confirmed", withdraw_txid: null });
      for (const id of runIds) expect(run(id)).toMatchObject({ status: "withdraw_confirmed", withdraw_txid: null });
    });

    for (const status of ["failed", "cancelled"]) {
      it(`B${status === "failed" ? 30 : 31} ${status} -> sweep failed (error_code ${status}); runs failed_withdraw; counter +1; SWEEP_FAILED with the sweep's btc_amount`, async () => {
        seed({ consecutive_failures: 1 });
        const { sweepId, runIds } = placedSweep("cb-tx-9", 2, 0.002);
        stubs.pollWithdraw.mockResolvedValue({ ok: true, withdraw: { transaction_id: "cb-tx-9", status } });
        await sched.runTick(db);

        expect(sweep(sweepId)).toMatchObject({ status: "failed", error_code: status });
        for (const id of runIds) expect(run(id).status).toBe("failed_withdraw");
        expect(cfg()).toMatchObject({ consecutive_failures: 2, paused_reason: null, enabled: 1 });
        const active = alerts();
        expect(active.map((a) => a.type)).toEqual(["AUTOBUY_SWEEP_FAILED"]);
        expect(active[0].context).toEqual({
          sweep_id: sweepId,
          latest_run_id: runIds[1],
          btc_amount: sweep(sweepId).btc_amount,
          buy_completed_at: run(runIds[1]).filled_at,
          error_code: status,
          error_message: null,
        });
      });
    }

    for (const status of ["pending", "weird"]) {
      it(`B${status === "pending" ? 32 : 33} '${status}' -> nothing changes${status === "weird" ? " (the unvalidated cast, Suite A11a, lands here)" : ""}`, async () => {
        seed({ consecutive_failures: 1 });
        const { sweepId, runIds } = placedSweep("cb-tx-9");
        stubs.pollWithdraw.mockResolvedValue({ ok: true, withdraw: { transaction_id: "cb-tx-9", status } });
        await sched.runTick(db);
        expect(sweep(sweepId).status).toBe("placed");
        for (const id of runIds) expect(run(id).status).toBe("withdraw_placed");
        expect(cfg().consecutive_failures).toBe(1);
        expect(alerts()).toHaveLength(0);
      });
    }

    it("B34 pollWithdraw ok:false -> silent: nothing changes, no alert (S5, :1108)", async () => {
      seed();
      const { sweepId } = placedSweep("cb-tx-9");
      stubs.pollWithdraw.mockResolvedValue({ ok: false, status: 500, error: "busy" });
      await sched.runTick(db);
      expect(sweep(sweepId).status).toBe("placed");
      expect(alerts()).toHaveLength(0);
      expect(cfg()).toMatchObject({ enabled: 1, paused_reason: null, consecutive_failures: 0 });
    });

    it("B35 poll-path listAccounts 401 -> silent: NO pause, no alert (contrast B16) (S5, :1102)", async () => {
      seed();
      placedSweep("cb-tx-9");
      stubs.listAccounts.mockResolvedValue({ ok: false, status: 401, error: "nope" });
      await sched.runTick(db);
      expect(stubs.pollWithdraw).not.toHaveBeenCalled();
      expect(alerts()).toHaveLength(0);
      expect(cfg()).toMatchObject({ enabled: 1, paused_reason: null });
    });

    it("B36 poll path with no credentials -> silent: NO pause (contrast B14) (S5, :1099)", async () => {
      seed({}, { creds: false });
      placedSweep("cb-tx-9");
      await sched.runTick(db);
      expect(stubs.listAccounts).not.toHaveBeenCalled();
      expect(cfg()).toMatchObject({ enabled: 1, paused_reason: null });
    });

    it("B37 poll path with no BTC account -> silent (S5, :1104)", async () => {
      seed();
      const { sweepId } = placedSweep("cb-tx-9");
      stubs.listAccounts.mockResolvedValue({ ok: true, status: 200, data: { accounts: [ACCOUNTS.data.accounts[0]] } });
      await sched.runTick(db);
      expect(stubs.pollWithdraw).not.toHaveBeenCalled();
      expect(sweep(sweepId).status).toBe("placed");
      expect(alerts()).toHaveLength(0);
    });

    it("B38 [+] LIMIT 5: six placed sweeps -> five polls in one tick (:1094)", async () => {
      seed();
      for (let i = 0; i < 6; i++) insertSweep({ status: "placed", coinbase_tx_id: `cb-tx-${i}` });
      await sched.runTick(db);
      expect(stubs.pollWithdraw).toHaveBeenCalledTimes(5);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B39, B41 · the buy poll: no counter reset on a fill (S6), a silent failure
// (S5, :895). (The plan's numbering skips B40; no case was dropped.)
// ─────────────────────────────────────────────────────────────────────────────
describe("B · the buy poll", () => {
  beforeEach(() => at(THURSDAY));

  it("B39 a FILLED buy does NOT reset the failure counter (2 -> FILLED -> still 2); :1120 is the scheduler's only reset", async () => {
    seed({ consecutive_failures: 2 });
    const id = insertRun({ status: "buy_placed", coinbase_order_id: "ord-1" });
    stubs.pollOrder.mockResolvedValue({
      ok: true,
      order: { order_id: "ord-1", status: "FILLED", filled_size: "0.001", filled_value: "100", filled_at: new Date(nowSec() * 1000).toISOString() },
    });
    await sched.runTick(db);
    expect(run(id)).toMatchObject({ status: "awaiting_withdraw_hold", filled_btc: 0.001, filled_usd: 100, filled_at: nowSec() });
    expect(cfg().consecutive_failures).toBe(2);
  });

  it("B41 pollOrder 500 -> silent: row stays buy_placed, no alert, counter unchanged (S5, :895)", async () => {
    seed({ consecutive_failures: 1 });
    const id = insertRun({ status: "buy_placed", coinbase_order_id: "ord-1" });
    stubs.pollOrder.mockResolvedValue({ ok: false, status: 500, error: "busy" });
    await sched.runTick(db);
    expect(run(id).status).toBe("buy_placed");
    expect(alerts()).toHaveLength(0);
    expect(cfg()).toMatchObject({ enabled: 1, paused_reason: null, consecutive_failures: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B42 · runCatchUp's account check is silent (S5, :795-797). The seed follows
// catchup.route.test.ts's reset(); that suite does not cover this path.
// ─────────────────────────────────────────────────────────────────────────────
describe("B · runCatchUp", () => {
  it("B42 listAccounts 500 -> {ok:false, code: account_check_failed, reason: http_500}; no alert, no pause, no row", async () => {
    at(THURSDAY);
    seed();
    const now = nowSec();
    const ins = db.prepare(
      `INSERT INTO autobuy_runs (scheduled_for, base_unit_usd, intended_buy_usd, status, error_code, created_at, updated_at)
       VALUES (?, 100, 100, 'skipped_missed_interval', 'clamped_past_interval', ?, ?)`,
    );
    for (let i = 2; i >= 1; i--) ins.run(now - i * WEEK, now, now);
    const before = runs().length;
    stubs.listAccounts.mockResolvedValue({ ok: false, status: 500, error: "busy" });

    const res = await sched.runCatchUp(db, { intervals: 2, usd: 200 });

    expect(res).toEqual({ ok: false, code: "account_check_failed", reason: "http_500" });
    expect(stubs.listAccounts).toHaveBeenCalledTimes(1);
    expect(stubs.placeMarketBuy).not.toHaveBeenCalled();
    expect(alerts()).toHaveLength(0);
    expect(cfg()).toMatchObject({ enabled: 1, paused_reason: null, consecutive_failures: 0 });
    expect(runs()).toHaveLength(before);
  });
});
