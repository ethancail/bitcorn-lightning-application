import type Database from "better-sqlite3";
import { createLndChainAddress } from "../lightning/lnd";
import * as caps from "./caps";
import {
  listAccounts,
  placeMarketBuy,
  placeWithdraw,
  pollOrder,
  pollWithdraw,
  type CoinbaseCredentials,
} from "./coinbaseClient";
import { decrypt } from "./credentials";
import { getCurrent } from "./valuationClient";

const TICK_INTERVAL_MS = 15 * 60 * 1000;
const SWEEP_MIN_BTC = 0.0001;
const WITHDRAW_HOLD_SECONDS = 72 * 3600;

// ───────────────────────────────────────────────────────────────────────
// Public entry point
// ───────────────────────────────────────────────────────────────────────

let tickHandle: ReturnType<typeof setInterval> | null = null;

export function startScheduler(db: Database.Database): void {
  if (tickHandle) return; // already running
  // Delay the first tick 30s so the API has time to finish startup, LND
  // connection is ready, etc.
  setTimeout(() => { runTickSafe(db); }, 30_000);
  tickHandle = setInterval(() => { runTickSafe(db); }, TICK_INTERVAL_MS);
  console.log("[autobuy-scheduler] started (15-min tick)");
}

export function stopScheduler(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

let tickInFlight = false;

async function runTickSafe(db: Database.Database): Promise<void> {
  try {
    await runTick(db);
  } catch (err) {
    console.error("[autobuy-scheduler] tick failed:", err instanceof Error ? err.stack : err);
  }
}

// Exposed for POST /api/autobuy/execute-now to trigger an out-of-band tick.
// In-process guard prevents overlapping ticks — two concurrent buys with
// distinct client_order_ids would both fill on Coinbase, doubling spend.
// Single-process guard only; multi-instance deployments would need a DB-level
// lock, but v1 runs the API as a single container so in-process is sufficient.
export async function runTick(db: Database.Database): Promise<void> {
  if (tickInFlight) {
    console.warn("[autobuy-scheduler] prior tick still running, skipping");
    return;
  }
  tickInFlight = true;
  try {
    await stepEnqueueAndPlaceBuy(db);
    await stepPollBuyPlaced(db);
    await stepAssignToSweep(db);
    await stepRunSweep(db);
    await stepPollWithdraws(db);
  } finally {
    tickInFlight = false;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function loadCredentials(db: Database.Database): CoinbaseCredentials | null {
  const row = db.prepare(
    `SELECT key_name, encrypted_private_key, nonce FROM coinbase_credentials WHERE id = 1`,
  ).get() as { key_name: string; encrypted_private_key: Buffer; nonce: Buffer } | undefined;
  if (!row) return null;
  try {
    const privateKeyPem = decrypt({ ciphertext: row.encrypted_private_key, nonce: row.nonce });
    return { keyName: row.key_name, privateKeyPem };
  } catch {
    // credentials_corrupted — flag via paused_reason and return null
    db.prepare(`UPDATE autobuy_config SET enabled = 0, paused_reason = 'credentials_corrupted' WHERE id = 1`).run();
    return null;
  }
}

function pauseWithReason(db: Database.Database, reason: string): void {
  db.prepare(`UPDATE autobuy_config SET enabled = 0, paused_reason = ? WHERE id = 1`).run(reason);
}

function readConfig(db: Database.Database) {
  return db.prepare(`SELECT * FROM autobuy_config WHERE id = 1`).get() as {
    id: number;
    enabled: number;
    base_unit_usd: number;
    frequency: string;
    zone_multipliers: string;
    withdraw_address: string;
    withdraw_address_whitelisted_at: number | null;
    sweep_day_of_week: number;
    consecutive_failures: number;
    paused_reason: string | null;
    last_run_at: number | null;
    next_run_at: number | null;
  };
}

function frequencyToSeconds(frequency: string): number {
  switch (frequency) {
    case "daily": return 86400;
    case "weekly": return 7 * 86400;
    case "biweekly": return 14 * 86400;
    case "monthly": return 30 * 86400;
    default: return 7 * 86400;
  }
}

function computeIntendedBuy(baseUnit: number, multiplier: number): number {
  return Math.round(baseUnit * multiplier * 100) / 100;
}

// ───────────────────────────────────────────────────────────────────────
// Step 1: Enqueue scheduled + place buy
// ───────────────────────────────────────────────────────────────────────

async function stepEnqueueAndPlaceBuy(db: Database.Database): Promise<void> {
  const gate = caps.canSchedule(db);
  if (!gate.ok) return; // not enabled / paused / over failure threshold

  const cfg = readConfig(db);
  if (!cfg.withdraw_address_whitelisted_at) {
    pauseWithReason(db, "address_not_whitelisted");
    return;
  }

  const now = nowSec();
  if (cfg.next_run_at && now < cfg.next_run_at) return; // not due yet

  // If a scheduled row already exists (previous tick created one but didn't
  // transition it — e.g. because credentials were missing), let that one run.
  const pending = db.prepare(`SELECT id FROM autobuy_runs WHERE status = 'scheduled' LIMIT 1`).get() as
    | { id: number } | undefined;
  if (pending) return; // will be handled on the next step's existing path

  // Fetch composite valuation
  const val = await getCurrent();
  if (!val) {
    console.warn("[autobuy-scheduler] no valuation data; skipping tick");
    return;
  }

  const freshness = caps.checkValuationFreshness(val.updated_at);
  if (!freshness.ok) {
    insertSkippedRow(db, "skipped_stale_data", freshness.reason, null, val);
    scheduleNext(db, cfg);
    return;
  }

  // Resolve multiplier from zone
  const mult = parseZoneMultiplier(cfg.zone_multipliers, val.zone);
  if (mult === 0) {
    insertSkippedRow(db, "skipped_zero_multiplier", `zone=${val.zone}`, 0, val);
    scheduleNext(db, cfg);
    return;
  }

  const intendedUsd = computeIntendedBuy(cfg.base_unit_usd, mult);

  const singleCap = caps.checkSingleBuyCap(intendedUsd);
  if (!singleCap.ok) {
    insertSkippedRow(db, "skipped_cap_hit", singleCap.reason, mult, val, intendedUsd);
    scheduleNext(db, cfg);
    return;
  }

  const rollingCap = caps.checkRollingCaps(db, intendedUsd);
  if (!rollingCap.ok) {
    insertSkippedRow(db, "skipped_cap_hit", rollingCap.reason, mult, val, intendedUsd);
    scheduleNext(db, cfg);
    return;
  }

  // Need credentials to proceed — also do a balance check
  const creds = loadCredentials(db);
  if (!creds) {
    pauseWithReason(db, "no_credentials");
    return;
  }

  const accounts = await listAccounts(creds);
  if (!accounts.ok) {
    if (accounts.status === 401 || accounts.status === 403) {
      pauseWithReason(db, "credentials_invalid");
      return;
    }
    console.warn(`[autobuy-scheduler] account check failed: ${accounts.status} ${accounts.error}`);
    return;
  }

  const usdAcct = accounts.data.accounts.find((a) => a.currency === "USD");
  const parsed = usdAcct ? Number(usdAcct.available_balance.value) : 0;
  const usdBalance = Number.isFinite(parsed) ? parsed : 0;
  if (usdBalance < intendedUsd) {
    insertSkippedRow(db, "skipped_insufficient_usd", `usd_balance=${usdBalance}`, mult, val, intendedUsd);
    scheduleNext(db, cfg);
    return;
  }

  // All checks pass — place the buy.
  // TODO: v1 known limitation — if placeMarketBuy returns a network-level error
  // (status=0), Coinbase may still have committed the order. On the next tick
  // this path would generate a fresh client_order_id and could double-fill.
  // Future: reconcile by querying Coinbase for recent autobuy-prefixed orders
  // before re-placing. For v1 we accept this low-probability edge; operators
  // have per-buy + rolling caps as the outer containment.
  const placed = await placeMarketBuy(creds, intendedUsd);
  if (!placed.ok) {
    insertFailedBuyRow(db, placed.error, mult, val, intendedUsd, null);
    caps.recordFailure(db);
    scheduleNext(db, cfg);
    return;
  }

  db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, coinbase_order_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'buy_placed', ?, ?, ?)`,
  ).run(
    now, val.z_score, val.zone, mult, cfg.base_unit_usd, intendedUsd,
    placed.order_id, now, now,
  );
  scheduleNext(db, cfg);
  console.log(`[autobuy-scheduler] placed buy order=${placed.order_id} usd=${intendedUsd} zone=${val.zone}`);
}

function parseZoneMultiplier(zoneMultipliersJson: string, zone: string): number {
  try {
    const m = JSON.parse(zoneMultipliersJson) as Record<string, number>;
    const v = m[zone];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function insertSkippedRow(
  db: Database.Database,
  status: string,
  reason: string,
  multiplier: number | null,
  val: { z_score: number; zone: string },
  intendedUsd: number | null = null,
): void {
  const now = nowSec();
  db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, error_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(now, val.z_score, val.zone, multiplier, intendedUsd, status, reason, now, now);
}

function insertFailedBuyRow(
  db: Database.Database,
  errorMessage: string,
  multiplier: number,
  val: { z_score: number; zone: string },
  intendedUsd: number,
  orderId: string | null,
): void {
  const now = nowSec();
  db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, coinbase_order_id, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'failed_buy', ?, ?, ?, ?)`,
  ).run(now, val.z_score, val.zone, multiplier, intendedUsd, orderId, errorMessage.slice(0, 500), now, now);
}

function scheduleNext(
  db: Database.Database,
  cfg: { frequency: string; next_run_at: number | null },
): void {
  const now = nowSec();
  const increment = frequencyToSeconds(cfg.frequency);
  const base = cfg.next_run_at && cfg.next_run_at > 0 ? cfg.next_run_at : now;
  const nextRunAt = base + increment;
  db.prepare(`UPDATE autobuy_config SET last_run_at = ?, next_run_at = ? WHERE id = 1`).run(now, nextRunAt);
}

// ───────────────────────────────────────────────────────────────────────
// Step 2: Poll buy_placed → buy_filled or failed_buy
// ───────────────────────────────────────────────────────────────────────

async function stepPollBuyPlaced(db: Database.Database): Promise<void> {
  const rows = db.prepare(
    `SELECT id, coinbase_order_id FROM autobuy_runs WHERE status = 'buy_placed' LIMIT 10`,
  ).all() as Array<{ id: number; coinbase_order_id: string }>;
  if (rows.length === 0) return;

  const creds = loadCredentials(db);
  if (!creds) { pauseWithReason(db, "no_credentials"); return; }

  for (const row of rows) {
    const res = await pollOrder(creds, row.coinbase_order_id);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        pauseWithReason(db, "credentials_invalid");
        return;
      }
      console.warn(`[autobuy-scheduler] pollOrder failed order=${row.coinbase_order_id}: ${res.error}`);
      continue; // next tick retries
    }
    const order = res.order;
    const now = nowSec();
    if (order.status === "FILLED") {
      const parsedMs = order.filled_at ? Date.parse(order.filled_at) : NaN;
      const filledAt = Number.isFinite(parsedMs) ? Math.floor(parsedMs / 1000) : now;
      const filledBtc = Number(order.filled_size);
      const filledUsd = Number(order.filled_value);
      if (!Number.isFinite(filledBtc) || !Number.isFinite(filledUsd)) {
        db.prepare(
          `UPDATE autobuy_runs
           SET status = 'failed_buy', error_code = 'unparseable_fill_amount', updated_at = ?
           WHERE id = ?`,
        ).run(now, row.id);
        caps.recordFailure(db);
        console.warn(`[autobuy-scheduler] unparseable fill amounts order=${row.coinbase_order_id} size=${order.filled_size} value=${order.filled_value}`);
        continue;
      }
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'buy_filled', filled_btc = ?, filled_usd = ?, filled_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(filledBtc, filledUsd, filledAt, now, row.id);
      console.log(`[autobuy-scheduler] filled order=${row.coinbase_order_id} btc=${filledBtc} usd=${filledUsd}`);
    } else if (order.status === "CANCELLED" || order.status === "EXPIRED" || order.status === "FAILED") {
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'failed_buy', error_code = ?, updated_at = ?
         WHERE id = ?`,
      ).run(order.status.toLowerCase(), now, row.id);
      caps.recordFailure(db);
    }
    // OPEN / PENDING → leave as-is, poll again next tick
  }
}

// ───────────────────────────────────────────────────────────────────────
// Step 3: Past-hold buy_filled → awaiting_withdraw_hold → sweep_assigned
// ───────────────────────────────────────────────────────────────────────

async function stepAssignToSweep(db: Database.Database): Promise<void> {
  const now = nowSec();
  const cutoff = now - WITHDRAW_HOLD_SECONDS;

  // Rows whose hold has elapsed → sweep_assigned. Covers both buy_filled
  // and awaiting_withdraw_hold states, so a row can skip the intermediate
  // rename if it was filled long enough ago.
  db.prepare(
    `UPDATE autobuy_runs
     SET status = 'sweep_assigned', updated_at = ?
     WHERE status IN ('buy_filled', 'awaiting_withdraw_hold')
       AND filled_at IS NOT NULL
       AND filled_at <= ?`,
  ).run(now, cutoff);

  // Remaining buy_filled rows are genuinely still in their hold → rename for
  // operator visibility. Skip rows without filled_at (shouldn't happen, but
  // don't strand them in awaiting_withdraw_hold if it does).
  db.prepare(
    `UPDATE autobuy_runs
     SET status = 'awaiting_withdraw_hold', updated_at = ?
     WHERE status = 'buy_filled' AND filled_at IS NOT NULL AND filled_at > ?`,
  ).run(now, cutoff);
}

// ───────────────────────────────────────────────────────────────────────
// Step 4: Daily sweep gate — runs at most once per UTC day
// ───────────────────────────────────────────────────────────────────────

async function stepRunSweep(db: Database.Database): Promise<void> {
  const cfg = readConfig(db);
  if (!cfg.withdraw_address_whitelisted_at) return;

  const nowDate = new Date();
  const todayDow = nowDate.getUTCDay(); // 0=Sunday
  if (todayDow !== cfg.sweep_day_of_week) return;

  const todayStart = Math.floor(Date.UTC(
    nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate(),
  ) / 1000);
  const alreadySwept = db.prepare(
    `SELECT id FROM autobuy_sweeps WHERE swept_at >= ? LIMIT 1`,
  ).get(todayStart) as { id: number } | undefined;
  if (alreadySwept) return;

  // Total BTC across sweep_assigned rows
  const totalRow = db.prepare(
    `SELECT COALESCE(SUM(filled_btc), 0) AS total
     FROM autobuy_runs WHERE status = 'sweep_assigned'`,
  ).get() as { total: number };
  if (totalRow.total < SWEEP_MIN_BTC) return; // defer, retry next week

  const creds = loadCredentials(db);
  if (!creds) { pauseWithReason(db, "no_credentials"); return; }

  const accounts = await listAccounts(creds);
  if (!accounts.ok) {
    if (accounts.status === 401 || accounts.status === 403) {
      pauseWithReason(db, "credentials_invalid");
    }
    return;
  }
  const btcAcct = accounts.data.accounts.find((a) => a.currency === "BTC");
  if (!btcAcct) {
    console.warn("[autobuy-scheduler] no BTC account found");
    return;
  }

  const withdrawResult = await placeWithdraw(
    creds, btcAcct.uuid, cfg.withdraw_address, totalRow.total,
  );
  const now = nowSec();

  if (!withdrawResult.ok) {
    // Record a failed sweep row for audit + mark all assigned runs as failed_withdraw
    const errorCode = withdrawResult.status === 400 ? "address_not_whitelisted" : `http_${withdrawResult.status}`;
    db.prepare(
      `INSERT INTO autobuy_sweeps (swept_at, btc_amount, status, error_code, error_message)
       VALUES (?, ?, 'failed', ?, ?)`,
    ).run(now, totalRow.total, errorCode, withdrawResult.error.slice(0, 500));
    db.prepare(
      `UPDATE autobuy_runs
       SET status = 'failed_withdraw', error_message = ?, updated_at = ?
       WHERE status = 'sweep_assigned'`,
    ).run(withdrawResult.error.slice(0, 500), now);
    if (withdrawResult.status === 400) {
      pauseWithReason(db, "address_not_whitelisted");
    }
    caps.recordFailure(db);
    return;
  }

  // Create the sweep row + link all sweep_assigned runs to it + transition them
  const sweepInsert = db.prepare(
    `INSERT INTO autobuy_sweeps (swept_at, btc_amount, coinbase_tx_id, status)
     VALUES (?, ?, ?, 'placed') RETURNING id`,
  ).get(now, totalRow.total, withdrawResult.transaction_id) as { id: number };

  db.prepare(
    `UPDATE autobuy_runs
     SET status = 'withdraw_placed', withdraw_sweep_id = ?, updated_at = ?
     WHERE status = 'sweep_assigned'`,
  ).run(sweepInsert.id, now);
  console.log(`[autobuy-scheduler] sweep placed tx=${withdrawResult.transaction_id} btc=${totalRow.total}`);
}

// ───────────────────────────────────────────────────────────────────────
// Step 5: Poll withdraw_placed sweeps → confirmed / failed
// ───────────────────────────────────────────────────────────────────────

async function stepPollWithdraws(db: Database.Database): Promise<void> {
  const sweeps = db.prepare(
    `SELECT id, coinbase_tx_id FROM autobuy_sweeps WHERE status = 'placed' LIMIT 5`,
  ).all() as Array<{ id: number; coinbase_tx_id: string }>;
  if (sweeps.length === 0) return;

  const creds = loadCredentials(db);
  if (!creds) return;

  const accounts = await listAccounts(creds);
  if (!accounts.ok) return;
  const btcAcct = accounts.data.accounts.find((a) => a.currency === "BTC");
  if (!btcAcct) return;

  for (const sweep of sweeps) {
    const res = await pollWithdraw(creds, btcAcct.uuid, sweep.coinbase_tx_id);
    if (!res.ok) continue; // retry next tick

    const now = nowSec();
    if (res.withdraw.status === "completed") {
      db.prepare(
        `UPDATE autobuy_sweeps SET status = 'confirmed', withdraw_txid = ? WHERE id = ?`,
      ).run(res.withdraw.network_tx_hash ?? null, sweep.id);
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'withdraw_confirmed', withdraw_txid = ?, updated_at = ?
         WHERE withdraw_sweep_id = ? AND status = 'withdraw_placed'`,
      ).run(res.withdraw.network_tx_hash ?? null, now, sweep.id);
      caps.resetFailureCounter(db);
      console.log(`[autobuy-scheduler] sweep confirmed sweep=${sweep.id} txid=${res.withdraw.network_tx_hash ?? "<pending>"}`);
    } else if (res.withdraw.status === "failed" || res.withdraw.status === "cancelled") {
      db.prepare(
        `UPDATE autobuy_sweeps SET status = 'failed', error_code = ? WHERE id = ?`,
      ).run(res.withdraw.status, sweep.id);
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'failed_withdraw', updated_at = ?
         WHERE withdraw_sweep_id = ? AND status = 'withdraw_placed'`,
      ).run(now, sweep.id);
      caps.recordFailure(db);
    }
    // "pending" → leave as-is
  }
}

/**
 * Fresh withdraw address provisioning — called from GET /api/autobuy/status
 * if the config's withdraw_address is empty. Generates one via LND and
 * persists it. The operator then whitelists it in Coinbase.
 */
export async function ensureWithdrawAddress(db: Database.Database): Promise<string> {
  const cfg = readConfig(db);
  if (cfg.withdraw_address) return cfg.withdraw_address;
  const { address } = await createLndChainAddress();
  // Conditional write — if another caller beat us to it, keep theirs.
  db.prepare(
    `UPDATE autobuy_config
     SET withdraw_address = ?
     WHERE id = 1 AND (withdraw_address IS NULL OR withdraw_address = '')`,
  ).run(address);
  const after = db.prepare(`SELECT withdraw_address FROM autobuy_config WHERE id = 1`).get() as { withdraw_address: string };
  return after.withdraw_address;
}
