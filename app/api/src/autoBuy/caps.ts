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
 * Is the Worker's composite valuation fresh enough? updatedAtISO is the
 * updated_at field from /valuation/current. Stale threshold lives in env.
 */
export function checkValuationFreshness(updatedAtISO: string): CapResult {
  const updatedAt = Date.parse(updatedAtISO);
  if (!Number.isFinite(updatedAt)) {
    return { ok: false, reason: "invalid_updated_at" };
  }
  const ageHours = (Date.now() - updatedAt) / (1000 * 60 * 60);
  const threshold = safeCap(ENV.autoBuyStaleDataMaxHours);
  if (ageHours > threshold) {
    return { ok: false, reason: `stale_data:${ageHours.toFixed(1)}h>${threshold}h` };
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
