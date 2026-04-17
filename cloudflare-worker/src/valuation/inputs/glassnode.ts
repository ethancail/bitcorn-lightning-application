import type { Env } from "../../lib/types";
import type { InputReading } from "./types";

const BASE_URL = "https://api.glassnode.com/v1/metrics";

// Fetches a Glassnode metric by path (e.g. "market/mvrv_z_score"). Returns an
// empty array on any upstream failure or missing key so the composite engine
// can simply drop the input for the tick — the caller never throws.
export async function fetchGlassnodeMetric(
  env: Env,
  metricPath: string,
  params: Record<string, string> = { i: "24h" },
): Promise<InputReading[]> {
  const key = env.GLASSNODE_API_KEY;
  if (!key) {
    // Warn (not error): missing secret is a benign "feature disabled" state
    // in dev and initial deploys; reserve error level for actionable failures
    // (HTTP errors, network throws) that may page via logs-based alerting.
    console.warn(`[glassnode] ${metricPath}: GLASSNODE_API_KEY not set`);
    return [];
  }

  const url = new URL(`${BASE_URL}/${metricPath}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { "X-Api-Key": key },
    });
    if (!res.ok) {
      console.error(`[glassnode] ${metricPath}: HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as Array<{ t?: number; v?: number }>;
    if (!Array.isArray(body)) return [];
    const readings: InputReading[] = [];
    for (const row of body) {
      if (typeof row.t !== "number" || typeof row.v !== "number") continue;
      if (!Number.isFinite(row.v)) continue;
      readings.push({ timestamp: row.t, value: row.v });
    }
    readings.sort((a, b) => a.timestamp - b.timestamp);
    return readings;
  } catch (err) {
    console.error(`[glassnode] ${metricPath}: fetch error:`, err instanceof Error ? err.message : err);
    return [];
  }
}
