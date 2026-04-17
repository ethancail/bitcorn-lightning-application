import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

const METRIC_PATH = "market/mvrv_z_score";

export const mvrv: InputAdapter = {
  key: "mvrv",
  label: "MVRV Z-Score",
  category: "on-chain",
  source: "Glassnode",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchGlassnodeMetric(env, METRIC_PATH);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return fetchGlassnodeMetric(env, METRIC_PATH);
  },
};
