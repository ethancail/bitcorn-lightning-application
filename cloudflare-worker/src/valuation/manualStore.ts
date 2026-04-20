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
