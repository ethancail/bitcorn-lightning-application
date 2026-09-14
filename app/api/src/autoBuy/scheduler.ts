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
import {
  selectCurrency,
  currenciesCheckedFor,
  type CurrencyPreference,
} from "./currency";
import { classifyCoinbaseError, type AlertType } from "./alerts";
import { raiseAlert, clearAlerts } from "./alertStore";
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

// Route a placement/poll failure to the right alert type via the shared
// classifier (spec §2/§6): a 401/403 surfacing as a failed_buy error routes to
// AUTH_FAILURE, a 429/5xx to RATE_LIMITED, everything else to ORDER_FAILED.
// Additive only — does not change buy/pause semantics (the caller still writes
// the failed_buy row and records the failure).
function raiseOrderFailureAlert(
  db: Database.Database,
  httpStatus: number,
  errorText: string,
  runId: number,
  orderStatus: string | null,
): void {
  const cls = classifyCoinbaseError(httpStatus, errorText);
  let type: AlertType;
  let context: Record<string, unknown>;
  if (cls === "auth") {
    type = "AUTOBUY_AUTH_FAILURE";
    context = { paused_reason: null, http_status: httpStatus, source: "order_placement", error: errorText };
  } else if (cls === "rate_limit") {
    type = "AUTOBUY_RATE_LIMITED";
    context = { http_status: httpStatus, retry_after: null, source: "order_placement", error: errorText };
  } else {
    type = "AUTOBUY_ORDER_FAILED";
    context = { latest_run_id: runId, error_code: null, error_message: errorText, order_status: orderStatus };
  }
  raiseAlert(db, { type, latestRunId: runId, context });
}

function readConfig(db: Database.Database) {
  return db.prepare(`SELECT * FROM autobuy_config WHERE id = 1`).get() as {
    id: number;
    enabled: number;
    base_unit_usd: number;
    frequency: string;
    zone_multipliers: string;
    currency_preference: string;
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
  const valResult = await getCurrent();
  if (!valResult.ok) {
    console.warn(
      `[autobuy-scheduler] no valuation data (${valResult.error.kind}); skipping tick`,
    );
    return;
  }
  const val = valResult.value;

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
      raiseAlert(db, {
        type: "AUTOBUY_AUTH_FAILURE",
        latestRunId: null,
        context: { paused_reason: "credentials_invalid", http_status: accounts.status, source: "list_accounts", error: accounts.error },
      });
      return;
    }
    // Non-auth listAccounts failure (429 / 5xx / network) — previously silent.
    // Scenario 3: raise a transient rate-limit/unavailable alert (spec §2).
    raiseAlert(db, {
      type: "AUTOBUY_RATE_LIMITED",
      latestRunId: null,
      context: { http_status: accounts.status, retry_after: null, source: "list_accounts", error: accounts.error },
    });
    console.warn(`[autobuy-scheduler] account check failed: ${accounts.status} ${accounts.error}`);
    return;
  }
  // listAccounts ok — credentials demonstrably valid and the API reachable.
  // Clear any active auth / rate-limit alerts (spec §3 aggressive api_ok clear).
  clearAlerts(db, "api_ok");

  // Read both USD and USDC balances; an absent account is treated as 0
  // (mirroring the existing Number.isFinite guard). selectCurrency (§2) then
  // picks which to spend, bounded by the configured preference.
  const usdAcct = accounts.data.accounts.find((a) => a.currency === "USD");
  const parsedUsd = usdAcct ? Number(usdAcct.available_balance.value) : 0;
  const usdBalance = Number.isFinite(parsedUsd) ? parsedUsd : 0;

  const usdcAcct = accounts.data.accounts.find((a) => a.currency === "USDC");
  const parsedUsdc = usdcAcct ? Number(usdcAcct.available_balance.value) : 0;
  const usdcBalance = Number.isFinite(parsedUsdc) ? parsedUsdc : 0;

  const preference = cfg.currency_preference as CurrencyPreference;
  const currenciesChecked = currenciesCheckedFor(preference);
  const currency = selectCurrency(preference, usdBalance, usdcBalance, intendedUsd);
  if (!currency) {
    // Shortfall in the selected currency/currencies — skip, place no order (§7).
    const detail =
      preference === "usd_only"  ? `usd_balance=${usdBalance}`
    : preference === "usdc_only" ? `usdc_balance=${usdcBalance}`
    :                              `usd_balance=${usdBalance};usdc_balance=${usdcBalance}`;
    const scope =
      preference === "usd_only"  ? `(usd_only) usd=${usdBalance}`
    : preference === "usdc_only" ? `(usdc_only) usdc=${usdcBalance}`
    :                              `(both) usd=${usdBalance} usdc=${usdcBalance}`;
    const runId = insertSkippedRow(db, "skipped_insufficient_funds", detail, mult, val, intendedUsd, currenciesChecked);
    raiseAlert(db, {
      type: "AUTOBUY_INSUFFICIENT_FUNDS",
      latestRunId: runId,
      context: {
        currencies_checked: currenciesChecked,
        usd_balance: usdBalance,
        usdc_balance: usdcBalance,
        intended_buy_usd: intendedUsd,
      },
    });
    console.log(`[autobuy-scheduler] skip: insufficient funds ${scope} need=${intendedUsd}`);
    scheduleNext(db, cfg);
    return;
  }

  // All checks pass — place the buy in the selected currency.
  // TODO: v1 known limitation — if placeMarketBuy returns a network-level error
  // (status=0), Coinbase may still have committed the order. On the next tick
  // this path would generate a fresh client_order_id and could double-fill.
  // Future: reconcile by querying Coinbase for recent autobuy-prefixed orders
  // before re-placing. For v1 we accept this low-probability edge; operators
  // have per-buy + rolling caps as the outer containment.
  const placed = await placeMarketBuy(creds, intendedUsd, currency);
  if (!placed.ok) {
    const runId = insertFailedBuyRow(db, placed.error, mult, val, intendedUsd, null, currenciesChecked);
    raiseOrderFailureAlert(db, placed.status, placed.error, runId, null);
    caps.recordFailure(db);
    scheduleNext(db, cfg);
    return;
  }

  db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, coinbase_order_id, currencies_checked, currency_used, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'buy_placed', ?, ?, ?, ?, ?)`,
  ).run(
    now, val.z_score, val.zone, mult, cfg.base_unit_usd, intendedUsd,
    placed.order_id, currenciesChecked, currency, now, now,
  );
  // Buy placed successfully — clear any active insufficient-funds / order-failed
  // alerts (spec §3). Auth / rate-limit already cleared via the api_ok above.
  clearAlerts(db, "buy");
  scheduleNext(db, cfg);
  console.log(`[autobuy-scheduler] placed buy order=${placed.order_id} ${currency.toLowerCase()}=${intendedUsd} zone=${val.zone}`);
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
  currenciesChecked: string | null = null,
): number {
  const now = nowSec();
  const info = db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, error_code, currencies_checked, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(now, val.z_score, val.zone, multiplier, intendedUsd, status, reason, currenciesChecked, now, now);
  return Number(info.lastInsertRowid);
}

function insertFailedBuyRow(
  db: Database.Database,
  errorMessage: string,
  multiplier: number,
  val: { z_score: number; zone: string },
  intendedUsd: number,
  orderId: string | null,
  currenciesChecked: string | null = null,
): number {
  const now = nowSec();
  const info = db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, coinbase_order_id, error_message, currencies_checked, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'failed_buy', ?, ?, ?, ?, ?)`,
  ).run(now, val.z_score, val.zone, multiplier, intendedUsd, orderId, errorMessage.slice(0, 500), currenciesChecked, now, now);
  return Number(info.lastInsertRowid);
}

/**
 * THE STATUS VALUE `skipped_missed_interval` — ITS CONTRACT.
 *
 * ⚠ THIS IS A WIRE VALUE, NOT AN API-INTERNAL TOKEN. It crosses the HTTP
 * boundary in BOTH directions and is therefore load-bearing API:
 *   · OUT — as `autobuy_runs.status` in GET /api/autobuy/status (`recent`)
 *     and GET /api/autobuy/history (`rows`).
 *   · IN  — the history route filters on exact equality against whatever
 *     string the client sends (`WHERE status = ?`), and the web filter
 *     `<option value="skipped_missed_interval">` sends precisely this token.
 * Renaming it silently breaks any saved filter and any stored row. Treat it
 * as a released string.
 *
 * WHAT IT MEANS: a scheduled interval that ELAPSED WITHOUT A TICK EVALUATING
 * IT. It is NOT one of the four `skipped_*` values, all of which mean "a tick
 * ran and declined for reason X". A passed-over interval had no tick at all,
 * and saying the scheduler declined would be the exact misdescription this
 * whole arc exists to remove.
 *
 * WHAT MAY CONSUME IT: display and filtering only. No API-side code branches
 * on it, and none should — `caps.checkRollingCaps` and the status payload's
 * in-flight list both ENUMERATE the states they include, so this value is
 * excluded by construction rather than by an explicit test.
 *
 * WHAT MAY NOT: it must not be read as evidence of a decision, a spend, or a
 * failure. These rows carry no `filled_usd` and never will.
 *
 * The `skipped_` prefix is deliberate, so the web StatusBadge fallback and any
 * future `LIKE 'skipped_%'` query degrade sensibly.
 *
 * Spec: bitcorn-research/specs/2026-09-14-autobuy-scheduler-catchup-clamp-spec.md §3 R3.
 */
const STATUS_MISSED_INTERVAL = "skipped_missed_interval";

/**
 * Advance the cursor, CLAMPED so it can never land in the past, and record
 * every whole interval the clamp stepped over.
 *
 * Before the clamp, a cursor k intervals stale advanced by exactly one
 * increment per tick, so the scheduler bought k times across k consecutive
 * ticks — a burst nobody chose. Now it fires once and resumes.
 *
 * §1.5 (settled by Ethan, OVERRIDING the recommendation to preserve phase):
 * the cadence RE-PHASES. `base = max(stored, now)`, so a member whose weekly
 * buy landed on Mondays resumes on whatever weekday recovery happened. The
 * rejected alternative — advance to the next ORIGINAL slot — is recorded in
 * the spec; it is not what this implements.
 *
 * Spec: …-catchup-clamp-spec.md §2 (C1–C4), §3 (R1).
 */
function scheduleNext(
  db: Database.Database,
  cfg: { frequency: string; next_run_at: number | null; base_unit_usd: number },
): void {
  const now = nowSec();
  const increment = frequencyToSeconds(cfg.frequency);
  const stored = cfg.next_run_at && cfg.next_run_at > 0 ? cfg.next_run_at : now;

  // C1: never behind now. For a current or future cursor this is `stored` and
  // the behaviour is exactly today's; the clamp bites ONLY when stored < now.
  const base = Math.max(stored, now);
  const nextRunAt = base + increment;

  // C3/R1: how many whole intervals did the cursor pass over? The tick that is
  // running consumed the slot at `stored`, and `base` consumes the slot at
  // `now`, so the genuinely passed-over slots are i = 1 … k-1. A current,
  // future or null cursor gives k <= 1 and the loop body never runs.
  const k = stored < now ? Math.ceil((now - stored) / increment) : 0;
  for (let i = 1; i < k; i++) {
    insertMissedIntervalRow(db, stored + i * increment, cfg.base_unit_usd);
  }

  db.prepare(`UPDATE autobuy_config SET last_run_at = ?, next_run_at = ? WHERE id = 1`).run(now, nextRunAt);
}

/**
 * One row per interval the clamp stepped over (§3 R1).
 *
 * `scheduled_for` is the ORIGINAL slot, not the moment of discovery, so the
 * history shows WHEN the buy was missed. `multiplier`, `z_score` and `zone`
 * are NULL on purpose: the valuation at the missed moment is unknowable
 * retroactively, and a stored number there would be a guess wearing a fact's
 * clothes.
 */
function insertMissedIntervalRow(db: Database.Database, slot: number, baseUnitUsd: number): void {
  const now = nowSec();
  db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, error_code, created_at, updated_at)
     VALUES (?, NULL, NULL, NULL, ?, ?, ?, 'clamped_past_interval', ?, ?)`,
  ).run(slot, baseUnitUsd, baseUnitUsd, STATUS_MISSED_INTERVAL, now, now);
}

// ───────────────────────────────────────────────────────────────────────
// The member-elected catch-up (spec §4)
//
// A ONE-TIME EXPLICIT ACTION, not a setting (§1.1). A setting would recreate
// the present defect for anyone who enables it and forgets — and the defect
// exists precisely because nobody chose the behaviour.
//
// ONE AGGREGATE ORDER, not one per missed tick (§1.4): N orders over N ticks is
// the burst behaviour in slow motion, same fee count, same price exposure.
// ───────────────────────────────────────────────────────────────────────

/** An unclaimed passed-over interval. */
type MissedRow = { id: number; scheduled_for: number };

function readUnclaimedMissed(db: Database.Database): MissedRow[] {
  return db.prepare(
    `SELECT id, scheduled_for FROM autobuy_runs
      WHERE status = ? AND claimed_by_run_id IS NULL
      ORDER BY scheduled_for ASC`,
  ).all(STATUS_MISSED_INTERVAL) as MissedRow[];
}

/**
 * The largest whole number of intervals that fits the tighter rolling window.
 *
 * WHOLE-INTERVAL granularity is the spec's recommendation (§4 A2, D5 §6): a
 * partial interval is not a thing the member ever chose to buy, and offering
 * "$37 of a $100 buy" invents a unit the product does not have.
 */
function fittingIntervals(count: number, unitUsd: number, headroomUsd: number): number {
  if (unitUsd <= 0) return 0;
  // Nudge for float dust: 10 × 100.00 must fit exactly 1000.00 headroom.
  const fits = Math.floor((headroomUsd + 1e-9) / unitUsd);
  return Math.max(0, Math.min(count, fits));
}

const roundUsd = (n: number): number => Math.round(n * 100) / 100;

export type MissedSummary = {
  intervals: number;
  base_unit_usd: number;
  oldest_slot: number;
  newest_slot: number;
  /** null when the valuation is unavailable — count and slots still stand. */
  multiplier: number | null;
  zone: string | null;
  valuation_updated_at: string | null;
  estimated_usd: number | null;
  /** The portion that fits current rolling headroom. null without a valuation. */
  fits_now: { intervals: number; estimated_usd: number } | null;
  /** What stays claimable after fits_now. null when nothing is withheld. */
  remainder: { intervals: number; estimated_usd: number } | null;
};

/**
 * What the member is shown BEFORE they act (§4 A2).
 *
 * Returns null when there is nothing unclaimed — A1 is explicit that the block
 * renders nothing at all in that case: no empty state, no "0 missed".
 *
 * ⚠ Every amount here is an ESTIMATE AT DISPLAY TIME. The order is placed at
 * action time against the valuation and the headroom then, which is why
 * runCatchUp re-derives rather than trusting anything computed here.
 */
export async function computeMissedSummary(db: Database.Database): Promise<MissedSummary | null> {
  const missed = readUnclaimedMissed(db);
  if (missed.length === 0) return null;

  const cfg = readConfig(db);
  const base: MissedSummary = {
    intervals: missed.length,
    base_unit_usd: cfg.base_unit_usd,
    oldest_slot: missed[0].scheduled_for,
    newest_slot: missed[missed.length - 1].scheduled_for,
    multiplier: null,
    zone: null,
    valuation_updated_at: null,
    estimated_usd: null,
    fits_now: null,
    remainder: null,
  };

  // A valuation failure DEGRADES this block rather than removing it: the
  // member still learns how many intervals were missed and when.
  const valResult = await getCurrent();
  if (!valResult.ok) return base;
  const val = valResult.value;
  const mult = parseZoneMultiplier(cfg.zone_multipliers, val.zone);

  const unit = computeIntendedBuy(cfg.base_unit_usd, mult);
  const headroom = capsHeadroomUsd(db);
  const k = fittingIntervals(missed.length, unit, headroom);

  return {
    ...base,
    multiplier: mult,
    zone: val.zone,
    valuation_updated_at: val.updated_at,
    estimated_usd: roundUsd(missed.length * unit),
    fits_now: { intervals: k, estimated_usd: roundUsd(k * unit) },
    remainder:
      k < missed.length
        ? { intervals: missed.length - k, estimated_usd: roundUsd((missed.length - k) * unit) }
        : null,
  };
}

/** The binding rolling headroom — the tighter of the 7-day and 30-day windows. */
function capsHeadroomUsd(db: Database.Database): number {
  const h = caps.rollingHeadroom(db);
  return Math.min(h.d7.headroom, h.d30.headroom);
}

export type CatchUpRefusalCode =
  | "not_schedulable"
  | "address_not_whitelisted"
  | "valuation_unavailable"
  | "valuation_stale"
  | "zero_multiplier"
  | "nothing_to_claim"
  | "rolling_cap_no_headroom"
  | "amount_changed"
  | "no_credentials"
  | "account_check_failed"
  | "insufficient_funds"
  | "order_failed";

export type CatchUpResult =
  | {
      ok: true;
      run_id: number;
      intervals: number;
      usd: number;
      currency: string;
      order_id: string;
      /** Intervals deliberately left claimable — the D5 remainder. */
      remainder_intervals: number;
    }
  | {
      ok: false;
      code: CatchUpRefusalCode;
      reason: string;
      /** On amount_changed: what the server re-derived, for the UI to re-show. */
      actual?: { intervals: number; usd: number };
    };

/**
 * Buy the missed intervals the member confirmed (§4 A5).
 *
 * ⚠ THE SINGLE-BUY CAP IS DELIBERATELY NOT CHECKED HERE. Decided by Ethan in
 * decisions/2026-09-14-single-buy-cap-does-not-bind-confirmed-catchup.md (D4):
 * AUTOBUY_MAX_SINGLE_BUY_USD is an UNATTENDED-AUTOMATION bound — its own
 * comment says "per single scheduled buy" — whereas a catch-up's control is the
 * member's confirmation of the actual amount. Leaving it in would make the cap
 * a DE FACTO EXPIRY, contradicting the settled "a missed interval does not
 * expire". The AUTOMATED path at stepEnqueueAndPlaceBuy keeps the cap and is
 * unchanged; scheduler.clamp/catchup tests pin both directions.
 *
 * ⚠ THE ROLLING CAPS STILL BIND, but a bind is not a refusal (D5). The fitting
 * portion is placed and the remainder stays claimable. Only k = 0 refuses.
 *
 * ORDER-OF-OPERATIONS NOTE, reported as a deviation from a literal reading of
 * A5: A5 says "re-derive … refuse 409 … then run the gate sequence", but the
 * D5 correction requires the 409 to compare the FITTING PORTION, which cannot
 * be computed without the valuation (for the multiplier) and the live headroom.
 * So the valuation gates run BEFORE the 409 check. Every gate still refuses
 * with its own reason and places nothing.
 */
export async function runCatchUp(
  db: Database.Database,
  expected: { intervals: number; usd: number },
): Promise<CatchUpResult> {
  const gate = caps.canSchedule(db);
  if (!gate.ok) return { ok: false, code: "not_schedulable", reason: gate.reason };

  const cfg = readConfig(db);
  if (!cfg.withdraw_address_whitelisted_at) {
    return { ok: false, code: "address_not_whitelisted", reason: "address_not_whitelisted" };
  }

  const valResult = await getCurrent();
  if (!valResult.ok) {
    // Reuse the scheduler's own cause taxonomy rather than inventing a second.
    return { ok: false, code: "valuation_unavailable", reason: valResult.error.kind };
  }
  const val = valResult.value;

  const freshness = caps.checkValuationFreshness(val.updated_at);
  if (!freshness.ok) return { ok: false, code: "valuation_stale", reason: freshness.reason };

  const mult = parseZoneMultiplier(cfg.zone_multipliers, val.zone);
  if (mult === 0) return { ok: false, code: "zero_multiplier", reason: `zone=${val.zone}` };

  const missed = readUnclaimedMissed(db);
  if (missed.length === 0) return { ok: false, code: "nothing_to_claim", reason: "no_unclaimed_intervals" };

  const unit = computeIntendedBuy(cfg.base_unit_usd, mult);
  const h = caps.rollingHeadroom(db);
  const headroom = Math.min(h.d7.headroom, h.d30.headroom);
  const k = fittingIntervals(missed.length, unit, headroom);
  if (k === 0) {
    // The ONLY rolling refusal left on this path: not even one interval fits.
    const binding = h.d7.headroom <= h.d30.headroom ? "7d" : "30d";
    return {
      ok: false,
      code: "rolling_cap_no_headroom",
      reason: `${binding}_cap_headroom:${headroom.toFixed(2)}<${unit.toFixed(2)}`,
    };
  }

  const total = roundUsd(k * unit);

  // The member confirmed a NUMBER, not a procedure. If the world moved between
  // display and confirm — a zone flip, a competing spend eating headroom, a
  // concurrent claim — refuse and re-show rather than spend a different amount.
  if (expected.intervals !== k || roundUsd(expected.usd) !== total) {
    return {
      ok: false,
      code: "amount_changed",
      reason: `expected ${expected.intervals}x/$${roundUsd(expected.usd)}, derived ${k}x/$${total}`,
      actual: { intervals: k, usd: total },
    };
  }

  const creds = loadCredentials(db);
  if (!creds) return { ok: false, code: "no_credentials", reason: "no_credentials" };

  const accounts = await listAccounts(creds);
  if (!accounts.ok) {
    return { ok: false, code: "account_check_failed", reason: `http_${accounts.status}` };
  }

  const usdAcct = accounts.data.accounts.find((a) => a.currency === "USD");
  const parsedUsd = usdAcct ? Number(usdAcct.available_balance.value) : 0;
  const usdBalance = Number.isFinite(parsedUsd) ? parsedUsd : 0;
  const usdcAcct = accounts.data.accounts.find((a) => a.currency === "USDC");
  const parsedUsdc = usdcAcct ? Number(usdcAcct.available_balance.value) : 0;
  const usdcBalance = Number.isFinite(parsedUsdc) ? parsedUsdc : 0;

  const preference = cfg.currency_preference as CurrencyPreference;
  const currenciesChecked = currenciesCheckedFor(preference);
  const currency = selectCurrency(preference, usdBalance, usdcBalance, total);
  if (!currency) {
    return {
      ok: false,
      code: "insufficient_funds",
      reason: `usd_balance=${usdBalance};usdc_balance=${usdcBalance};need=${total}`,
    };
  }

  const placed = await placeMarketBuy(creds, total, currency);
  if (!placed.ok) {
    const runId = insertFailedBuyRow(db, placed.error, mult, val, total, null, currenciesChecked);
    raiseOrderFailureAlert(db, placed.status, placed.error, runId, null);
    caps.recordFailure(db);
    return { ok: false, code: "order_failed", reason: placed.error.slice(0, 200) };
  }

  // ONE buy_placed row, entering the normal hold → sweep state machine exactly
  // as a scheduled buy does. scheduled_for is NOW, not a missed slot: this
  // order was placed now, and the missed slots keep their own rows.
  const now = nowSec();
  const info = db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, coinbase_order_id, currencies_checked, currency_used, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'buy_placed', ?, ?, ?, ?, ?)`,
  ).run(
    now, val.z_score, val.zone, mult, cfg.base_unit_usd, total,
    placed.order_id, currenciesChecked, currency, now, now,
  );
  const runId = Number(info.lastInsertRowid);

  // Claim exactly k rows, OLDEST FIRST. The remainder stays unclaimed and keeps
  // rendering in the block — partial-and-drop is the rejected alternative
  // (D5 §8 leg 2), and dropping them here is what would implement it.
  const claim = db.prepare(`UPDATE autobuy_runs SET claimed_by_run_id = ?, updated_at = ? WHERE id = ?`);
  for (const row of missed.slice(0, k)) claim.run(runId, now, row.id);

  clearAlerts(db, "buy");
  console.log(`[autobuy-catchup] placed ${k}x order=${placed.order_id} ${currency.toLowerCase()}=${total} remainder=${missed.length - k}`);

  return {
    ok: true,
    run_id: runId,
    intervals: k,
    usd: total,
    currency,
    order_id: placed.order_id,
    remainder_intervals: missed.length - k,
  };
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
        raiseAlert(db, {
          type: "AUTOBUY_AUTH_FAILURE",
          latestRunId: row.id,
          context: { paused_reason: "credentials_invalid", http_status: res.status, source: "order_poll", error: res.error },
        });
        return;
      }
      console.warn(`[autobuy-scheduler] pollOrder failed order=${row.coinbase_order_id}: ${res.error}`);
      continue; // next tick retries
    }
    // A successful poll proves the credentials are valid and the API reachable.
    clearAlerts(db, "api_ok");
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
        raiseAlert(db, {
          type: "AUTOBUY_ORDER_FAILED",
          latestRunId: row.id,
          context: { latest_run_id: row.id, error_code: "unparseable_fill_amount", error_message: null, order_status: order.status },
        });
        console.warn(`[autobuy-scheduler] unparseable fill amounts order=${row.coinbase_order_id} size=${order.filled_size} value=${order.filled_value}`);
        continue;
      }
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'buy_filled', filled_btc = ?, filled_usd = ?, filled_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(filledBtc, filledUsd, filledAt, now, row.id);
      // Fill confirmed — clear any active insufficient-funds / order-failed alerts (spec §3).
      clearAlerts(db, "buy");
      console.log(`[autobuy-scheduler] filled order=${row.coinbase_order_id} btc=${filledBtc} usd=${filledUsd}`);
    } else if (order.status === "CANCELLED" || order.status === "EXPIRED" || order.status === "FAILED") {
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'failed_buy', error_code = ?, updated_at = ?
         WHERE id = ?`,
      ).run(order.status.toLowerCase(), now, row.id);
      caps.recordFailure(db);
      raiseAlert(db, {
        type: "AUTOBUY_ORDER_FAILED",
        latestRunId: row.id,
        context: { latest_run_id: row.id, error_code: order.status.toLowerCase(), error_message: null, order_status: order.status },
      });
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
      raiseAlert(db, {
        type: "AUTOBUY_AUTH_FAILURE",
        latestRunId: null,
        context: { paused_reason: "credentials_invalid", http_status: accounts.status, source: "list_accounts", error: accounts.error },
      });
    } else {
      raiseAlert(db, {
        type: "AUTOBUY_RATE_LIMITED",
        latestRunId: null,
        context: { http_status: accounts.status, retry_after: null, source: "list_accounts", error: accounts.error },
      });
    }
    return;
  }
  // Sweep-path listAccounts ok — same aggressive api_ok clear as the buy path.
  clearAlerts(db, "api_ok");
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
    // Capture which runs are affected before the UPDATE rewrites their status,
    // so the critical alert can point at the latest affected run (spec §2 Sc.5).
    const affected = db.prepare(
      `SELECT MAX(id) AS id, MAX(filled_at) AS buy_completed_at
       FROM autobuy_runs WHERE status = 'sweep_assigned'`,
    ).get() as { id: number | null; buy_completed_at: number | null };
    const sweepInfo = db.prepare(
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
    raiseAlert(db, {
      type: "AUTOBUY_SWEEP_FAILED",
      latestRunId: affected?.id ?? null,
      context: {
        sweep_id: Number(sweepInfo.lastInsertRowid),
        latest_run_id: affected?.id ?? null,
        btc_amount: totalRow.total,
        buy_completed_at: affected?.buy_completed_at ?? null,
        error_code: errorCode,
        error_message: withdrawResult.error.slice(0, 500),
      },
    });
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
      // Sweep confirmed — clear any active sweep-failed alert (spec §3).
      clearAlerts(db, "sweep");
      console.log(`[autobuy-scheduler] sweep confirmed sweep=${sweep.id} txid=${res.withdraw.network_tx_hash ?? "<pending>"}`);
    } else if (res.withdraw.status === "failed" || res.withdraw.status === "cancelled") {
      const sweepRow = db.prepare(
        `SELECT btc_amount FROM autobuy_sweeps WHERE id = ?`,
      ).get(sweep.id) as { btc_amount: number } | undefined;
      const affected = db.prepare(
        `SELECT MAX(id) AS id, MAX(filled_at) AS buy_completed_at
         FROM autobuy_runs WHERE withdraw_sweep_id = ? AND status = 'withdraw_placed'`,
      ).get(sweep.id) as { id: number | null; buy_completed_at: number | null };
      db.prepare(
        `UPDATE autobuy_sweeps SET status = 'failed', error_code = ? WHERE id = ?`,
      ).run(res.withdraw.status, sweep.id);
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'failed_withdraw', updated_at = ?
         WHERE withdraw_sweep_id = ? AND status = 'withdraw_placed'`,
      ).run(now, sweep.id);
      caps.recordFailure(db);
      raiseAlert(db, {
        type: "AUTOBUY_SWEEP_FAILED",
        latestRunId: affected?.id ?? null,
        context: {
          sweep_id: sweep.id,
          latest_run_id: affected?.id ?? null,
          btc_amount: sweepRow?.btc_amount ?? null,
          buy_completed_at: affected?.buy_completed_at ?? null,
          error_code: res.withdraw.status,
          error_message: null,
        },
      });
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
