import type Database from "better-sqlite3";
import { ENV } from "../config/env";

export type CapResult = { ok: true } | { ok: false; reason: string };

/**
 * Defensive: treats a cap value of 0 or negative as "not configured" rather
 * than "everything is over-cap". Prevents the `Number("")` → 0 degeneracy
 * in env.ts from silently bricking auto-buy if an operator sets an env var
 * to empty string or forgets to set it. If the cap is legitimately missing
 * (e.g. env not set on this deployment), this helper treats it as unlimited
 * and the scheduler proceeds — the other caps and the explicit
 * autoBuyEnabled gate still apply.
 */
function safeCap(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

/**
 * Can the scheduler create ANY new scheduled row? Checks:
 *  - env-level kill switch (AUTOBUY_ENABLED)
 *  - per-node enabled flag in autobuy_config
 *  - no pending paused_reason
 *  - consecutive-failure threshold
 */
export function canSchedule(db: Database.Database): CapResult {
  if (!ENV.autoBuyEnabled) return { ok: false, reason: "env_kill_switch" };
  const cfg = db.prepare(`SELECT enabled, paused_reason, consecutive_failures FROM autobuy_config WHERE id = 1`)
    .get() as { enabled: number; paused_reason: string | null; consecutive_failures: number } | undefined;
  if (!cfg) return { ok: false, reason: "config_missing" };
  if (cfg.enabled !== 1) return { ok: false, reason: "disabled" };
  if (cfg.paused_reason) return { ok: false, reason: `paused:${cfg.paused_reason}` };
  const failureThreshold = safeCap(ENV.autoBuyFailurePauseThreshold);
  if (cfg.consecutive_failures >= failureThreshold) {
    return { ok: false, reason: "failure_threshold_exceeded" };
  }
  return { ok: true };
}

/**
 * Is the intended per-run USD amount under the hard cap?
 */
export function checkSingleBuyCap(intendedUsd: number): CapResult {
  const cap = safeCap(ENV.autoBuyMaxSingleBuyUsd);
  if (intendedUsd > cap) {
    return { ok: false, reason: `single_buy_cap:${intendedUsd}>${cap}` };
  }
  return { ok: true };
}

/**
 * Is the rolling 7-day + 30-day filled spend under the cap if we add this
 * intended amount? Sums filled_usd from rows in states that represent actual
 * spend (buy_filled and later; skipped_* and failed_* don't count per spec §5.2).
 */
export function checkRollingCaps(db: Database.Database, intendedUsd: number): CapResult {
  const nowSec = Math.floor(Date.now() / 1000);
  const countedStates = ["buy_filled", "awaiting_withdraw_hold", "sweep_assigned", "withdraw_placed", "withdraw_confirmed"];
  const placeholders = countedStates.map(() => "?").join(",");

  const cap7 = safeCap(ENV.autoBuyMax7dUsd);
  const row7 = db.prepare(
    `SELECT COALESCE(SUM(filled_usd), 0) AS total
     FROM autobuy_runs
     WHERE status IN (${placeholders}) AND filled_at >= ?`,
  ).get(...countedStates, nowSec - 7 * 86400) as { total: number };
  if (row7.total + intendedUsd > cap7) {
    return { ok: false, reason: `7d_cap:${(row7.total + intendedUsd).toFixed(2)}>${cap7}` };
  }

  const cap30 = safeCap(ENV.autoBuyMax30dUsd);
  const row30 = db.prepare(
    `SELECT COALESCE(SUM(filled_usd), 0) AS total
     FROM autobuy_runs
     WHERE status IN (${placeholders}) AND filled_at >= ?`,
  ).get(...countedStates, nowSec - 30 * 86400) as { total: number };
  if (row30.total + intendedUsd > cap30) {
    return { ok: false, reason: `30d_cap:${(row30.total + intendedUsd).toFixed(2)}>${cap30}` };
  }

  return { ok: true };
}

/** Cap, spend-so-far and remaining room for one rolling window. */
export type WindowHeadroom = { cap: number; spent: number; headroom: number };

/**
 * How much room is LEFT under each rolling cap, right now.
 *
 * checkRollingCaps answers yes/no for one amount. The member-elected catch-up
 * needs the quantity itself: when the caps bind, it offers the largest whole
 * number of missed intervals that FITS and retains the rest as claimable
 * (decisions/2026-09-14-partial-catchup-with-remainder-retained.md, D5). That
 * question cannot be asked of a boolean.
 *
 * Sums the same counted states over the same windows as checkRollingCaps, so
 * the two cannot disagree about what has been spent.
 *
 * ⚠ `cap` and `headroom` are +Infinity when the env var is unset or <= 0 —
 * safeCap's deliberate "not configured means unlimited". Callers that serialise
 * this must map Infinity to null; JSON.stringify turns it into `null` anyway,
 * but silently, which is the sort of thing worth doing on purpose.
 */
export function rollingHeadroom(db: Database.Database): { d7: WindowHeadroom; d30: WindowHeadroom } {
  const nowSec = Math.floor(Date.now() / 1000);
  const countedStates = ["buy_filled", "awaiting_withdraw_hold", "sweep_assigned", "withdraw_placed", "withdraw_confirmed"];
  const placeholders = countedStates.map(() => "?").join(",");

  const spentIn = (windowDays: number): number => {
    const row = db.prepare(
      `SELECT COALESCE(SUM(filled_usd), 0) AS total
       FROM autobuy_runs
       WHERE status IN (${placeholders}) AND filled_at >= ?`,
    ).get(...countedStates, nowSec - windowDays * 86400) as { total: number };
    return row.total;
  };

  const cap7 = safeCap(ENV.autoBuyMax7dUsd);
  const spent7 = spentIn(7);
  const cap30 = safeCap(ENV.autoBuyMax30dUsd);
  const spent30 = spentIn(30);

  return {
    d7: { cap: cap7, spent: spent7, headroom: Math.max(0, cap7 - spent7) },
    d30: { cap: cap30, spent: spent30, headroom: Math.max(0, cap30 - spent30) },
  };
}

/**
 * Is the requested base_unit_usd (from a user PATCH request) under the hard cap?
 */
export function checkBaseUnitCap(proposedUsd: number): CapResult {
  const cap = safeCap(ENV.autoBuyBaseUnitMaxUsd);
  if (proposedUsd > cap) {
    return { ok: false, reason: `base_unit_cap:${proposedUsd}>${cap}` };
  }
  return { ok: true };
}

/**
 * The age that made a valuation stale, and the threshold it passed.
 *
 * ⚠ WHY THIS IS A WIDER RETURN THAN `CapResult`, AND ONLY HERE. These two
 * numbers are MEMBER-FACING: the catch-up refusal tells the farmer how old the
 * valuation is against *this node's* limit, and `AUTOBUY_STALE_DATA_MAX_HOURS`
 * is env-tunable — so a UI that hardcodes 48 is false on a tuned node, and a UI
 * that scrapes them back out of `reason` breaks silently the day anyone edits
 * that text. Widening the shared `CapResult` would push an optional field onto
 * four other cap functions that have no use for it; widening this one does not.
 *
 * `staleness` is present ONLY on the stale arm. `invalid_updated_at` — an
 * unparseable timestamp — is a different fault with no age to report, and its
 * ABSENCE here is the discriminator the UI uses to route it to the generic
 * frame instead of the "more than N hours old" string. Structural, so nobody
 * has to remember a rule.
 */
export type FreshnessResult =
  | { ok: true }
  | { ok: false; reason: string; staleness?: { threshold_hours: number; age_hours: number } };

/**
 * Is the Worker's composite valuation fresh enough? updatedAtISO is the
 * updated_at field from /valuation/current. Stale threshold lives in env.
 */
export function checkValuationFreshness(updatedAtISO: string): FreshnessResult {
  const updatedAt = Date.parse(updatedAtISO);
  if (!Number.isFinite(updatedAt)) {
    return { ok: false, reason: "invalid_updated_at" };
  }
  const ageHours = (Date.now() - updatedAt) / (1000 * 60 * 60);
  const threshold = safeCap(ENV.autoBuyStaleDataMaxHours);
  if (ageHours > threshold) {
    // threshold is necessarily FINITE here: safeCap maps an unset or <= 0 env
    // var to +Infinity, and `ageHours > Infinity` is never true — so this arm
    // is unreachable with an unconfigured threshold and the field never has to
    // carry Infinity (which JSON.stringify would silently render as null).
    return {
      ok: false,
      reason: `stale_data:${ageHours.toFixed(1)}h>${threshold}h`,
      staleness: { threshold_hours: threshold, age_hours: Math.round(ageHours * 10) / 10 },
    };
  }
  return { ok: true };
}

/**
 * On a failed_* transition, increment the counter and auto-pause if threshold
 * hit. Returns the new count.
 */
export function recordFailure(db: Database.Database): { consecutive_failures: number; paused: boolean } {
  const threshold = safeCap(ENV.autoBuyFailurePauseThreshold);
  const row = db.prepare(
    `UPDATE autobuy_config
     SET consecutive_failures = consecutive_failures + 1,
         paused_reason = CASE
           WHEN consecutive_failures + 1 >= ? THEN 'consecutive_failures'
           ELSE paused_reason
         END,
         enabled = CASE
           WHEN consecutive_failures + 1 >= ? THEN 0
           ELSE enabled
         END
     WHERE id = 1
     RETURNING consecutive_failures, paused_reason`,
  ).get(threshold, threshold) as
    | { consecutive_failures: number; paused_reason: string | null }
    | undefined;
  if (!row) return { consecutive_failures: 0, paused: false };
  return {
    consecutive_failures: row.consecutive_failures,
    paused: row.paused_reason === "consecutive_failures",
  };
}

/**
 * On a successful sweep/withdraw, reset the failure counter.
 */
export function resetFailureCounter(db: Database.Database): void {
  db.prepare(`UPDATE autobuy_config SET consecutive_failures = 0 WHERE id = 1`).run();
}
