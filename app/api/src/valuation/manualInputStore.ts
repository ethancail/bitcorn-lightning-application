import type Database from "better-sqlite3";

export const MANUAL_METRIC_KEYS = [
  "mvrv",
  "puell",
  "sopr",
  "reserve_risk",
  "nvt",
  "hash_ribbons",
  "difficulty_ribbon",
  "hodl_waves",
] as const;

export type ManualMetricKey = (typeof MANUAL_METRIC_KEYS)[number];

export interface LatestPerMetricRow {
  metric_key: ManualMetricKey;
  value: number;
  submitted_at: number;       // unix seconds
  created_at: number;
  worker_sync_status: "pending" | "confirmed" | "failed";
  worker_sync_error: string | null;
  worker_sync_at: number | null;
}

export interface RecordResult {
  insertedIds: number[];
  submittedAt: number;
}

/**
 * Insert 8 rows (one per metric) as a single atomic submission.
 * Returns the inserted row IDs so the worker-client can update sync status later.
 */
export function recordSubmission(
  db: Database.Database,
  values: Record<ManualMetricKey, number>,
  submittedAtUnix: number,
): RecordResult {
  const createdAt = Math.floor(Date.now() / 1000);
  const insertedIds: number[] = [];
  const insert = db.prepare(
    `INSERT INTO valuation_manual_inputs (metric_key, value, submitted_at, created_at, worker_sync_status)
     VALUES (?, ?, ?, ?, 'pending')`,
  );
  const txn = db.transaction(() => {
    for (const key of MANUAL_METRIC_KEYS) {
      const v = values[key];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`invalid value for ${key}: ${v}`);
      }
      const info = insert.run(key, v, submittedAtUnix, createdAt);
      insertedIds.push(Number(info.lastInsertRowid));
    }
  });
  txn();
  return { insertedIds, submittedAt: submittedAtUnix };
}

/**
 * Return the most recent row per metric. Used by GET /api/valuation/manual/status.
 */
export function listLatestPerMetric(db: Database.Database): LatestPerMetricRow[] {
  const rows = db.prepare(
    `SELECT metric_key, value, submitted_at, created_at, worker_sync_status, worker_sync_error, worker_sync_at
     FROM valuation_manual_inputs v1
     WHERE id = (
       SELECT id FROM valuation_manual_inputs v2
       WHERE v2.metric_key = v1.metric_key
       ORDER BY submitted_at DESC, id DESC LIMIT 1
     )`,
  ).all() as LatestPerMetricRow[];
  return rows;
}

/**
 * Mark a batch of rows (by id) as confirmed or failed after the Worker round-trip.
 */
export function updateSyncStatus(
  db: Database.Database,
  ids: number[],
  status: "confirmed" | "failed",
  error?: string,
): void {
  const syncAt = status === "confirmed" ? Math.floor(Date.now() / 1000) : null;
  const stmt = db.prepare(
    `UPDATE valuation_manual_inputs
     SET worker_sync_status = ?, worker_sync_error = ?, worker_sync_at = ?
     WHERE id = ?`,
  );
  const txn = db.transaction(() => {
    for (const id of ids) stmt.run(status, error ?? null, syncAt, id);
  });
  txn();
}
