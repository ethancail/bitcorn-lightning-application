import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

// Glassnode's NVT Signal endpoint is /indicators/nvts (NVT-Signal, 90d MA variant).
const METRIC_PATH = "indicators/nvts";

export const nvt: InputAdapter = {
  key: "nvt",
  label: "NVT Signal",
  category: "market",
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
