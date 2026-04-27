import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { loadManualHistory } from "../manualStore";
import { fetchCoinMetricsSeries } from "./coinMetrics";

// Hash Ribbons — Bitcoin's miner-capitulation indicator. The ratio of the
// 30-day MA of network hashrate over the 60-day MA of the same series.
//
//   ratio > 1.0  → 30d > 60d, miners expanding (recovery / bullish)
//   ratio < 1.0  → 30d < 60d, miners capitulating (bottom signal)
//
// Engine then Z-scores the full ratio history. The free-tier `HashRate`
// metric on CoinMetrics Community publishes the raw daily hashrate, which
// we smooth into the two trailing MAs locally. Both `HashRate30d` and
// every other pre-smoothed variant are gated, so we compute the MAs
// ourselves rather than pulling them.
//
// Falls back to operator-entered manual values if the API fails.
async function fetchHistory(env: Env): Promise<InputReading[]> {
  const daily = await fetchCoinMetricsSeries("HashRate", { logTag: "hashRibbons" });

  if (daily.length >= 60) {
    const ratios: InputReading[] = [];
    let sum30 = 0;
    let sum60 = 0;
    for (let i = 0; i < daily.length; i++) {
      sum30 += daily[i].value;
      sum60 += daily[i].value;
      if (i >= 30) sum30 -= daily[i - 30].value;
      if (i >= 60) sum60 -= daily[i - 60].value;
      if (i < 59) continue; // need both windows fully populated
      const ma30 = sum30 / 30;
      const ma60 = sum60 / 60;
      if (ma60 <= 0 || !Number.isFinite(ma60) || !Number.isFinite(ma30)) continue;
      ratios.push({ timestamp: daily[i].timestamp, value: ma30 / ma60 });
    }
    if (ratios.length > 0) return ratios;
  }

  const manual = await loadManualHistory(env.PRICES_CACHE);
  return manual.hash_ribbons ?? [];
}

export const hashRibbons: InputAdapter = {
  key: "hash_ribbons",
  label: "Hash Ribbons",
  category: "mining",
  source: "CoinMetrics Community",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchHistory(env);
    return history.length === 0 ? null : history[history.length - 1];
  },

  fetchHistory,
};
