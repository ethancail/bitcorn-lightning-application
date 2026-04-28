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

export interface DayValueRow {
  metric_key: ManualMetricKey;
  value: number;
  submitted_at: number;
  entry_date: string;
  worker_sync_status: "pending" | "confirmed" | "failed";
  worker_sync_error: string | null;
}

/**
 * Insert one row per (metric, date) representing an operator action.
 * Local store is append-only; the canonical "current value for the date"
 * is the most-recent row by submitted_at. The Worker KV is upserted
 * separately by the calling code.
 */
export function recordCalendarSubmission(
  db: Database.Database,
  entryDate: string,             // "YYYY-MM-DD"
  values: Partial<Record<ManualMetricKey, number>>,
  deletes: ManualMetricKey[],
  submittedAtUnix: number,
): { valueIds: number[]; tombstoneIds: number[] } {
  const createdAt = Math.floor(Date.now() / 1000);
  const valueIds: number[] = [];
  const tombstoneIds: number[] = [];
  const insert = db.prepare(
    `INSERT INTO valuation_manual_inputs
       (metric_key, value, submitted_at, created_at, worker_sync_status, entry_date)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  );
  // Tombstone rows for deletes — value=0 with worker_sync_error='deleted'
  // serves as the sentinel that distinguishes deletes from real zero readings.
  // Tombstones intentionally stay worker_sync_status='pending' forever; the
  // sync-status update path is reserved for value rows so the sentinel
  // survives. Calendar queries (listValuesForDay, summarizeDateRange) check
  // the worker_sync_error sentinel, not worker_sync_status.
  const tombstone = db.prepare(
    `INSERT INTO valuation_manual_inputs
       (metric_key, value, submitted_at, created_at, worker_sync_status, entry_date, worker_sync_error)
     VALUES (?, 0, ?, ?, 'pending', ?, 'deleted')`,
  );
  const txn = db.transaction(() => {
    for (const key of MANUAL_METRIC_KEYS) {
      const v = values[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        const info = insert.run(key, v, submittedAtUnix, createdAt, entryDate);
        valueIds.push(Number(info.lastInsertRowid));
      } else if (deletes.includes(key)) {
        const info = tombstone.run(key, submittedAtUnix, createdAt, entryDate);
        tombstoneIds.push(Number(info.lastInsertRowid));
      }
    }
  });
  txn();
  return { valueIds, tombstoneIds };
}

/**
 * Return the most-recent row per metric for a specific entry_date.
 * Returns null per-metric if no row exists for that date or the latest
 * is a tombstone.
 */
export function listValuesForDay(
  db: Database.Database,
  entryDate: string,
): Record<ManualMetricKey, DayValueRow | null> {
  const rows = db.prepare(
    `SELECT metric_key, value, submitted_at, entry_date,
            worker_sync_status, worker_sync_error
     FROM valuation_manual_inputs v1
     WHERE entry_date = ?
       AND id = (
         SELECT id FROM valuation_manual_inputs v2
         WHERE v2.metric_key = v1.metric_key AND v2.entry_date = ?
         ORDER BY submitted_at DESC, id DESC LIMIT 1
       )`,
  ).all(entryDate, entryDate) as DayValueRow[];

  const out: Partial<Record<ManualMetricKey, DayValueRow | null>> = {};
  for (const k of MANUAL_METRIC_KEYS) out[k] = null;
  for (const row of rows) {
    if (row.worker_sync_error === "deleted") continue;
    out[row.metric_key] = row;
  }
  return out as Record<ManualMetricKey, DayValueRow | null>;
}

/**
 * Per-day completeness across [from, to]. Tombstones (deletes) reduce the
 * count for that day. Returns only days that have ≥1 non-deleted entry.
 */
export function summarizeDateRange(
  db: Database.Database,
  fromDate: string,
  toDate: string,
): Record<string, { filled: number; total: number }> {
  const rows = db.prepare(
    `SELECT entry_date, metric_key,
            (CASE WHEN worker_sync_error = 'deleted' THEN 0 ELSE 1 END) AS is_filled
     FROM valuation_manual_inputs v1
     WHERE entry_date >= ? AND entry_date <= ?
       AND id = (
         SELECT id FROM valuation_manual_inputs v2
         WHERE v2.metric_key = v1.metric_key AND v2.entry_date = v1.entry_date
         ORDER BY submitted_at DESC, id DESC LIMIT 1
       )`,
  ).all(fromDate, toDate) as Array<{ entry_date: string; metric_key: ManualMetricKey; is_filled: number }>;

  const out: Record<string, { filled: number; total: number }> = {};
  for (const r of rows) {
    if (r.is_filled !== 1) continue;
    if (!out[r.entry_date]) out[r.entry_date] = { filled: 0, total: MANUAL_METRIC_KEYS.length };
    out[r.entry_date].filled += 1;
  }
  return out;
}
