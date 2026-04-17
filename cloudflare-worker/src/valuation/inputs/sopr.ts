import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

// Glassnode exposes an adjusted SOPR metric; we consume the 30-day moving
// average by downloading the raw series and averaging over the trailing 30d
// at consumption time in the engine. Keeping the adapter simple: return the
// raw daily adjusted SOPR series; engine.ts computes the 30d MA.
const METRIC_PATH = "indicators/sopr_adjusted";

export const sopr: InputAdapter = {
  key: "sopr",
  label: "SOPR (30d MA)",
  category: "on-chain",
  source: "Glassnode",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchGlassnodeMetric(env, METRIC_PATH);
    if (history.length < 30) return null;
    const tail = history.slice(-30);
    const avg = tail.reduce((a, r) => a + r.value, 0) / tail.length;
    return { timestamp: history[history.length - 1].timestamp, value: avg };
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    const raw = await fetchGlassnodeMetric(env, METRIC_PATH);
    // Rolling 30d MA across the history
    const out: InputReading[] = [];
    for (let i = 29; i < raw.length; i++) {
      let sum = 0;
      for (let j = i - 29; j <= i; j++) sum += raw[j].value;
      out.push({ timestamp: raw[i].timestamp, value: sum / 30 });
    }
    return out;
  },
};
