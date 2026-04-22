import type { Zone } from "./zones";

export const CURRENT_KV_KEY = "valuation_current_v1";
export const HISTORY_KV_KEY = "valuation_history_v1";
export const INPUTS_KV_KEY = "valuation_inputs_v1";

export interface DistributionStats {
  mean: number;
  std_dev: number;
  min_z: number;
  max_z: number;
  min_z_date: string;   // ISO yyyy-mm-dd
  max_z_date: string;
  n: number;            // number of historical datapoints the stats span
}

export interface CurrentValuation {
  z_score: number;
  zone: Zone;
  multiplier: number;
  updated_at: string;
  price_usd: number;
  // Optional — populated once history has ≥1 datapoint. Computed over the
  // full composite z_score series, used by the UI's Distribution Statistics
  // panel and the historical-percentile hero card.
  stats?: DistributionStats;
}

export interface HistoryRow {
  date: string;       // ISO yyyy-mm-dd
  z_score: number;
  zone: Zone;
  price_usd: number;
}

export interface InputSnapshot {
  value: number;
  z: number;
  weight: number;
  updated_at: string;
}

export async function saveCurrent(kv: KVNamespace, cv: CurrentValuation): Promise<void> {
  await kv.put(CURRENT_KV_KEY, JSON.stringify(cv));
}

export async function loadCurrent(kv: KVNamespace): Promise<CurrentValuation | null> {
  const raw = await kv.get(CURRENT_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CurrentValuation;
  } catch (err) {
    console.error("[persist] loadCurrent parse failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function saveHistory(kv: KVNamespace, rows: HistoryRow[]): Promise<void> {
  await kv.put(HISTORY_KV_KEY, JSON.stringify(rows));
}

export async function loadHistory(kv: KVNamespace): Promise<HistoryRow[]> {
  const raw = await kv.get(HISTORY_KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryRow[]) : [];
  } catch (err) {
    console.error("[persist] loadHistory parse failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function saveInputs(
  kv: KVNamespace,
  inputs: Record<string, InputSnapshot>,
): Promise<void> {
  await kv.put(INPUTS_KV_KEY, JSON.stringify(inputs));
}

export async function loadInputs(kv: KVNamespace): Promise<Record<string, InputSnapshot>> {
  const raw = await kv.get(INPUTS_KV_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, InputSnapshot>;
  } catch (err) {
    console.error("[persist] loadInputs parse failed:", err instanceof Error ? err.message : err);
    return {};
  }
}
