import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";

// Stock-to-Flow deviation (price − S2F-model fair-value) / S2F-model fair-value.
// Positive = price above the S2F curve ("overvalued"); negative = below.
// Upstream: PlanB community mirror. No formal SLA — adapter returns null on any
// failure and the composite() function drops the input for that tick.
const ENDPOINT = "https://api.planbtc.com/v1/s2f-deviation";

export const stockToFlow: InputAdapter = {
  key: "stock_to_flow",
  label: "Stock-to-Flow Deviation",
  category: "market",
  source: "PlanB API",

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
    if (env.PLANB_API_KEY) {
      headers["Authorization"] = `Bearer ${env.PLANB_API_KEY}`;
    }
    const res = await fetch(ENDPOINT, { headers });
    if (!res.ok) {
      console.error(`[stockToFlow] HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { data?: Array<{ t?: number; s2f_deviation?: number }> };
    if (!body.data || !Array.isArray(body.data)) return [];
    const readings: InputReading[] = [];
    for (const row of body.data) {
      if (typeof row.t !== "number" || typeof row.s2f_deviation !== "number") continue;
      if (!Number.isFinite(row.s2f_deviation)) continue;
      readings.push({ timestamp: row.t, value: row.s2f_deviation });
    }
    readings.sort((a, b) => a.timestamp - b.timestamp);
    return readings;
  } catch (err) {
    console.error("[stockToFlow] fetch error:", err instanceof Error ? err.message : err);
    return [];
  }
}
