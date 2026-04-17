import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

// Glassnode's Realized Cap HODL Waves. Metric returns the 1y-2y realized-cap
// share as a scalar per day via /supply/realized_hodl_waves with band=1y_2y.
const METRIC_PATH = "supply/realized_hodl_waves";

export const hodlWaves: InputAdapter = {
  key: "hodl_waves",
  label: "Realized Cap HODL Waves",
  category: "sentiment",
  source: "Glassnode",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchGlassnodeMetric(env, METRIC_PATH, { i: "24h", band: "1y_2y" });
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return fetchGlassnodeMetric(env, METRIC_PATH, { i: "24h", band: "1y_2y" });
  },
};
