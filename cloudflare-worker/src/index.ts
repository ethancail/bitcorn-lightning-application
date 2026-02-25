// Bitcorn Lightning — Cloudflare Worker
//
// Endpoints:
//   POST /   — Coinbase Onramp session token (existing)
//   GET  /prices — Cached commodity prices (gold, corn, soybeans, wheat)
//
// Deploy:
//   cd cloudflare-worker
//   npm install
//   wrangler secret put CDP_KEY_NAME      # paste your key name
//   wrangler secret put CDP_PRIVATE_KEY   # paste your full PEM (one line with \n)
//   wrangler secret put USDA_NASS_KEY     # paste your USDA NASS API key
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
  USDA_NASS_KEY: string;
  PRICES_CACHE: KVNamespace;
}

// ─── CORS headers ────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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

async function fetchGoldPrice(): Promise<CommodityPrice> {
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=XAU&to=USD");
    if (!res.ok) return null;
    const data = (await res.json()) as { rates: { USD: number } };
    return {
      price: Math.round(data.rates.USD * 100) / 100,
      unit: "$/oz",
      label: "Gold",
      updated_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function fetchUsdaPrice(
  env: Env,
  commodity: string,
  label: string,
): Promise<CommodityPrice> {
  try {
    const key = env.USDA_NASS_KEY?.replace(/^["']|["']$/g, "");
    if (!key) return null;
    const params = new URLSearchParams({
      key,
      commodity_desc: commodity,
      statisticcat_desc: "PRICE RECEIVED",
      unit_desc: "$ / BU",
      reference_period_desc: "MARKETING YEAR",
      freq_desc: "ANNUAL",
      format: "JSON",
    });
    const res = await fetch(
      `https://quickstats.nass.usda.gov/api/api_GET/?${params.toString()}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { data: Array<{ Value: string; year: number }> };
    if (!data.data || data.data.length === 0) return null;
    // Sort by year descending to get most recent
    const sorted = data.data.sort((a, b) => b.year - a.year);
    const price = parseFloat(sorted[0].Value.replace(/,/g, ""));
    if (isNaN(price)) return null;
    return {
      price: Math.round(price * 100) / 100,
      unit: "$/bu",
      label,
      updated_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

// ─── /prices handler ─────────────────────────────────────────────────────

const KV_KEY = "commodity_prices";
const CACHE_TTL = 86400; // 24 hours

async function handlePrices(env: Env): Promise<Response> {
  // Check KV cache first
  const cached = await env.PRICES_CACHE.get(KV_KEY);
  if (cached) {
    return new Response(cached, {
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }

  // Fetch all four in parallel
  const [gold, corn, soybeans, wheat] = await Promise.all([
    fetchGoldPrice(),
    fetchUsdaPrice(env, "CORN", "Corn"),
    fetchUsdaPrice(env, "SOYBEANS", "Soybeans"),
    fetchUsdaPrice(env, "WHEAT", "Wheat"),
  ]);

  const result: CommodityPrices = { gold, corn, soybeans, wheat };
  const body = JSON.stringify(result);

  // Cache in KV with 24-hour TTL
  await env.PRICES_CACHE.put(KV_KEY, body, { expirationTtl: CACHE_TTL });

  return new Response(body, {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
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

// ─── Router ──────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
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
