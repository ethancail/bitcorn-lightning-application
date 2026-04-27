import type { InputReading } from "./types";

// CoinMetrics Community API — free tier, no key required.
// Docs: https://docs.coinmetrics.io/api/v4
//
// The community API exposes a curated subset of metrics free of charge. We use
// it for MVRV components, Puell Multiple inputs, SOPR, and NVT — replacing the
// 4 most cost-effective Glassnode imports without any subscription.
//
// Defensive contract: any failure (HTTP error, parse error, missing fields,
// empty response) returns []. The caller is expected to fall back to the
// manual-store value or simply skip the input for the current cron tick.
const BASE_URL = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics";
const PAGE_SIZE = 10000;
const DEFAULT_START = "2011-01-01";

interface CoinMetricsResponseRow {
  time?: string;
  asset?: string;
  // The metric value comes back keyed by metric name as a string (e.g.
  // {"time": "...", "asset": "btc", "CapMrktCurUSD": "1234567.89"}).
  [key: string]: string | undefined;
}

interface CoinMetricsResponse {
  data?: CoinMetricsResponseRow[];
  next_page_url?: string;
}

export async function fetchCoinMetricsSeries(
  metric: string,
  options: { startDate?: string; logTag?: string } = {},
): Promise<InputReading[]> {
  const { startDate = DEFAULT_START, logTag = metric } = options;
  const url = new URL(BASE_URL);
  url.searchParams.set("assets", "btc");
  url.searchParams.set("metrics", metric);
  url.searchParams.set("start_time", startDate);
  url.searchParams.set("frequency", "1d");
  url.searchParams.set("page_size", String(PAGE_SIZE));
  url.searchParams.set("pretty", "false");

  const out: InputReading[] = [];
  let nextUrl: string | undefined = url.toString();
  let pages = 0;
  const MAX_PAGES = 4; // ~40k daily readings is far more than BTC has existed for

  try {
    while (nextUrl && pages < MAX_PAGES) {
      const res = await fetch(nextUrl);
      if (!res.ok) {
        console.error(`[coinMetrics:${logTag}] HTTP ${res.status} for ${metric}`);
        return [];
      }
      const body = (await res.json()) as CoinMetricsResponse;
      if (!Array.isArray(body.data)) return [];
      for (const row of body.data) {
        if (!row.time) continue;
        const raw = row[metric];
        if (raw === undefined || raw === null || raw === "") continue;
        const value = Number(raw);
        if (!Number.isFinite(value)) continue;
        const ts = Math.floor(new Date(row.time).getTime() / 1000);
        if (!Number.isFinite(ts)) continue;
        out.push({ timestamp: ts, value });
      }
      nextUrl = body.next_page_url;
      pages += 1;
    }
  } catch (err) {
    console.error(
      `[coinMetrics:${logTag}] fetch error:`,
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}
