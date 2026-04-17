import type { Env } from "../lib/types";
import { composite, INPUT_WEIGHTS } from "./composite";
import { ADAPTERS } from "./inputs";
import {
  saveCurrent,
  saveHistory,
  saveInputs,
  type CurrentValuation,
  type HistoryRow,
  type InputSnapshot,
} from "./persist";
import { classifyZone } from "./zones";
import { computeStats, toZScore } from "./zscore";

export interface EngineContext {
  priceUsd: number;
  nowISO: string;
}

// Fetches Bitcoin spot price from Coinbase. Returns 0 on failure (caller may
// still persist the valuation; the UI shows "—" for unknown prices).
export async function fetchSpotPrice(): Promise<number> {
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    if (!res.ok) return 0;
    const body = (await res.json()) as { data?: { amount?: string } };
    const amount = body.data?.amount;
    if (!amount) return 0;
    const n = Number(amount);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    console.error("[engine] spot price fetch failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

export async function runEngine(env: Env, ctx: EngineContext): Promise<void> {
  // 1. Fetch every adapter's full history in parallel.
  const results = await Promise.all(
    ADAPTERS.map(async (a) => ({ adapter: a, history: await a.fetchHistory(env) })),
  );

  // 2. For each adapter with usable history, compute per-day Z-scores over
  //    the full series and capture (a) the latest Z (for composite), (b) the
  //    full Z-series (for the composite history rollup).
  const latestZByKey: Record<string, number> = {};
  const snapshots: Record<string, InputSnapshot> = {};
  // date (yyyy-mm-dd) → { [key]: z }
  const byDate = new Map<string, Record<string, number>>();

  for (const { adapter, history } of results) {
    if (history.length === 0) continue;

    const values = history.map((r) => r.value);
    const stats = computeStats(values);

    const zSeries = values.map((v) => toZScore(v, stats));
    latestZByKey[adapter.key] = zSeries[zSeries.length - 1];

    snapshots[adapter.key] = {
      value: values[values.length - 1],
      z: zSeries[zSeries.length - 1],
      weight: INPUT_WEIGHTS[adapter.key] ?? 0,
      updated_at: ctx.nowISO,
    };

    for (let i = 0; i < history.length; i++) {
      const date = isoDate(history[i].timestamp);
      const bucket = byDate.get(date) ?? {};
      bucket[adapter.key] = zSeries[i];
      byDate.set(date, bucket);
    }
  }

  // 3. Current composite + zone.
  let currentZ: number;
  try {
    currentZ = composite(latestZByKey);
  } catch {
    currentZ = Number.NaN;
  }
  const zone = classifyZone(currentZ);
  const current: CurrentValuation = {
    z_score: Number.isFinite(currentZ) ? currentZ : 0,
    zone: zone.zone,
    multiplier: zone.multiplier,
    updated_at: ctx.nowISO,
    price_usd: ctx.priceUsd,
  };

  // 4. Per-day composite history (uses whatever adapters had a reading that day).
  const history: HistoryRow[] = [];
  const sortedDates = [...byDate.keys()].sort();
  for (const date of sortedDates) {
    const bucket = byDate.get(date)!;
    let z: number;
    try {
      z = composite(bucket);
    } catch {
      continue;
    }
    history.push({
      date,
      z_score: z,
      zone: classifyZone(z).zone,
      price_usd: 0, // price history backfill is out of scope for Plan 1
    });
  }

  // 5. Persist.
  await saveCurrent(env.PRICES_CACHE, current);
  await saveHistory(env.PRICES_CACHE, history);
  await saveInputs(env.PRICES_CACHE, snapshots);
}

function isoDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().slice(0, 10);
}
