import type Database from "better-sqlite3";
import {
  decideAlertForFailure,
  updateAlertOnSuccess,
  mergeContext,
  type ActiveAlertRow,
  type FailureSignal,
  type SuccessKind,
} from "./alerts";

// Thin persistence layer for autobuy_alerts (Phase 2, spec §6). The pure
// decision logic lives in alerts.ts; this module executes the intents (insert
// a new row, increment/refresh an existing one, resolve, dismiss) and serves
// the API read shapes. All timestamps are integer epoch seconds to match
// autobuy_runs (do NOT introduce ms timestamps here — spec §1).

const HISTORY_WINDOW_SECONDS = 30 * 24 * 3600;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** Full stored row. */
export interface AutoBuyAlertRow {
  id: number;
  type: string;
  severity: string;
  status: string;
  consecutive_count: number;
  latest_run_id: number | null;
  context_json: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  dismissed_at: number | null;
}

/** API-facing shape: stored row with context_json parsed into `context`. */
export interface AutoBuyAlertView {
  id: number;
  type: string;
  severity: string;
  status: string;
  consecutive_count: number;
  latest_run_id: number | null;
  context: Record<string, unknown> | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  dismissed_at: number | null;
}

function parseContext(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toView(row: AutoBuyAlertRow): AutoBuyAlertView {
  const { context_json, ...rest } = row;
  return { ...rest, context: parseContext(context_json) };
}

/** Minimal active-alert rows for the pure decision functions. */
function listActiveAlertRows(db: Database.Database): ActiveAlertRow[] {
  return db
    .prepare(`SELECT id, type, status, consecutive_count FROM autobuy_alerts WHERE status = 'active'`)
    .all() as ActiveAlertRow[];
}

// ───────────────────────────────────────────────────────────────────────
// Write paths — called from the scheduler
// ───────────────────────────────────────────────────────────────────────

/**
 * Observe a failure: build nothing here — the scheduler passes the normalised
 * signal. Reads current active alerts, asks the pure layer for an intent, and
 * executes it (create / increment / noop). Never throws into the scheduler's
 * critical path — alerting is additive and must not alter buy/sweep flow.
 */
export function raiseAlert(db: Database.Database, signal: FailureSignal | null): void {
  try {
    const active = listActiveAlertRows(db);
    const intent = decideAlertForFailure(signal, active);
    const now = nowSec();

    if (intent.action === "create") {
      db.prepare(
        `INSERT INTO autobuy_alerts
           (type, severity, status, consecutive_count, latest_run_id, context_json, created_at, updated_at)
         VALUES (?, ?, 'active', 1, ?, ?, ?, ?)`,
      ).run(
        intent.type,
        intent.severity,
        intent.latestRunId,
        JSON.stringify(intent.context ?? {}),
        now,
        now,
      );
    } else if (intent.action === "increment") {
      const existing = db
        .prepare(`SELECT context_json FROM autobuy_alerts WHERE id = ?`)
        .get(intent.alertId) as { context_json: string | null } | undefined;
      const merged = mergeContext(existing?.context_json, intent.context ?? {});
      db.prepare(
        `UPDATE autobuy_alerts
         SET consecutive_count = consecutive_count + 1,
             updated_at = ?,
             latest_run_id = COALESCE(?, latest_run_id),
             context_json = ?
         WHERE id = ?`,
      ).run(now, intent.latestRunId, JSON.stringify(merged), intent.alertId);
    }
    // noop → nothing
  } catch (err) {
    console.error("[autobuy-alerts] raiseAlert failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Observe a success: resolve any matching active alerts (spec §3). Resolution
 * flips status to 'resolved' and stamps resolved_at; the row is retained for
 * history. Idempotent and never throws into the scheduler.
 */
export function clearAlerts(db: Database.Database, successKind: SuccessKind): void {
  try {
    const active = listActiveAlertRows(db);
    const resolutions = updateAlertOnSuccess(successKind, active);
    if (resolutions.length === 0) return;
    const now = nowSec();
    const stmt = db.prepare(
      `UPDATE autobuy_alerts SET status = 'resolved', resolved_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`,
    );
    for (const r of resolutions) stmt.run(now, now, r.alertId);
  } catch (err) {
    console.error("[autobuy-alerts] clearAlerts failed:", err instanceof Error ? err.message : err);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Read paths — called from the API
// ───────────────────────────────────────────────────────────────────────

/** Active alerts, newest updated_at first (spec §5 GET /api/autobuy/alerts). */
export function getActiveAlerts(db: Database.Database): AutoBuyAlertView[] {
  const rows = db
    .prepare(
      `SELECT id, type, severity, status, consecutive_count, latest_run_id,
              context_json, created_at, updated_at, resolved_at, dismissed_at
       FROM autobuy_alerts WHERE status = 'active' ORDER BY updated_at DESC`,
    )
    .all() as AutoBuyAlertRow[];
  return rows.map(toView);
}

/** All alerts created within the trailing 30 days, newest first (spec §5). */
export function getAlertHistory(db: Database.Database): AutoBuyAlertView[] {
  const cutoff = nowSec() - HISTORY_WINDOW_SECONDS;
  const rows = db
    .prepare(
      `SELECT id, type, severity, status, consecutive_count, latest_run_id,
              context_json, created_at, updated_at, resolved_at, dismissed_at
       FROM autobuy_alerts WHERE created_at >= ? ORDER BY created_at DESC`,
    )
    .all(cutoff) as AutoBuyAlertRow[];
  return rows.map(toView);
}

/** Lightweight badge payload for the always-on nav poll (spec §5). */
export function getBadgeCount(db: Database.Database): {
  active_count: number;
  highest_severity: "warning" | "critical" | null;
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c,
              MAX(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) AS has_critical
       FROM autobuy_alerts WHERE status = 'active'`,
    )
    .get() as { c: number; has_critical: number | null };
  const count = row?.c ?? 0;
  let highest: "warning" | "critical" | null = null;
  if (count > 0) highest = row.has_critical ? "critical" : "warning";
  return { active_count: count, highest_severity: highest };
}

/**
 * Dismiss an active alert (spec §5 POST /api/autobuy/alerts/{id}/dismiss).
 * Idempotent: dismissing an already-dismissed/resolved (or absent) alert
 * returns the current row without further change. Returns null if no such id.
 */
export function dismissAlert(db: Database.Database, id: number): AutoBuyAlertView | null {
  const now = nowSec();
  db.prepare(
    `UPDATE autobuy_alerts SET status = 'dismissed', dismissed_at = ?, updated_at = ?
     WHERE id = ? AND status = 'active'`,
  ).run(now, now, id);
  const row = db
    .prepare(
      `SELECT id, type, severity, status, consecutive_count, latest_run_id,
              context_json, created_at, updated_at, resolved_at, dismissed_at
       FROM autobuy_alerts WHERE id = ?`,
    )
    .get(id) as AutoBuyAlertRow | undefined;
  return row ? toView(row) : null;
}
