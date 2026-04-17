import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";

const ENDPOINT = "https://api.lookintobitcoin.com/v1/pi-cycle-top";

export const piCycle: InputAdapter = {
  key: "pi_cycle",
  label: "PI Cycle Top Indicator",
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
      console.error(`[piCycle] HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { data?: Array<{ timestamp?: number; ratio?: number }> };
    if (!body.data || !Array.isArray(body.data)) return [];
    const readings: InputReading[] = [];
    for (const row of body.data) {
      if (typeof row.timestamp !== "number" || typeof row.ratio !== "number") continue;
      if (!Number.isFinite(row.ratio)) continue;
      readings.push({ timestamp: row.timestamp, value: row.ratio });
    }
    readings.sort((a, b) => a.timestamp - b.timestamp);
    return readings;
  } catch (err) {
    console.error("[piCycle] fetch error:", err instanceof Error ? err.message : err);
    return [];
  }
}
