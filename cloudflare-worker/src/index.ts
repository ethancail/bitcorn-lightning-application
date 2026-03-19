// Bitcorn Lightning — Cloudflare Worker
//
// Endpoints:
//   POST /                   — Coinbase Onramp session token
//   GET  /prices             — Futures prices (gold, corn, soybeans, wheat) via TradingView scanner
//   GET  /prices/corn-history — Historical monthly corn prices via USDA NASS
//   GET  /recommended-peers  — Curated external peer list
//   GET  /treasury-info      — Treasury node connection info
//
// Price source: TradingView scanner API (no key required, ~10-min delayed futures)
//   Gold:     COMEX:GC1!  (front-month continuous)
//   Corn:     CBOT:ZC1!   (front-month continuous)
//   Soybeans: CBOT:ZS1!   (front-month continuous)
//   Wheat:    CBOT:ZW1!   (front-month continuous)
//
// Deploy:
//   cd cloudflare-worker
//   npm install
//   wrangler secret put CDP_KEY_NAME      # paste your key name
//   wrangler secret put CDP_PRIVATE_KEY   # paste your full PEM (one line with \n)
//   wrangler secret put USDA_NASS_KEY     # paste your USDA NASS API key (for corn history)
//   wrangler deploy
//
// The deployed URL (https://bitcorn-onramp.<you>.workers.dev) goes into
// COINBASE_WORKER_URL in the app's docker-compose.yml.

import { SignJWT, importPKCS8 } from "jose";

// Cloudflare Workers use the Web Crypto API which only accepts PKCS#8 format
// ("-----BEGIN PRIVATE KEY-----"). CDP keys come in SEC1 format
// ("-----BEGIN EC PRIVATE KEY-----"). This function wraps the SEC1 DER in a
// PKCS#8 AlgorithmIdentifier envelope for P-256 (secp256r1).
function sec1ToPkcs8Pem(sec1Pem: string): string {
  // Strip PEM header/footer lines and all whitespace to get raw base64
  const b64 = sec1Pem
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("-----"))
    .join("")
    .replace(/\s/g, "");

  // Log any characters that aren't valid base64 (helps debug encoding issues)
  const invalidChars = [...b64].filter((c) => !/[A-Za-z0-9+/=]/.test(c));
  if (invalidChars.length > 0) {
    console.error("Invalid base64 char codes:", invalidChars.map((c) => c.charCodeAt(0)));
  }

  // Strip any non-base64 characters defensively before decoding
  const b64clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const sec1Der = Uint8Array.from(atob(b64clean), (c) => c.charCodeAt(0));

  const derLen = (n: number): number[] =>
    n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, (n >> 8) & 0xff, n & 0xff];

  // AlgorithmIdentifier: SEQUENCE { OID id-ecPublicKey, OID prime256v1 }
  const algId = [
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ];

  const octet = [0x04, ...derLen(sec1Der.length), ...sec1Der];
  const inner = [0x02, 0x01, 0x00, ...algId, ...octet]; // version + algId + key
  const pkcs8Der = new Uint8Array([0x30, ...derLen(inner.length), ...inner]);

  const b64out = btoa(String.fromCharCode(...pkcs8Der));
  const lines = (b64out.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

interface Env {
  CDP_KEY_NAME: string;
  CDP_PRIVATE_KEY: string;
  USDA_NASS_KEY: string;     // still needed for /prices/corn-history (USDA NASS monthly data)
  PRICES_CACHE: KVNamespace;
  TREASURY_PUBKEY?: string;
  TREASURY_SOCKET?: string;
}

// ─── CORS headers ────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "X-Price-Source",
};

// ─── Commodity price types ───────────────────────────────────────────────

type CommodityPrice = {
  price: number;
  unit: string;
  label: string;
  updated_at: string;
} | null;

type CommodityPrices = {
  gold: CommodityPrice;
  corn: CommodityPrice;
  soybeans: CommodityPrice;
  wheat: CommodityPrice;
};

// ─── Price fetchers ──────────────────────────────────────────────────────

// OPERATIONAL RISK: TradingView scanner is an UNDOCUMENTED public endpoint.
// No API key, no SLA, no versioning. It is used by open-source libs (tradingview-ta,
// tradingview-scraper) and has been stable for years, but could change or be
// rate-limited without notice. The handlePrices() function has a KV fallback:
// if this fetch fails, the last successful cached response is served instead of
// all-null data. Monitor Worker logs for "TradingView" errors.
//
// Data delay: ~10 minutes (update_mode: "delayed_streaming_600").
// The PRICES_CACHE_TTL is intentionally set to 600s (10 min) to match this —
// caching shorter would re-fetch identical delayed quotes; caching longer
// would make the ticker feel stale for intraday-moving futures prices.
//
// NOTE: These are FUTURES prices (front-month continuous contracts), not spot.
// Historical corn charts still use USDA NASS monthly "PRICE RECEIVED" data via
// /prices/corn-history — a different data model (farm-gate spot vs. exchange
// futures). Do not mix the two without accounting for basis differential.
const TV_SCANNER_URL = "https://scanner.tradingview.com/futures/scan";

type TVSymbolConfig = {
  ticker: string;     // TradingView symbol, e.g. "COMEX:GC1!"
  label: string;      // Human-readable, e.g. "Gold"
  unit: string;       // Display unit, e.g. "$/oz"
  // Unit conversion:
  //   Gold (GC1!): quoted in USD/oz on COMEX → divisor=1, already dollars
  //   Corn (ZC1!), Soybeans (ZS1!), Wheat (ZW1!): quoted in cents/bu on CBOT
  //     → divisor=100 to convert to $/bu
  divisor: number;
  decimals: number;   // rounding precision for display (not lossy — applied last)
};

const TV_SYMBOLS: Record<string, TVSymbolConfig> = {
  gold:     { ticker: "COMEX:GC1!", label: "Gold",      unit: "$/oz", divisor: 1,   decimals: 2 },
  corn:     { ticker: "CBOT:ZC1!",  label: "Corn",      unit: "$/bu", divisor: 100, decimals: 4 },
  soybeans: { ticker: "CBOT:ZS1!",  label: "Soybeans",  unit: "$/bu", divisor: 100, decimals: 4 },
  wheat:    { ticker: "CBOT:ZW1!",  label: "Wheat",     unit: "$/bu", divisor: 100, decimals: 4 },
};

// Expected columns requested from the scanner. If TradingView changes the
// response schema, the column index mapping below will break — the per-row
// validation catches this and logs which symbol/field failed.
const TV_COLUMNS = ["close", "description", "exchange", "type", "pricescale"] as const;
const COL_CLOSE = 0;

type TVScanRow = { s: string; d: unknown[] };
type TVScanResponse = {
  totalCount: number;
  data: TVScanRow[] | null;
  error?: string;
};

/** Fetch futures prices. Returns partial results on per-symbol failure, all-null on total failure. */
async function fetchFuturesPrices(): Promise<CommodityPrices> {
  const tickers = Object.values(TV_SYMBOLS).map((s) => s.ticker);
  const now = new Date().toISOString();

  // Default: all null. Callers (handlePrices) handle fallback to cached data.
  const result: CommodityPrices = { gold: null, corn: null, soybeans: null, wheat: null };

  try {
    const res = await fetch(TV_SCANNER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers, query: { types: [] } },
        columns: [...TV_COLUMNS],
      }),
    });

    if (!res.ok) {
      console.error(`[tv-scanner] HTTP ${res.status} ${res.statusText}`);
      return result;
    }

    const data: TVScanResponse = await res.json();

    if (data.error) {
      console.error(`[tv-scanner] API error: ${data.error}`);
      return result;
    }

    if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
      console.error("[tv-scanner] empty or missing data array");
      return result;
    }

    // Build reverse map: ticker → commodity key
    const tickerToKey = new Map<string, string>();
    for (const [key, cfg] of Object.entries(TV_SYMBOLS)) {
      tickerToKey.set(cfg.ticker, key);
    }

    // Track which symbols we got back to log any that are missing
    const seen = new Set<string>();

    for (const row of data.data) {
      // Validate row structure
      if (!row.s || !Array.isArray(row.d)) {
        console.error("[tv-scanner] malformed row, missing 's' or 'd':", JSON.stringify(row).slice(0, 200));
        continue;
      }

      const key = tickerToKey.get(row.s) as keyof CommodityPrices | undefined;
      if (!key) {
        // Unexpected symbol in response — not an error, just skip
        continue;
      }
      seen.add(key);

      // Validate the close price field exists and is a number
      if (row.d.length <= COL_CLOSE) {
        console.error(`[tv-scanner] ${row.s}: response has ${row.d.length} columns, expected at least ${COL_CLOSE + 1}`);
        continue;
      }

      const rawPrice = row.d[COL_CLOSE];
      if (typeof rawPrice !== "number" || isNaN(rawPrice) || rawPrice <= 0) {
        console.error(`[tv-scanner] ${row.s}: invalid close price: ${JSON.stringify(rawPrice)}`);
        continue;
      }

      const cfg = TV_SYMBOLS[key];
      const price = rawPrice / cfg.divisor;
      const rounded = Math.round(price * 10 ** cfg.decimals) / 10 ** cfg.decimals;

      result[key] = {
        price: rounded,
        unit: cfg.unit,
        label: cfg.label,
        updated_at: now,
      };
    }

    // Log any expected symbols that were missing from the response
    const missing = Object.keys(TV_SYMBOLS).filter((k) => !seen.has(k));
    if (missing.length > 0) {
      console.error(`[tv-scanner] missing symbols in response: ${missing.join(", ")}`);
    }
  } catch (err) {
    console.error("[tv-scanner] fetch error:", err instanceof Error ? err.message : err);
  }

  return result;
}

/** Count how many commodities have a non-null price. */
function countPrices(prices: CommodityPrices): number {
  return Object.values(prices).filter((p) => p != null).length;
}

// ─── /prices/corn-history handler ────────────────────────────────────────

type CornHistoryEntry = { year: number; month: number; price: number };

const CORN_HISTORY_KV_KEY = "corn_price_history";
const CORN_HISTORY_CACHE_TTL = 86400; // 24 hours — monthly data, no need for frequent refresh

async function handleCornHistory(env: Env): Promise<Response> {
  // Check KV cache first
  const cached = await env.PRICES_CACHE.get(CORN_HISTORY_KV_KEY);
  if (cached) {
    return new Response(cached, {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  const key = env.USDA_NASS_KEY?.replace(/^["']|["']$/g, "");
  if (!key) {
    return new Response(JSON.stringify({ error: "USDA key not configured" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  try {
    const params = new URLSearchParams({
      key,
      commodity_desc: "CORN",
      statisticcat_desc: "PRICE RECEIVED",
      unit_desc: "$ / BU",
      freq_desc: "MONTHLY",
      year__GE: "2014",
      format: "JSON",
    });
    const res = await fetch(
      `https://quickstats.nass.usda.gov/api/api_GET/?${params.toString()}`,
    );
    if (!res.ok) {
      return new Response("USDA API error", { status: 502, headers: CORS_HEADERS });
    }
    const data = (await res.json()) as {
      data: Array<{ year: number; reference_period_desc: string; Value: string }>;
    };
    if (!data.data || data.data.length === 0) {
      return new Response(JSON.stringify([]), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    const MONTHS: Record<string, number> = {
      JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
      JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
    };

    const entries: CornHistoryEntry[] = [];
    for (const row of data.data) {
      const monthKey = row.reference_period_desc?.toUpperCase().slice(0, 3);
      const month = MONTHS[monthKey];
      if (!month) continue;
      const price = parseFloat(row.Value.replace(/,/g, ""));
      if (isNaN(price) || price <= 0) continue;
      entries.push({ year: row.year, month, price });
    }

    // Sort chronologically
    entries.sort((a, b) => a.year - b.year || a.month - b.month);

    const body = JSON.stringify(entries);
    await env.PRICES_CACHE.put(CORN_HISTORY_KV_KEY, body, { expirationTtl: CORN_HISTORY_CACHE_TTL });

    return new Response(body, {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err) {
    console.error("Corn history error:", err instanceof Error ? err.message : err);
    return new Response("Internal error", { status: 500, headers: CORS_HEADERS });
  }
}

// ─── /prices handler ─────────────────────────────────────────────────────

const KV_KEY = "commodity_prices";
// Fallback key persists the last successful response with a longer TTL so that
// if TradingView goes down *after* the 10-min cache expires, we still have
// something to serve instead of all-null data.
const KV_FALLBACK_KEY = "commodity_prices_fallback";
// 10 min — intentionally matched to TradingView's delayed_streaming_600 behavior.
// Shorter would re-fetch identical delayed data. Longer would make the ticker
// feel stale for intraday-moving futures prices.
const PRICES_CACHE_TTL = 600;          // 10 minutes — controls re-fetch cadence
const PRICES_FALLBACK_TTL = 86400;     // 24 hours — safety net for outages

// X-Price-Source header tells callers where the data came from:
//   "live"     — fresh TradingView fetch, cached now
//   "cache"    — served from the 10-min KV cache (normal hot path)
//   "fallback" — TradingView failed, serving last-known-good data (up to 24h old)
//   "none"     — TradingView failed and no cached data exists (all-null response)
//
// The updated_at field inside each commodity object is always the timestamp of
// the original fetch — so stale fallback data will have an old updated_at,
// letting consumers measure data age independently of the source header.

async function handlePrices(env: Env): Promise<Response> {
  // 1. Serve from KV cache if fresh (< 10 min old)
  const cached = await env.PRICES_CACHE.get(KV_KEY);
  if (cached) {
    return new Response(cached, {
      headers: { "Content-Type": "application/json", "X-Price-Source": "cache", ...CORS_HEADERS },
    });
  }

  // 2. Cache miss or expired — fetch live from TradingView
  const result = await fetchFuturesPrices();
  const freshCount = countPrices(result);

  if (freshCount > 0) {
    // Got at least some data. Always write the 10-min cache (serves partial
    // results for the next 10 min — better to show 3/4 fresh than 4/4 stale).
    const body = JSON.stringify(result);
    await env.PRICES_CACHE.put(KV_KEY, body, { expirationTtl: PRICES_CACHE_TTL });

    // Only update the 24h fallback if the fresh result is at least as complete
    // as what's already stored. This prevents a partial failure (e.g. 1/4)
    // from overwriting a previously full (4/4) fallback.
    const existingFallback = await env.PRICES_CACHE.get(KV_FALLBACK_KEY);
    let fallbackCount = 0;
    if (existingFallback) {
      try {
        fallbackCount = countPrices(JSON.parse(existingFallback) as CommodityPrices);
      } catch { /* corrupt fallback — overwrite it */ }
    }

    if (freshCount >= fallbackCount) {
      await env.PRICES_CACHE.put(KV_FALLBACK_KEY, body, { expirationTtl: PRICES_FALLBACK_TTL });
    }

    return new Response(body, {
      headers: { "Content-Type": "application/json", "X-Price-Source": "live", ...CORS_HEADERS },
    });
  }

  // 3. Total failure — all prices null. Serve the last successful response
  //    from the fallback key (survives up to 24h after the 10-min key expires).
  const fallback = await env.PRICES_CACHE.get(KV_FALLBACK_KEY);
  if (fallback) {
    console.error("[prices] TradingView failed, serving fallback cache");
    return new Response(fallback, {
      headers: { "Content-Type": "application/json", "X-Price-Source": "fallback", ...CORS_HEADERS },
    });
  }

  // 4. No fallback either — first-ever fetch failed, or outage > 24h.
  //    Return all-null so the frontend shows "—" for each ticker.
  console.error("[prices] TradingView failed and no fallback cache available");
  return new Response(JSON.stringify(result), {
    headers: { "Content-Type": "application/json", "X-Price-Source": "none", ...CORS_HEADERS },
  });
}

// ─── Coinbase Onramp handler ─────────────────────────────────────────────

async function handleOnramp(request: Request, env: Env): Promise<Response> {
  let address: string;
  try {
    const body = (await request.json()) as { address?: string };
    address = body.address ?? "";
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!address) {
    return new Response("Missing address", { status: 400 });
  }

  try {
    const keyName = env.CDP_KEY_NAME.replace(/^["']|["']$/g, "");
    const sec1Pem = env.CDP_PRIVATE_KEY
      .replace(/^["']|["']$/g, "") // strip surrounding quotes if copied from JSON
      .replace(/\\n/g, "\n");
    const pkcs8Pem = sec1Pem.includes("BEGIN EC PRIVATE KEY")
      ? sec1ToPkcs8Pem(sec1Pem)
      : sec1Pem; // already PKCS#8, use as-is
    const privateKey = await importPKCS8(pkcs8Pem, "ES256");

    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({
      sub: keyName,
      iss: "cdp",
      nbf: now,
      exp: now + 120,
      uri: "POST api.developer.coinbase.com/onramp/v1/token",
    })
      .setProtectedHeader({ alg: "ES256", kid: keyName })
      .sign(privateKey);

    const tokenRes = await fetch(
      "https://api.developer.coinbase.com/onramp/v1/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({
          destination_wallets: [{ address, blockchains: ["bitcoin"] }],
        }),
      }
    );

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error(`Coinbase token API error: ${tokenRes.status} ${text}`);
      return new Response("Failed to get session token", { status: 502 });
    }

    const { token } = (await tokenRes.json()) as { token: string };
    return Response.json({ sessionToken: token });
  } catch (err) {
    console.error("Worker error:", err instanceof Error ? err.message : err);
    return new Response("Internal error", { status: 500 });
  }
}

// ─── Recommended peers (curated, read-only) ─────────────────────────────

type RecommendedPeer = {
  id: string;
  label: string;
  pubkey: string;
  socket: string;
  description: string;
  recommended_channel_size_sat: number;
  advanced: boolean;
};

const RECOMMENDED_PEERS: RecommendedPeer[] = [
  {
    id: "acinq",
    label: "ACINQ",
    pubkey: "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
    socket: "3.33.236.230:9735",
    description:
      "Major Lightning hub and creators of Phoenix wallet. High liquidity, reliable routing.",
    recommended_channel_size_sat: 1_000_000,
    advanced: false,
  },
];

function handleRecommendedPeers(): Response {
  return Response.json(RECOMMENDED_PEERS, { headers: CORS_HEADERS });
}

// ─── Router ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // GET /recommended-peers — curated external peer list (read-only)
    if (request.method === "GET" && url.pathname === "/recommended-peers") {
      return handleRecommendedPeers();
    }

    // GET /treasury-info — treasury node connection info for member auto-connect
    if (request.method === "GET" && url.pathname === "/treasury-info") {
      const pubkey = env.TREASURY_PUBKEY || null;
      const socket = env.TREASURY_SOCKET || null;
      return Response.json({ pubkey, socket }, { headers: CORS_HEADERS });
    }

    // GET /prices/corn-history — historical monthly corn prices
    if (request.method === "GET" && url.pathname === "/prices/corn-history") {
      return handleCornHistory(env);
    }

    // GET /prices — commodity prices with KV caching
    if (request.method === "GET" && url.pathname === "/prices") {
      return handlePrices(env);
    }

    // POST / — Coinbase Onramp session token (existing behavior)
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
      return handleOnramp(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
