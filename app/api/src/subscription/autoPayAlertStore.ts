// Thin persistence layer for subscription_autopay_alerts (migration 052).
//
// Implements specs/2026-06-12-subscription-auto-pay-implementation.md §5.
// The pure decision logic lives in autoPayAlerts.ts; this module executes the
// intents (insert / increment+merge / resolve / dismiss) against the member-
// scoped table and serves the API read shapes. Mirrors autoBuy/alertStore.ts
// but: keyed on member_pubkey, no latest_run_id (auto-pay has no runs table),
// severity domain is ('info','warning'), and success both resolves active
// warnings AND raises an info SUCCEEDED notification.
//
// All timestamps are integer epoch seconds (do NOT introduce ms here, §2).

import type Database from "better-sqlite3";
import {
  decideAutoPayAlert,
  resolveOnSuccess,
  type AutoPayActiveAlertRow,
  type AutoPaySignal,
} from "./autoPayAlerts";
import { mergeContext } from "../autoBuy/alerts";

const HISTORY_WINDOW_SECONDS = 30 * 24 * 3600;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

interface AutoPayAlertRow {
  id: number;
  member_pubkey: string;
  type: string;
  severity: string;
  status: string;
  consecutive_count: number;
  context_json: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  dismissed_at: number | null;
}

/** API-facing shape: stored row with context_json parsed into `context`. */
export interface AutoPayAlertView {
  id: number;
  member_pubkey: string;
  type: string;
  severity: string;
  status: string;
  consecutive_count: number;
  context: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  dismissed_at: number | null;
}

const VIEW_COLUMNS = `id, member_pubkey, type, severity, status, consecutive_count,
  context_json, created_at, updated_at, resolved_at, dismissed_at`;

function parseContext(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toView(row: AutoPayAlertRow): AutoPayAlertView {
  const { context_json, ...rest } = row;
  return { ...rest, context: parseContext(context_json) };
}

/** Minimal active-alert rows for the pure decision functions + trigger. */
function listActiveAlertRows(
  db: Database.Database,
  memberPubkey: string,
): AutoPayActiveAlertRow[] {
  return db
    .prepare(
      `SELECT id, type, status, consecutive_count, updated_at
       FROM subscription_autopay_alerts
       WHERE member_pubkey = ? AND status = 'active'`,
    )
    .all(memberPubkey) as AutoPayActiveAlertRow[];
}

// ───────────────────────────────────────────────────────────────────────
// Internal: execute a create-or-dedup intent for a signal
// ───────────────────────────────────────────────────────────────────────

function applySignal(
  db: Database.Database,
  memberPubkey: string,
  signal: AutoPaySignal | null,
): void {
  const active = listActiveAlertRows(db, memberPubkey);
  const intent = decideAutoPayAlert(signal, active);
  const now = nowSec();

  if (intent.action === "create") {
    db.prepare(
      `INSERT INTO subscription_autopay_alerts
         (member_pubkey, type, severity, status, consecutive_count, context_json, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 1, ?, ?, ?)`,
    ).run(
      memberPubkey,
      intent.type,
      intent.severity,
      JSON.stringify(intent.context ?? {}),
      now,
      now,
    );
  } else if (intent.action === "increment") {
    const existing = db
      .prepare(`SELECT context_json FROM subscription_autopay_alerts WHERE id = ?`)
      .get(intent.alertId) as { context_json: string | null } | undefined;
    const merged = mergeContext(existing?.context_json, intent.context ?? {});
    db.prepare(
      `UPDATE subscription_autopay_alerts
       SET consecutive_count = consecutive_count + 1,
           updated_at = ?,
           context_json = ?
       WHERE id = ?`,
    ).run(now, JSON.stringify(merged), intent.alertId);
  }
  // noop → nothing
}

// ───────────────────────────────────────────────────────────────────────
// Write paths — called from the scheduler
// ───────────────────────────────────────────────────────────────────────

/**
 * Record a classified auto-pay failure for a member. Create-or-dedup against
 * the member's active alerts. `null` signal (the classifier's defer cases)
 * raises nothing. Never throws into the scheduler tick.
 */
export function recordAutoPayFailure(
  db: Database.Database,
  memberPubkey: string,
  signal: AutoPaySignal | null,
): void {
  try {
    applySignal(db, memberPubkey, signal);
  } catch (err) {
    console.error(
      "[autopay-alerts] recordAutoPayFailure failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Record a successful auto-pay: resolve all active warning alerts for the
 * member (§5 auto-clear), then raise the info-level AUTOPAY_SUCCEEDED
 * notification. Never throws into the scheduler tick.
 */
export function recordAutoPaySuccess(
  db: Database.Database,
  memberPubkey: string,
  context: Record<string, unknown>,
): void {
  try {
    const active = listActiveAlertRows(db, memberPubkey);
    const resolutions = resolveOnSuccess(active);
    const now = nowSec();
    if (resolutions.length > 0) {
      const stmt = db.prepare(
        `UPDATE subscription_autopay_alerts
         SET status = 'resolved', resolved_at = ?, updated_at = ?
         WHERE id = ? AND status = 'active'`,
      );
      for (const r of resolutions) stmt.run(now, now, r.alertId);
    }
    applySignal(db, memberPubkey, { type: "AUTOPAY_SUCCEEDED", context });
  } catch (err) {
    console.error(
      "[autopay-alerts] recordAutoPaySuccess failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Resolve active AUTOPAY_SUCCEEDED rows whose updated_at is older than the
 * given cutoff (epoch seconds) — the "auto-resolve after 24h" lifecycle (§5,
 * Gate-1 rec C). Called by the scheduler each tick; never throws.
 */
export function resolveStaleSucceeded(
  db: Database.Database,
  memberPubkey: string,
  cutoffSec: number,
): void {
  try {
    const now = nowSec();
    db.prepare(
      `UPDATE subscription_autopay_alerts
       SET status = 'resolved', resolved_at = ?, updated_at = updated_at
       WHERE member_pubkey = ? AND type = 'AUTOPAY_SUCCEEDED'
         AND status = 'active' AND updated_at < ?`,
    ).run(now, memberPubkey, cutoffSec);
  } catch (err) {
    console.error(
      "[autopay-alerts] resolveStaleSucceeded failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────
// Read paths — called from the API
// ───────────────────────────────────────────────────────────────────────

/** Active alerts for a member, newest updated_at first. */
export function getActiveAlerts(
  db: Database.Database,
  memberPubkey: string,
): AutoPayAlertView[] {
  const rows = db
    .prepare(
      `SELECT ${VIEW_COLUMNS} FROM subscription_autopay_alerts
       WHERE member_pubkey = ? AND status = 'active' ORDER BY updated_at DESC`,
    )
    .all(memberPubkey) as AutoPayAlertRow[];
  return rows.map(toView);
}

/** All of a member's alerts within the trailing 30 days, newest first. */
export function getAlertHistory(
  db: Database.Database,
  memberPubkey: string,
): AutoPayAlertView[] {
  const cutoff = nowSec() - HISTORY_WINDOW_SECONDS;
  const rows = db
    .prepare(
      `SELECT ${VIEW_COLUMNS} FROM subscription_autopay_alerts
       WHERE member_pubkey = ? AND created_at >= ? ORDER BY created_at DESC`,
    )
    .all(memberPubkey, cutoff) as AutoPayAlertRow[];
  return rows.map(toView);
}

/** Lightweight badge payload for a member. A warning outranks an info. */
export function getBadgeCount(
  db: Database.Database,
  memberPubkey: string,
): { active_count: number; highest_severity: "info" | "warning" | null } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c,
              MAX(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS has_warning
       FROM subscription_autopay_alerts WHERE member_pubkey = ? AND status = 'active'`,
    )
    .get(memberPubkey) as { c: number; has_warning: number | null };
  const count = row?.c ?? 0;
  let highest: "info" | "warning" | null = null;
  if (count > 0) highest = row.has_warning ? "warning" : "info";
  return { active_count: count, highest_severity: highest };
}

/**
 * Dismiss an active alert for a member (idempotent; scoped to the member so
 * one node cannot dismiss another's). Returns the updated row, or null if no
 * such id belongs to the member.
 */
export function dismissAlert(
  db: Database.Database,
  memberPubkey: string,
  id: number,
): AutoPayAlertView | null {
  const now = nowSec();
  db.prepare(
    `UPDATE subscription_autopay_alerts
     SET status = 'dismissed', dismissed_at = ?, updated_at = ?
     WHERE id = ? AND member_pubkey = ? AND status = 'active'`,
  ).run(now, now, id, memberPubkey);
  const row = db
    .prepare(
      `SELECT ${VIEW_COLUMNS} FROM subscription_autopay_alerts
       WHERE id = ? AND member_pubkey = ?`,
    )
    .get(id, memberPubkey) as AutoPayAlertRow | undefined;
  return row ? toView(row) : null;
}
