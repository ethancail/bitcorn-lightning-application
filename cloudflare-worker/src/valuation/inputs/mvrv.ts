import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { loadManualHistory } from "../manualStore";
import { fetchCoinMetricsSeries } from "./coinMetrics";

// MVRV ratio = Market Cap / Realized Cap. CoinMetrics publishes the ratio
// pre-computed as `CapMVRVCur` in their Community (free) tier — verified by
// probing the catalog. Engine then Z-scores the full series.
//
// Free-tier note: `CapRealUSD` and `CapMVRVZ` are gated; only `CapMVRVCur` is
// accessible without paid credentials. Falls back to operator-entered manual
// values if the API fails.
async function fetchHistory(env: Env): Promise<InputReading[]> {
  const series = await fetchCoinMetricsSeries("CapMVRVCur", { logTag: "mvrv" });
  if (series.length > 0) return series;

  const manual = await loadManualHistory(env.PRICES_CACHE);
  return manual.mvrv ?? [];
}

export const mvrv: InputAdapter = {
  key: "mvrv",
  label: "MVRV Z-Score",
  category: "on-chain",
  source: "CoinMetrics Community",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchHistory(env);
    return history.length === 0 ? null : history[history.length - 1];
  },

  fetchHistory,
};
