import type Database from "better-sqlite3";
import { createLndChainAddress } from "../lightning/lnd";
import * as caps from "./caps";
// The scheduler reaches the exchange only through ./exchange (kraken-autobuy
// spec §2), never through a provider's client; exchangeBoundary.test.ts asserts it.
import * as exchange from "./exchange";
import type { ErrorClass, ExchangeSession } from "./exchangeProvider";
import {
  selectCurrency,
  currenciesCheckedFor,
  type CurrencyPreference,
} from "./currency";
import type { AlertType } from "./alerts";
import { raiseAlert, clearAlerts } from "./alertStore";
import { getCurrent } from "./valuationClient";
import { fundsCoverage, intendedBuyUsd, isLowFunds, readKrakenSnapshot, writeKrakenSnapshot } from "./balanceSnapshot";
import { holdSecondsFor } from "./hold";

const TICK_INTERVAL_MS = 15 * 60 * 1000;
const SWEEP_MIN_BTC = 0.0001;

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
  snapshotWrittenThisTick = false;
  try {
    await stepEnqueueAndPlaceBuy(db);
    await stepPollBuyPlaced(db);
    await stepAssignToSweep(db);
    await stepRunSweep(db);
    await stepPollWithdraws(db);
    await stepBalanceSnapshotAndLowFunds(db);
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

function openExchange(db: Database.Database): ExchangeSession | null {
  const opened = exchange.openSession(db);
  if (opened.kind === "ok") return opened.session;
  if (opened.kind === "corrupted") {
    // credentials_corrupted — flag via paused_reason and return null
    db.prepare(`UPDATE autobuy_config SET enabled = 0, paused_reason = 'credentials_corrupted' WHERE id = 1`).run();
  }
  return null;
}

function pauseWithReason(db: Database.Database, reason: string): void {
  db.prepare(`UPDATE autobuy_config SET enabled = 0, paused_reason = ? WHERE id = 1`).run(reason);
}

// Route a placement/poll failure to the right alert type by the class the
// exchange adapter gave it (spec §2/§6): auth (a 401/403 on Coinbase) routes to
// AUTH_FAILURE, rate_limit (a 429/5xx) to RATE_LIMITED, everything else to
// ORDER_FAILED. Additive only — does not change buy/pause semantics (the caller
// still writes the failed_buy row and records the failure).
function raiseOrderFailureAlert(
  db: Database.Database,
  httpStatus: number,
  cls: ErrorClass,
  errorText: string,
  runId: number,
  orderStatus: string | null,
): void {
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

/**
 * Ruling S5 (kraken-autobuy P4c): on a provider whose policy says so (Kraken),
 * a failure that Coinbase's path leaves SILENT raises the alert its class
 * names. Coinbase's silent paths stay silent: callers check
 * policy.alertOnSilentPaths first. auth pauses (credentials_invalid) as the
 * buy path already does; anything else is the transient RATE_LIMITED warning.
 */
function raiseSilentPathAlert(
  db: Database.Database,
  cls: ErrorClass,
  httpStatus: number,
  detail: string,
  source: string,
  latestRunId: number | null = null,
): void {
  if (cls === "auth") {
    pauseWithReason(db, "credentials_invalid");
    raiseAlert(db, {
      type: "AUTOBUY_AUTH_FAILURE",
      latestRunId,
      context: { paused_reason: "credentials_invalid", http_status: httpStatus, source, error: detail },
    });
    return;
  }
  raiseAlert(db, {
    type: "AUTOBUY_RATE_LIMITED",
    latestRunId,
    context: { http_status: httpStatus, retry_after: null, source, error: detail },
  });
}

/**
 * STOP 2 (kraken-autobuy P4c): a buy below the exchange's minimum is SKIPPED
 * with its own status and a warning, and the next interval is scheduled. The
 * amount is never rounded up to the minimum, and it is not a failure.
 */
function skipBelowMinimum(
  db: Database.Database,
  cfg: { frequency: string; next_run_at: number | null; base_unit_usd: number },
  multiplier: number,
  val: { z_score: number; zone: string },
  intendedUsd: number,
  minimumUsd: number | null,
  source: "pre_check" | "exchange_refused",
  detail: string | null,
): void {
  const reason = minimumUsd !== null ? `minimum_usd=${minimumUsd}` : `exchange_refused:${detail ?? ""}`.slice(0, 200);
  const runId = insertSkippedRow(db, "skipped_below_minimum", reason, multiplier, val, intendedUsd);
  raiseAlert(db, {
    type: "AUTOBUY_BUY_BELOW_MINIMUM",
    latestRunId: runId,
    context: { intended_buy_usd: intendedUsd, minimum_usd: minimumUsd, source, error: detail },
  });
  console.log(`[autobuy-scheduler] skip: buy ${intendedUsd} below the exchange minimum ${minimumUsd ?? "(refused)"}`);
  scheduleNext(db, cfg);
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
    /** Migration 084. Read through exchange.activeProvider, which treats a missing column as Coinbase. */
    provider?: string;
  };
}

/**
 * The provider a new row belongs to: the node's active one (kraken-autobuy P4b).
 * Every insert into autobuy_runs and autobuy_sweeps writes it explicitly; the
 * column's DEFAULT exists only so pre-084 rows read 'coinbase'.
 */
function providerOf(db: Database.Database): "coinbase" | "kraken" {
  return exchange.activeProvider(db);
}

/**
 * The client order id for a buy (ruling D-P4-3): keyed to the INTERVAL SLOT, so
 * a retry after a crash or an unknown outcome re-derives the same id and the
 * Kraken adapter finds the order instead of placing another. A scheduled buy's
 * slot is next_run_at, which advances only after the buy is recorded; a
 * catch-up's is its oldest claimed missed slot, claimed only after the buy.
 * Kraken's free-text form: ASCII, at most 18 characters. Coinbase ignores it.
 */
export function clientOrderIdFor(kind: "scheduled" | "catchup", slot: number): string {
  return `${kind === "scheduled" ? "bcab" : "bccu"}-${Math.floor(slot).toString(36)}`;
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
  return intendedBuyUsd(baseUnit, multiplier); // the one rule, shared with the low-funds coverage (P5)
}

// ── The balance snapshot (kraken-autobuy P5; ruling S3) ────────────────────
//
// Every balance read the scheduler already makes goes through readBalances,
// which persists the snapshot when the provider keeps one (policy
// snapshotBalances: Kraken). The last step of a tick reads balances ONLY if no
// read earlier in the tick wrote the snapshot, so a tick costs at most one
// extra BalanceEx (about 4 an hour at the 15-minute tick). After a buy is
// placed the snapshot is no longer current, so the flag is reset and the last
// step reads again: the warning never counts money the buy just spent.

let snapshotWrittenThisTick = false;

async function readBalances(
  db: Database.Database,
  session: ExchangeSession,
): Promise<Awaited<ReturnType<typeof exchange.getBalances>>> {
  const res = await exchange.getBalances(session);
  if (res.ok && exchange.policy(session).snapshotBalances) {
    writeKrakenSnapshot(db, res.balances, nowSec());
    snapshotWrittenThisTick = true;
  }
  return res;
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
  const session = openExchange(db);
  if (!session) {
    pauseWithReason(db, "no_credentials");
    return;
  }

  const balances = await readBalances(db, session);
  if (!balances.ok) {
    if (balances.errorClass === "auth") {
      pauseWithReason(db, "credentials_invalid");
      raiseAlert(db, {
        type: "AUTOBUY_AUTH_FAILURE",
        latestRunId: null,
        context: { paused_reason: "credentials_invalid", http_status: balances.httpStatus, source: "list_accounts", error: balances.detail },
      });
      return;
    }
    // Non-auth balance-read failure (429 / 5xx / network) — previously silent.
    // Scenario 3: raise a transient rate-limit/unavailable alert (spec §2).
    raiseAlert(db, {
      type: "AUTOBUY_RATE_LIMITED",
      latestRunId: null,
      context: { http_status: balances.httpStatus, retry_after: null, source: "list_accounts", error: balances.detail },
    });
    console.warn(`[autobuy-scheduler] account check failed: ${balances.httpStatus} ${balances.detail}`);
    return;
  }
  // Balance read ok — credentials demonstrably valid and the API reachable.
  // Clear any active auth / rate-limit alerts (spec §3 aggressive api_ok clear).
  clearAlerts(db, "api_ok");

  // STOP 2: below the exchange's minimum → skipped, never rounded up. Coinbase's
  // minimum is 0 and costs no call. A minimum that cannot be read is no reason
  // to skip: the exchange still refuses a too-small order, which lands below.
  const minimum = await exchange.buyMinimumUsd(session, val.price_usd);
  if (minimum.ok && intendedUsd < minimum.minimumUsd) {
    skipBelowMinimum(db, cfg, mult, val, intendedUsd, minimum.minimumUsd, "pre_check", null);
    return;
  }

  // Both USD and USDC balances (an absent or unreadable one reads 0, in the
  // adapter). selectCurrency (§2) then picks which to spend, bounded by the
  // configured preference. E9 (ruling D-P4-8): a provider that cannot buy with
  // USDC buys USD, whatever the preference says.
  const usdBalance = balances.balances.usd;
  const usdcBalance = balances.balances.usdc;

  const preference = (exchange.policy(session).usdcBuys ? cfg.currency_preference : "usd_only") as CurrencyPreference;
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
  // TODO: v1 known limitation — if the buy returns a network-level error
  // (status=0), Coinbase may still have committed the order. On the next tick
  // this path would generate a fresh client_order_id and could double-fill.
  // Future: reconcile by querying Coinbase for recent autobuy-prefixed orders
  // before re-placing. For v1 we accept this low-probability edge; operators
  // have per-buy + rolling caps as the outer containment.
  const placed = await exchange.buy(session, intendedUsd, currency, clientOrderIdFor("scheduled", cfg.next_run_at ?? now));
  if (!placed.ok) {
    if (placed.belowMinimum) {
      skipBelowMinimum(db, cfg, mult, val, intendedUsd, null, "exchange_refused", placed.detail);
      return;
    }
    if (placed.delivery === "unknown") {
      // The order may exist and the adapter's lookup did not find it (Kraken
      // only). HOLD THE SLOT: no failed_buy row and next_run_at NOT advanced,
      // so the next tick re-derives the same client order id and the adapter
      // finds the order, or places it if it never existed. Amendment A: this
      // still counts as a failure, so repeated unknowns pause at the threshold.
      raiseAlert(db, {
        type: "AUTOBUY_ORDER_FAILED",
        latestRunId: null,
        context: { latest_run_id: null, error_code: "outcome_unknown", error_message: placed.detail.slice(0, 500), order_status: null },
      });
      caps.recordFailure(db);
      console.warn(`[autobuy-scheduler] buy outcome unknown; slot held for reconciliation: ${placed.detail}`);
      return;
    }
    const runId = insertFailedBuyRow(db, placed.detail, mult, val, intendedUsd, null, currenciesChecked);
    raiseOrderFailureAlert(db, placed.httpStatus, placed.errorClass, placed.detail, runId, null);
    caps.recordFailure(db);
    scheduleNext(db, cfg);
    return;
  }

  db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, coinbase_order_id, currencies_checked, currency_used, created_at, updated_at, provider)
     VALUES (?, ?, ?, ?, ?, ?, 'buy_placed', ?, ?, ?, ?, ?, ?)`,
  ).run(
    now, val.z_score, val.zone, mult, cfg.base_unit_usd, intendedUsd,
    placed.orderId, currenciesChecked, currency, now, now, session.provider,
  );
  // Buy placed successfully — clear any active insufficient-funds / order-failed
  // alerts (spec §3). Auth / rate-limit already cleared via the api_ok above.
  clearAlerts(db, "buy");
  snapshotWrittenThisTick = false; // the read above predates this buy (P5)
  scheduleNext(db, cfg);
  console.log(`[autobuy-scheduler] placed buy order=${placed.orderId} ${currency.toLowerCase()}=${intendedUsd} zone=${val.zone}`);
}

/** The configured multiplier for a zone. Exported for GET /status's "buys left" (P5), which must use the same one. */
export function parseZoneMultiplier(zoneMultipliersJson: string, zone: string): number {
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
        status, error_code, currencies_checked, created_at, updated_at, provider)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(now, val.z_score, val.zone, multiplier, intendedUsd, status, reason, currenciesChecked, now, now, providerOf(db));
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
        status, coinbase_order_id, error_message, currencies_checked, created_at, updated_at, provider)
     VALUES (?, ?, ?, ?, NULL, ?, 'failed_buy', ?, ?, ?, ?, ?, ?)`,
  ).run(now, val.z_score, val.zone, multiplier, intendedUsd, orderId, errorMessage.slice(0, 500), currenciesChecked, now, now, providerOf(db));
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
        status, error_code, created_at, updated_at, provider)
     VALUES (?, NULL, NULL, NULL, ?, ?, ?, 'clamped_past_interval', ?, ?, ?)`,
  ).run(slot, baseUnitUsd, baseUnitUsd, STATUS_MISSED_INTERVAL, now, now, providerOf(db));
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
  /**
   * What stays claimable after fits_now. null when nothing is withheld.
   *
   * ⚠ `binding_window` LIVES INSIDE THIS OBJECT ON PURPOSE. The member-facing
   * copy names which rolling window held the remainder back ("this 7-day
   * limit"), and that claim is only true when something WAS held back. Nesting
   * it here makes asserting a binding window while nothing bound structurally
   * impossible — `remainder` is non-null exactly when `k < intervals`, which is
   * exactly when a window bound. A sibling field on `missed` would need a null
   * arm plus a convention someone has to remember.
   *
   * "7d" / "30d" rather than "week" / "month": these are ROLLING windows over
   * filled spend, not calendar periods.
   */
  remainder: { intervals: number; estimated_usd: number; binding_window: "7d" | "30d" } | null;
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
  // Read BOTH windows rather than the min alone: when the caps withhold a
  // remainder, the member is told WHICH window did it, and the min discards
  // exactly that. 7-day and 30-day differ by days versus weeks and can bind
  // independently, so it is information the member plans around.
  const h = caps.rollingHeadroom(db);
  const k = fittingIntervals(missed.length, unit, Math.min(h.d7.headroom, h.d30.headroom));

  return {
    ...base,
    multiplier: mult,
    zone: val.zone,
    valuation_updated_at: val.updated_at,
    estimated_usd: roundUsd(missed.length * unit),
    fits_now: { intervals: k, estimated_usd: roundUsd(k * unit) },
    remainder:
      k < missed.length
        ? {
            intervals: missed.length - k,
            estimated_usd: roundUsd((missed.length - k) * unit),
            binding_window: bindingWindow(h),
          }
        : null,
  };
}

/**
 * Which rolling window is holding the claim back — the tighter one.
 *
 * Tie goes to 7d, matching the k = 0 refusal's own choice, so the block and the
 * refusal never name different windows for the same state.
 */
function bindingWindow(h: { d7: caps.WindowHeadroom; d30: caps.WindowHeadroom }): "7d" | "30d" {
  return h.d7.headroom <= h.d30.headroom ? "7d" : "30d";
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
  | "order_failed"
  /** kraken-autobuy P4c, STOP 2: the total is below the exchange's minimum. Nothing was placed. */
  | "below_minimum"
  /** kraken-autobuy P4c: the order may exist; nothing is claimed, so a retry re-derives the same order id. */
  | "order_outcome_unknown";

/**
 * ⚠ THE STRUCTURED REFUSAL FIELDS BELOW ARE THE MEMBER-FACING NUMBERS.
 *
 * Every one of them used to exist only inside `reason` — a single string the
 * UI would have had to parse to render a real figure, which breaks silently
 * the day anyone edits the text. `reason` survives for logs and for the
 * generic frame; anything a member READS comes from a field.
 *
 * Which refusal carries which is not uniform, because the refusals are not:
 * `cap` only exists where a rolling window bound, `funds` only where balances
 * were weighed, `staleness` only where an age passed a threshold. An absent
 * field is therefore meaningful — it is how the UI tells "more than N hours
 * old" from an unparseable timestamp without a second rule to remember.
 */
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
      /**
       * On rolling_cap_no_headroom: the window that bound, its cap, what is
       * left under it, and the cost of one interval. `cap_usd` is finite here
       * by construction — an unconfigured cap is +Infinity, which yields
       * infinite headroom, which admits at least one interval, which means
       * this refusal never fires.
       */
      cap?: { window: "7d" | "30d"; cap_usd: number; headroom_usd: number; unit_usd: number };
      /**
       * On insufficient_funds: what was needed, which currencies the member's
       * `currency_preference` actually WEIGHED, and their balances.
       *
       * ⚠ A balance is `null` when that currency was NOT considered — not 0.
       * Under `usd_only` naming a USDC balance would be misleading ("your USDC
       * covers it" when the preference excludes it), so the UI must be able to
       * tell "not considered" from "empty", and 0 cannot.
       *
       * ⚠ AND THE TRAP FOR WHOEVER WRITES THE COPY: `selectCurrency` tests
       * INDEPENDENT coverage only — there is no split-fill. Under the
       * `*_preferred` values a refusal means NEITHER balance alone covered the
       * total, so "you are $X short" or any combined figure would be FALSE
       * (usd 600 + usdc 600 against a 1000 total refuses, and the sum is not
       * short). The honest form names each considered balance against the
       * total separately.
       */
      funds?: {
        needed_usd: number;
        considered: Array<"USD" | "USDC">;
        usd_balance: number | null;
        usdc_balance: number | null;
      };
      /**
       * On valuation_stale: this node's threshold and the age that passed it.
       * ABSENT on the `invalid_updated_at` sub-reason, which shares the code
       * and has no age — that absence is the UI's discriminator.
       */
      staleness?: { threshold_hours: number; age_hours: number };
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
  if (!freshness.ok) {
    return {
      ok: false,
      code: "valuation_stale",
      reason: freshness.reason,
      // Undefined on `invalid_updated_at` — see the field's contract above.
      ...(freshness.staleness ? { staleness: freshness.staleness } : {}),
    };
  }

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
    const binding = bindingWindow(h);
    const window = binding === "7d" ? h.d7 : h.d30;
    return {
      ok: false,
      code: "rolling_cap_no_headroom",
      reason: `${binding}_cap_headroom:${headroom.toFixed(2)}<${unit.toFixed(2)}`,
      cap: {
        window: binding,
        cap_usd: window.cap,
        headroom_usd: roundUsd(window.headroom),
        unit_usd: unit,
      },
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

  const session = openExchange(db);
  if (!session) return { ok: false, code: "no_credentials", reason: "no_credentials" };

  const balances = await readBalances(db, session);
  if (!balances.ok) {
    // S5: Coinbase returns this refusal silently; Kraken also raises its alert.
    if (exchange.policy(session).alertOnSilentPaths) {
      raiseSilentPathAlert(db, balances.errorClass, balances.httpStatus, balances.detail, "catch_up_balance");
    }
    return { ok: false, code: "account_check_failed", reason: `http_${balances.httpStatus}` };
  }

  const minimum = await exchange.buyMinimumUsd(session, val.price_usd);
  if (minimum.ok && total < minimum.minimumUsd) {
    return { ok: false, code: "below_minimum", reason: `total=${total};minimum_usd=${minimum.minimumUsd}` };
  }

  const usdBalance = balances.balances.usd;
  const usdcBalance = balances.balances.usdc;

  const preference = (exchange.policy(session).usdcBuys ? cfg.currency_preference : "usd_only") as CurrencyPreference;
  const currenciesChecked = currenciesCheckedFor(preference);
  const currency = selectCurrency(preference, usdBalance, usdcBalance, total);
  if (!currency) {
    // Only the currencies the preference actually weighed appear as numbers;
    // the other is null, not 0. See the `funds` contract on CatchUpResult.
    const considered = currenciesChecked.split(",") as Array<"USD" | "USDC">;
    return {
      ok: false,
      code: "insufficient_funds",
      reason: `usd_balance=${usdBalance};usdc_balance=${usdcBalance};need=${total}`,
      funds: {
        needed_usd: total,
        considered,
        usd_balance: considered.includes("USD") ? usdBalance : null,
        usdc_balance: considered.includes("USDC") ? usdcBalance : null,
      },
    };
  }

  // missed is oldest first, and the oldest k are claimed only after this buy.
  const placed = await exchange.buy(session, total, currency, clientOrderIdFor("catchup", missed[0].scheduled_for));
  if (!placed.ok && placed.belowMinimum) {
    return { ok: false, code: "below_minimum", reason: placed.detail.slice(0, 200) };
  }
  if (!placed.ok && placed.delivery === "unknown") {
    // As the scheduled buy: no failed_buy row and nothing claimed, so a retry
    // re-derives the same order id; it still counts as a failure (amendment A).
    raiseAlert(db, {
      type: "AUTOBUY_ORDER_FAILED",
      latestRunId: null,
      context: { latest_run_id: null, error_code: "outcome_unknown", error_message: placed.detail.slice(0, 500), order_status: null },
    });
    caps.recordFailure(db);
    return { ok: false, code: "order_outcome_unknown", reason: placed.detail.slice(0, 200) };
  }
  if (!placed.ok) {
    const runId = insertFailedBuyRow(db, placed.detail, mult, val, total, null, currenciesChecked);
    raiseOrderFailureAlert(db, placed.httpStatus, placed.errorClass, placed.detail, runId, null);
    caps.recordFailure(db);
    return { ok: false, code: "order_failed", reason: placed.detail.slice(0, 200) };
  }

  // ONE buy_placed row, entering the normal hold → sweep state machine exactly
  // as a scheduled buy does. scheduled_for is NOW, not a missed slot: this
  // order was placed now, and the missed slots keep their own rows.
  const now = nowSec();
  const info = db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, coinbase_order_id, currencies_checked, currency_used, created_at, updated_at, provider)
     VALUES (?, ?, ?, ?, ?, ?, 'buy_placed', ?, ?, ?, ?, ?, ?)`,
  ).run(
    now, val.z_score, val.zone, mult, cfg.base_unit_usd, total,
    placed.orderId, currenciesChecked, currency, now, now, session.provider,
  );
  const runId = Number(info.lastInsertRowid);

  // Claim exactly k rows, OLDEST FIRST. The remainder stays unclaimed and keeps
  // rendering in the block — partial-and-drop is the rejected alternative
  // (D5 §8 leg 2), and dropping them here is what would implement it.
  const claim = db.prepare(`UPDATE autobuy_runs SET claimed_by_run_id = ?, updated_at = ? WHERE id = ?`);
  for (const row of missed.slice(0, k)) claim.run(runId, now, row.id);

  clearAlerts(db, "buy");
  console.log(`[autobuy-catchup] placed ${k}x order=${placed.orderId} ${currency.toLowerCase()}=${total} remainder=${missed.length - k}`);

  return {
    ok: true,
    run_id: runId,
    intervals: k,
    usd: total,
    currency,
    order_id: placed.orderId,
    remainder_intervals: missed.length - k,
  };
}

// ───────────────────────────────────────────────────────────────────────
// Step 2: Poll buy_placed → buy_filled or failed_buy
// ───────────────────────────────────────────────────────────────────────

async function stepPollBuyPlaced(db: Database.Database): Promise<void> {
  // Only the active provider's rows: a row is polled through the adapter that
  // placed it. The drain guard (POST /api/autobuy/provider) keeps the other
  // provider's set empty.
  const rows = db.prepare(
    `SELECT id, coinbase_order_id FROM autobuy_runs WHERE status = 'buy_placed' AND provider = ? LIMIT 10`,
  ).all(providerOf(db)) as Array<{ id: number; coinbase_order_id: string }>;
  if (rows.length === 0) return;

  const session = openExchange(db);
  if (!session) { pauseWithReason(db, "no_credentials"); return; }

  for (const row of rows) {
    const res = await exchange.getOrder(session, row.coinbase_order_id);
    if (!res.ok) {
      if (res.errorClass === "auth") {
        pauseWithReason(db, "credentials_invalid");
        raiseAlert(db, {
          type: "AUTOBUY_AUTH_FAILURE",
          latestRunId: row.id,
          context: { paused_reason: "credentials_invalid", http_status: res.httpStatus, source: "order_poll", error: res.detail },
        });
        return;
      }
      console.warn(`[autobuy-scheduler] pollOrder failed order=${row.coinbase_order_id}: ${res.detail}`);
      // S5: silent on Coinbase; Kraken raises it (the next tick still retries).
      if (exchange.policy(session).alertOnSilentPaths) {
        raiseSilentPathAlert(db, res.errorClass, res.httpStatus, res.detail, "order_poll", row.id);
      }
      continue; // next tick retries
    }
    // A successful poll proves the credentials are valid and the API reachable.
    clearAlerts(db, "api_ok");
    const order = res.order;
    const now = nowSec();
    if (order.state === "filled") {
      const filledAt = order.filledAt ?? now;
      const filledBtc = order.filledBtc;
      const filledUsd = order.filledUsd;
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
          context: { latest_run_id: row.id, error_code: "unparseable_fill_amount", error_message: null, order_status: order.rawStatus },
        });
        console.warn(`[autobuy-scheduler] unparseable fill amounts order=${row.coinbase_order_id} btc=${filledBtc} usd=${filledUsd}`);
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
    } else if (order.state === "cancelled" || order.state === "expired" || order.state === "failed") {
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'failed_buy', error_code = ?, updated_at = ?
         WHERE id = ?`,
      ).run(order.state, now, row.id);
      caps.recordFailure(db);
      raiseAlert(db, {
        type: "AUTOBUY_ORDER_FAILED",
        latestRunId: row.id,
        context: { latest_run_id: row.id, error_code: order.state, error_message: null, order_status: order.rawStatus },
      });
    }
    // pending (OPEN / PENDING on Coinbase) → leave as-is, poll again next tick
  }
}

// ───────────────────────────────────────────────────────────────────────
// Step 3: Past-hold buy_filled → awaiting_withdraw_hold → sweep_assigned
// ───────────────────────────────────────────────────────────────────────

async function stepAssignToSweep(db: Database.Database): Promise<void> {
  const now = nowSec();
  // Each row's hold is its own provider's (hold.ts; ruling S2, E1): Coinbase
  // 72 h, Kraken 7 days. Pure DB work, no exchange call.
  for (const provider of ["coinbase", "kraken"] as const) {
    const cutoff = now - holdSecondsFor(provider);

    // Rows whose hold has elapsed → sweep_assigned. Covers both buy_filled
    // and awaiting_withdraw_hold states, so a row can skip the intermediate
    // rename if it was filled long enough ago.
    db.prepare(
      `UPDATE autobuy_runs
       SET status = 'sweep_assigned', updated_at = ?
       WHERE status IN ('buy_filled', 'awaiting_withdraw_hold')
         AND provider = ?
         AND filled_at IS NOT NULL
         AND filled_at <= ?`,
    ).run(now, provider, cutoff);

    // Remaining buy_filled rows are genuinely still in their hold → rename for
    // operator visibility. Skip rows without filled_at (shouldn't happen, but
    // don't strand them in awaiting_withdraw_hold if it does).
    db.prepare(
      `UPDATE autobuy_runs
       SET status = 'awaiting_withdraw_hold', updated_at = ?
       WHERE status = 'buy_filled' AND provider = ? AND filled_at IS NOT NULL AND filled_at > ?`,
    ).run(now, provider, cutoff);
  }
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

  // Total BTC across the active provider's sweep_assigned rows. One sweep never
  // mixes exchanges (ruling S1; the drain guard keeps the other set empty).
  const provider = providerOf(db);
  const totalRow = db.prepare(
    `SELECT COALESCE(SUM(filled_btc), 0) AS total
     FROM autobuy_runs WHERE status = 'sweep_assigned' AND provider = ?`,
  ).get(provider) as { total: number };
  if (totalRow.total < SWEEP_MIN_BTC) return; // defer, retry next week

  const session = openExchange(db);
  if (!session) { pauseWithReason(db, "no_credentials"); return; }

  const balances = await readBalances(db, session);
  if (!balances.ok) {
    if (balances.errorClass === "auth") {
      pauseWithReason(db, "credentials_invalid");
      raiseAlert(db, {
        type: "AUTOBUY_AUTH_FAILURE",
        latestRunId: null,
        context: { paused_reason: "credentials_invalid", http_status: balances.httpStatus, source: "list_accounts", error: balances.detail },
      });
    } else {
      raiseAlert(db, {
        type: "AUTOBUY_RATE_LIMITED",
        latestRunId: null,
        context: { http_status: balances.httpStatus, retry_after: null, source: "list_accounts", error: balances.detail },
      });
    }
    return;
  }
  // Sweep-path balance read ok — same aggressive api_ok clear as the buy path.
  clearAlerts(db, "api_ok");
  if (balances.balances.btc === null) {
    console.warn("[autobuy-scheduler] no BTC account found");
    return;
  }

  // STOP 1 (kraken-autobuy P4c): the exchange's own withdrawal minimum, read now.
  // Below it the sweep DEFERS, exactly as below SWEEP_MIN_BTC above; it never
  // fails. Coinbase's is SWEEP_MIN_BTC itself (no call).
  const minimum = await exchange.withdrawalMinimumBtc(session);
  if (!minimum.ok) {
    if (exchange.policy(session).alertOnSilentPaths) {
      raiseSilentPathAlert(db, minimum.errorClass, minimum.httpStatus, minimum.detail, "withdrawal_minimum");
    }
    return;
  }
  if (totalRow.total < minimum.minimumBtc) return; // defer

  const withdrawResult = await exchange.withdraw(session, cfg.withdraw_address, totalRow.total);
  const now = nowSec();

  if (!withdrawResult.ok && withdrawResult.delivery === "not_sent") {
    // Nothing reached the exchange's withdrawal call (Kraken: the fee quote
    // failed). Nothing to record as failed: the rows stay sweep_assigned and
    // no sweep row is written, so a later tick today retries.
    raiseSilentPathAlert(db, withdrawResult.errorClass, withdrawResult.httpStatus, withdrawResult.detail, "fee_quote");
    return;
  }

  if (!withdrawResult.ok) {
    // Record a failed sweep row for audit + mark all assigned runs as failed_withdraw.
    // The exchange adapter decides what an address refusal is (a 400 on Coinbase).
    // An UNKNOWN outcome (Kraken, after its List check) ends the same way and is
    // never re-sent: the runs leave sweep_assigned for good (spec §4).
    const addressRejected = withdrawResult.errorClass === "withdraw_address_rejected";
    const errorCode = addressRejected
      ? "address_not_whitelisted"
      : withdrawResult.delivery === "unknown" ? "withdraw_outcome_unknown" : `http_${withdrawResult.httpStatus}`;
    // Capture which runs are affected before the UPDATE rewrites their status,
    // so the critical alert can point at the latest affected run (spec §2 Sc.5).
    const affected = db.prepare(
      `SELECT MAX(id) AS id, MAX(filled_at) AS buy_completed_at
       FROM autobuy_runs WHERE status = 'sweep_assigned' AND provider = ?`,
    ).get(provider) as { id: number | null; buy_completed_at: number | null };
    const sweepInfo = db.prepare(
      `INSERT INTO autobuy_sweeps (swept_at, btc_amount, status, error_code, error_message, provider)
       VALUES (?, ?, 'failed', ?, ?, ?)`,
    ).run(now, totalRow.total, errorCode, withdrawResult.detail.slice(0, 500), provider);
    db.prepare(
      `UPDATE autobuy_runs
       SET status = 'failed_withdraw', error_message = ?, updated_at = ?
       WHERE status = 'sweep_assigned' AND provider = ?`,
    ).run(withdrawResult.detail.slice(0, 500), now, provider);
    if (addressRejected) {
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
        error_message: withdrawResult.detail.slice(0, 500),
      },
    });
    return;
  }

  // Create the sweep row + link all sweep_assigned runs to it + transition them
  // coinbase_tx_id holds the provider's withdrawal id (Kraken's too; D-P4-6).
  // A withdrawal the exchange parked for approval gets its own sweep state
  // (G1: a warning alert); the withdraw poll resolves it either way.
  const sweepStatus = withdrawResult.parked ? "awaiting_approval" : "placed";
  const sweepInsert = db.prepare(
    `INSERT INTO autobuy_sweeps (swept_at, btc_amount, coinbase_tx_id, status, provider)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
  ).get(now, totalRow.total, withdrawResult.withdrawalId, sweepStatus, provider) as { id: number };
  if (withdrawResult.parked) {
    raiseAlert(db, {
      type: "AUTOBUY_WITHDRAWAL_AWAITING_APPROVAL",
      latestRunId: null,
      context: { sweep_id: sweepInsert.id, btc_amount: totalRow.total, withdrawal_id: withdrawResult.withdrawalId },
    });
  }

  db.prepare(
    `UPDATE autobuy_runs
     SET status = 'withdraw_placed', withdraw_sweep_id = ?, updated_at = ?
     WHERE status = 'sweep_assigned' AND provider = ?`,
  ).run(sweepInsert.id, now, provider);
  console.log(`[autobuy-scheduler] sweep placed tx=${withdrawResult.withdrawalId} btc=${totalRow.total}`);
}

// ───────────────────────────────────────────────────────────────────────
// Step 5: Poll withdraw_placed sweeps → confirmed / failed
// ───────────────────────────────────────────────────────────────────────

async function stepPollWithdraws(db: Database.Database): Promise<void> {
  const sweeps = db.prepare(
    `SELECT id, coinbase_tx_id, status FROM autobuy_sweeps
      WHERE status IN ('placed', 'awaiting_approval') AND provider = ? LIMIT 5`,
  ).all(providerOf(db)) as Array<{ id: number; coinbase_tx_id: string; status: string }>;
  if (sweeps.length === 0) return;

  // Each early return below is SILENT on Coinbase (pinned, ruling S5); on Kraken
  // it raises the alert its cause names.
  const session = openExchange(db);
  if (!session) {
    if (exchange.activePolicy(db).alertOnSilentPaths) {
      const reason = readConfig(db).paused_reason === "credentials_corrupted" ? "credentials_corrupted" : "no_credentials";
      pauseWithReason(db, reason);
      raiseAlert(db, {
        type: "AUTOBUY_AUTH_FAILURE",
        latestRunId: null,
        context: { paused_reason: reason, http_status: null, source: "withdraw_poll", error: reason },
      });
    }
    return;
  }
  const alertSilent = exchange.policy(session).alertOnSilentPaths;

  const balances = await readBalances(db, session);
  if (!balances.ok) {
    if (alertSilent) raiseSilentPathAlert(db, balances.errorClass, balances.httpStatus, balances.detail, "withdraw_poll");
    return;
  }
  if (balances.balances.btc === null) return;

  for (const sweep of sweeps) {
    const res = await exchange.getWithdrawal(session, sweep.coinbase_tx_id);
    if (!res.ok) {
      if (alertSilent) raiseSilentPathAlert(db, res.errorClass, res.httpStatus, res.detail, "withdraw_poll");
      continue; // retry next tick
    }

    const now = nowSec();
    const w = res.withdrawal;
    if (w.state === "completed") {
      db.prepare(
        `UPDATE autobuy_sweeps SET status = 'confirmed', withdraw_txid = ? WHERE id = ?`,
      ).run(w.txHash, sweep.id);
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'withdraw_confirmed', withdraw_txid = ?, updated_at = ?
         WHERE withdraw_sweep_id = ? AND status = 'withdraw_placed'`,
      ).run(w.txHash, now, sweep.id);
      caps.resetFailureCounter(db);
      // Sweep confirmed — clear any active sweep-failed alert (spec §3), and an
      // awaiting-approval alert if this withdrawal was parked.
      clearAlerts(db, "sweep");
      console.log(`[autobuy-scheduler] sweep confirmed sweep=${sweep.id} txid=${w.txHash ?? "<pending>"}`);
    } else if (w.state === "failed" || w.state === "cancelled") {
      const sweepRow = db.prepare(
        `SELECT btc_amount FROM autobuy_sweeps WHERE id = ?`,
      ).get(sweep.id) as { btc_amount: number } | undefined;
      const affected = db.prepare(
        `SELECT MAX(id) AS id, MAX(filled_at) AS buy_completed_at
         FROM autobuy_runs WHERE withdraw_sweep_id = ? AND status = 'withdraw_placed'`,
      ).get(sweep.id) as { id: number | null; buy_completed_at: number | null };
      db.prepare(
        `UPDATE autobuy_sweeps SET status = 'failed', error_code = ? WHERE id = ?`,
      ).run(w.state, sweep.id);
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'failed_withdraw', updated_at = ?
         WHERE withdraw_sweep_id = ? AND status = 'withdraw_placed'`,
      ).run(now, sweep.id);
      caps.recordFailure(db);
      // A parked withdrawal that was refused: the approval is decided.
      if (sweep.status === "awaiting_approval") clearAlerts(db, "approval_decided");
      raiseAlert(db, {
        type: "AUTOBUY_SWEEP_FAILED",
        latestRunId: affected?.id ?? null,
        context: {
          sweep_id: sweep.id,
          latest_run_id: affected?.id ?? null,
          btc_amount: sweepRow?.btc_amount ?? null,
          buy_completed_at: affected?.buy_completed_at ?? null,
          error_code: w.state,
          error_message: null,
        },
      });
    }
    // "pending" → leave as-is
  }
}

// ───────────────────────────────────────────────────────────────────────
// Step 6: the balance snapshot and the low-funds warning (kraken-autobuy P5)
// ───────────────────────────────────────────────────────────────────────

/**
 * While Auto-Buy is ENABLED on a provider that keeps a snapshot (Kraken), make
 * sure this tick has a fresh one (reusing any read the tick already made), then
 * evaluate the low-funds warning (E3/G3): it fires before a buy is due, when
 * the snapshot's USD covers fewer than 2 next buys at the CURRENT multiplier.
 * Raised once per episode (D-P5-4); cleared by funds_ok when 2+ are covered
 * (D-P5-3). A stale or missing snapshot, or a zone that buys nothing, neither
 * raises nor clears (D-P5-5). Coinbase: nothing here runs (S3, Coinbase unchanged).
 */
async function stepBalanceSnapshotAndLowFunds(db: Database.Database): Promise<void> {
  const cfg = readConfig(db);
  if (!cfg.enabled) return;
  if (!exchange.activePolicy(db).snapshotBalances) return;

  if (!snapshotWrittenThisTick) {
    const session = openExchange(db);
    if (!session) return;
    const res = await readBalances(db, session);
    if (!res.ok) {
      raiseSilentPathAlert(db, res.errorClass, res.httpStatus, res.detail, "balance_snapshot");
      return;
    }
  }

  const val = await getCurrent();
  if (!val.ok) return; // no valuation, no current multiplier: no verdict
  const multiplier = parseZoneMultiplier(cfg.zone_multipliers, val.value.zone);
  const coverage = fundsCoverage(readKrakenSnapshot(db), cfg.base_unit_usd, multiplier, nowSec());
  if (!coverage || coverage.stale || coverage.buys_covered === null) return;

  if (isLowFunds(coverage)) {
    const active = db.prepare(
      `SELECT 1 FROM autobuy_alerts WHERE type = 'AUTOBUY_LOW_FUNDS' AND status = 'active' LIMIT 1`,
    ).get();
    if (active) return; // once per episode (D-P5-4)
    raiseAlert(db, {
      type: "AUTOBUY_LOW_FUNDS",
      latestRunId: null,
      context: {
        currency: coverage.currency,
        usd_available: coverage.usd_available,
        next_buy_usd: coverage.next_buy_usd,
        buys_covered: coverage.buys_covered,
        multiplier: coverage.multiplier,
        read_at: coverage.read_at,
      },
    });
    return;
  }
  clearAlerts(db, "funds_ok");
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
