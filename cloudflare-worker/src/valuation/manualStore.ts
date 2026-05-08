import type { InputReading } from "./inputs/types";

export const MANUAL_KV_KEY = "valuation_manual_v1";

export const MANUAL_METRIC_KEYS = [
  "mvrv",
  "puell",
  "sopr",
  "reserve_risk",
  "nvt",
  "hash_ribbons",
  "difficulty_ribbon",
  "miner_outflows",
  "hodl_waves",
] as const;

export type ManualMetricKey = (typeof MANUAL_METRIC_KEYS)[number];

export type ManualValues = Record<ManualMetricKey, number>;
export type ManualHistory = Record<ManualMetricKey, InputReading[]>;

function emptyHistory(): ManualHistory {
  const h: Partial<ManualHistory> = {};
  for (const k of MANUAL_METRIC_KEYS) h[k] = [];
  return h as ManualHistory;
}

export async function loadManualHistory(kv: KVNamespace): Promise<ManualHistory> {
  const raw = await kv.get(MANUAL_KV_KEY);
  if (!raw) return emptyHistory();
  try {
    const parsed = JSON.parse(raw) as Partial<ManualHistory>;
    const out = emptyHistory();
    for (const k of MANUAL_METRIC_KEYS) {
      const series = parsed[k];
      if (Array.isArray(series)) out[k] = series;
    }
    return out;
  } catch (err) {
    console.error("[manualStore] load parse failed:", err instanceof Error ? err.message : err);
    return emptyHistory();
  }
}

// Read-modify-write on one KV key. NOT safe for concurrent callers — the
// treasury node is expected to submit sequentially (one daily-entry form).
// Two overlapping calls across Cloudflare colos would last-writer-win and
// silently drop one submission. Workers KV has no CAS primitive; if a second
// writer ever exists, migrate to a Durable Object.
export async function appendManualSubmission(
  kv: KVNamespace,
  submittedAtISO: string,
  values: ManualValues,
): Promise<void> {
  const history = await loadManualHistory(kv);
  const timestamp = Math.floor(new Date(submittedAtISO).getTime() / 1000);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`[manualStore] invalid submittedAt: ${submittedAtISO}`);
  }
  for (const k of MANUAL_METRIC_KEYS) {
    const value = values[k];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    history[k].push({ timestamp, value });
  }
  await kv.put(MANUAL_KV_KEY, JSON.stringify(history));
}

// All entries align to UTC midnight of their `entry_date`. This makes
// upsert-by-date trivially correct (same date string → same timestamp)
// and matches Glassnode's daily-resolution publishing cadence.
function dateToTimestamp(dateStr: string): number {
  // dateStr: "YYYY-MM-DD" → unix seconds at UTC midnight of that day
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const t = Math.floor(d.getTime() / 1000);
  if (!Number.isFinite(t)) {
    throw new Error(`[manualStore] invalid date: ${dateStr}`);
  }
  return t;
}

function timestampToDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Upsert N metrics for a specific date. Existing entries on the same
 * (date, metric) key are replaced in place. Other dates are untouched.
 * Pass `deletes` to remove specific metrics for that date in the same
 * round-trip.
 */
export async function upsertManualEntries(
  kv: KVNamespace,
  dateStr: string,
  values: Partial<ManualValues>,
  deletes: ManualMetricKey[] = [],
): Promise<void> {
  const ts = dateToTimestamp(dateStr);
  const history = await loadManualHistory(kv);

  for (const k of MANUAL_METRIC_KEYS) {
    const series = history[k];
    const sameDayIdx = series.findIndex((r) => r.timestamp === ts);

    if (deletes.includes(k)) {
      if (sameDayIdx !== -1) series.splice(sameDayIdx, 1);
      continue;
    }

    const v = values[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;

    if (sameDayIdx !== -1) {
      series[sameDayIdx] = { timestamp: ts, value: v };
    } else {
      series.push({ timestamp: ts, value: v });
      series.sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  await kv.put(MANUAL_KV_KEY, JSON.stringify(history));
}

/**
 * Return the value for each metric on a specific date, or null if absent.
 */
export async function getDayValues(
  kv: KVNamespace,
  dateStr: string,
): Promise<Record<ManualMetricKey, number | null>> {
  const ts = dateToTimestamp(dateStr);
  const history = await loadManualHistory(kv);
  const out: Partial<Record<ManualMetricKey, number | null>> = {};
  for (const k of MANUAL_METRIC_KEYS) {
    const hit = history[k].find((r) => r.timestamp === ts);
    out[k] = hit ? hit.value : null;
  }
  return out as Record<ManualMetricKey, number | null>;
}

/**
 * Return per-day completeness counts across the inclusive [from, to] range.
 * Days with zero entries are omitted; caller treats missing dates as 0/8.
 */
export async function getCalendarSummary(
  kv: KVNamespace,
  fromDateStr: string,
  toDateStr: string,
): Promise<Record<string, { filled: number; total: number }>> {
  const fromTs = dateToTimestamp(fromDateStr);
  const toTs = dateToTimestamp(toDateStr);
  if (fromTs > toTs) return {};

  const history = await loadManualHistory(kv);
  const counts = new Map<string, number>();
  for (const k of MANUAL_METRIC_KEYS) {
    for (const reading of history[k]) {
      if (reading.timestamp < fromTs || reading.timestamp > toTs) continue;
      const date = timestampToDate(reading.timestamp);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
  }
  const out: Record<string, { filled: number; total: number }> = {};
  for (const [date, filled] of counts) {
    out[date] = { filled, total: MANUAL_METRIC_KEYS.length };
  }
  return out;
}
