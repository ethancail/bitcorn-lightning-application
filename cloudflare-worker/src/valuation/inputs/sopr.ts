import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

// Glassnode exposes raw adjusted SOPR; the composite model expects the 30-day
// moving average. This adapter applies the rolling MA itself:
//   - fetchLatest: trailing-30 average of the most recent 30 points
//   - fetchHistory: sliding 30-day MA starting at index 29
// engine.ts consumes these pre-smoothed values directly.
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
