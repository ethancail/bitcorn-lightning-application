import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";

const ENDPOINT = "https://api.cryptoquant.com/v1/btc/flow-indicator/miner-outflow";

export const minerOutflows: InputAdapter = {
  key: "miner_outflows",
  label: "Miner Outflows",
  category: "mining",
  source: "CryptoQuant",

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
  const key = env.CRYPTOQUANT_API_KEY;
  if (!key) {
    console.warn("[minerOutflows] CRYPTOQUANT_API_KEY not set");
    return [];
  }
  const url = new URL(ENDPOINT);
  url.searchParams.set("exchange", "all_miner");
  url.searchParams.set("window", "day");
  try {
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      console.error(`[minerOutflows] HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as {
      result?: { data?: Array<{ datetime?: string; flow_total?: number }> };
    };
    const rows = body.result?.data;
    if (!Array.isArray(rows)) return [];
    const readings: InputReading[] = [];
    for (const row of rows) {
      if (!row.datetime || typeof row.flow_total !== "number") continue;
      if (!Number.isFinite(row.flow_total)) continue;
      const ts = Math.floor(new Date(row.datetime).getTime() / 1000);
      if (!Number.isFinite(ts)) continue;
      readings.push({ timestamp: ts, value: row.flow_total });
    }
    readings.sort((a, b) => a.timestamp - b.timestamp);
    return readings;
  } catch (err) {
    console.error("[minerOutflows] fetch error:", err instanceof Error ? err.message : err);
    return [];
  }
}
