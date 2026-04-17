import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";

// 200-Week Moving Average Heatmap: percentage deviation of price from the
// 200-week MA. Used by LookIntoBitcoin to flag macro cycle extremes.
// Upstream is served from LookIntoBitcoin via community-mirrored endpoints —
// no formal SLA. Adapter returns null/[] on any failure and the composite()
// function drops the input for that tick.
const ENDPOINT = "https://api.lookintobitcoin.com/v1/200w-ma-heatmap";

export const ma200w: InputAdapter = {
  key: "ma_200w",
  label: "200-Week MA Heatmap",
  category: "market",
  source: "LookIntoBitcoin",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchAll(env);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return fetchAll(env);
  },
};

async function fetchAll(env: Env): Promise<InputReading[]> {
  try {
    const headers: Record<string, string> = {};
    if (env.LOOKINTOBITCOIN_API_KEY) {
      headers["X-API-KEY"] = env.LOOKINTOBITCOIN_API_KEY;
    }
    const res = await fetch(ENDPOINT, { headers });
    if (!res.ok) {
      console.error(`[ma200w] HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { data?: Array<{ timestamp?: number; pct_deviation?: number }> };
    if (!body.data || !Array.isArray(body.data)) return [];
    const readings: InputReading[] = [];
    for (const row of body.data) {
      if (typeof row.timestamp !== "number" || typeof row.pct_deviation !== "number") continue;
      if (!Number.isFinite(row.pct_deviation)) continue;
      readings.push({ timestamp: row.timestamp, value: row.pct_deviation });
    }
    readings.sort((a, b) => a.timestamp - b.timestamp);
    return readings;
  } catch (err) {
    console.error("[ma200w] fetch error:", err instanceof Error ? err.message : err);
    return [];
  }
}
