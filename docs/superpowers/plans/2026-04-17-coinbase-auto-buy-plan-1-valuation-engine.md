# Coinbase Auto-Buy — Plan 1: Valuation Engine (Cloudflare Worker)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Worker side of Coinbase Auto-Buy — a daily cron that fetches 12 weighted BTC valuation inputs from paid and free upstreams, computes a composite Z-score, persists it to KV, and exposes three new HTTP endpoints (`/valuation/current`, `/valuation/history`, `/valuation/inputs`) to be consumed by node installs.

**Architecture:** Refactor the monolithic `cloudflare-worker/src/index.ts` into a `handlers/` + `valuation/` tree with a clean `InputAdapter` interface. Each of the 12 inputs is one adapter file that knows its upstream API, its daily-value parse, and nothing else. An orchestrator combines per-adapter readings into a composite Z-score using a pure `composite()` function. A `scheduled()` handler runs the orchestrator on cron. Storage is the existing `PRICES_CACHE` KV namespace.

**Tech Stack:** Cloudflare Workers (TypeScript, ESM), `jose` (already used for CDP JWT), `vitest` + `@cloudflare/vitest-pool-workers` (added in Task 1). Upstreams: Glassnode (MVRV, Puell, SOPR, Reserve Risk, NVT, Hash Ribbons, Difficulty Ribbon, HODL Waves), LookIntoBitcoin (200W MA, PI Cycle), PlanB (Stock-to-Flow), CryptoQuant (Miner Outflows).

---

## Context for the engineer

- You will be working in `cloudflare-worker/` — a separate npm package from `app/api/` and `app/web/`. Its existing code is `cloudflare-worker/src/index.ts` (one ~550-line file). Read it once end-to-end before starting.
- The design spec this plan implements: `docs/superpowers/specs/2026-04-17-coinbase-auto-buy-design.md` (§3 architecture, §4 valuation engine).
- The repo-wide CLAUDE.md applies. Relevant rules: commit frequently, branch is `feature/coinbase-auto-buy`, do not push to `main`, **never skip hooks**.
- The repo has no automated test suite for the API or Web package. This plan introduces Vitest for the Worker package only. The choice is justified by: (a) financial-math correctness is load-bearing; (b) 12 upstream integrations are impossible to verify manually; (c) the Worker package is self-contained so adding a test runner doesn't ripple into the rest of the monorepo.
- When we say "commit," run `git commit` locally. Do **not** push until the whole plan is done and the user approves.
- **Your first step before Task 1**: `cd cloudflare-worker && npm install && npx wrangler --version` — confirm Wrangler works.

## Secrets expected during development

You will not have real API keys during local testing; all tests mock `fetch`. Before the final deploy (Task 27) the user will add real secrets via `wrangler secret put`. The env var names are documented in Task 26 (`wrangler.toml` update) so you don't need them earlier.

## File structure after this plan

```
cloudflare-worker/
├── package.json                        (modified: add vitest + @cloudflare/vitest-pool-workers)
├── wrangler.toml                       (modified: add [triggers] cron + document new secrets)
├── vitest.config.ts                    (new)
├── tsconfig.json                       (unchanged)
├── src/
│   ├── index.ts                        (refactored: thin router + scheduled() handler)
│   ├── lib/
│   │   ├── cors.ts                     (new: CORS_HEADERS; moved from index.ts)
│   │   ├── types.ts                    (new: Env, CommodityPrice etc.; moved from index.ts)
│   │   └── sec1ToPkcs8.ts              (new: moved from index.ts)
│   ├── handlers/
│   │   ├── onramp.ts                   (new: handleOnramp; moved from index.ts)
│   │   ├── prices.ts                   (new: handlePrices + handleCornHistory; moved)
│   │   ├── recommendedPeers.ts         (new: moved)
│   │   ├── treasuryInfo.ts             (new: moved)
│   │   └── valuation.ts                (new: /valuation/current, /history, /inputs)
│   └── valuation/
│       ├── zones.ts                    (new: pure — Z → zone + multiplier)
│       ├── zscore.ts                   (new: pure — per-value Z-score from series)
│       ├── composite.ts                (new: pure — weighted sum)
│       ├── persist.ts                  (new: KV read/write)
│       ├── engine.ts                   (new: orchestrator)
│       ├── cron.ts                     (new: scheduled() handler)
│       └── inputs/
│           ├── types.ts                (new: InputAdapter contract)
│           ├── stockToFlow.ts          (new: PlanB API)
│           ├── ma200w.ts               (new: LookIntoBitcoin)
│           ├── piCycle.ts              (new: LookIntoBitcoin)
│           ├── nvt.ts                  (new: Glassnode)
│           ├── hashRibbons.ts          (new: Glassnode)
│           ├── difficultyRibbon.ts     (new: Glassnode)
│           ├── puell.ts                (new: Glassnode)
│           ├── mvrv.ts                 (new: Glassnode)
│           ├── sopr.ts                 (new: Glassnode)
│           ├── reserveRisk.ts          (new: Glassnode)
│           ├── hodlWaves.ts            (new: Glassnode)
│           └── minerOutflows.ts        (new: CryptoQuant)
├── tests/
│   ├── smoke.test.ts                   (new: added in Task 1)
│   ├── valuation/
│   │   ├── zones.test.ts               (new, Task 4)
│   │   ├── zscore.test.ts              (new, Task 5)
│   │   ├── composite.test.ts           (new, Task 6)
│   │   ├── persist.test.ts             (new, Task 18)
│   │   └── engine.test.ts              (new, Task 19)
│   └── inputs/
│       └── (one test file per adapter, Tasks 7-17)
└── scripts/
    └── backfill.ts                     (new: Task 25)
```

---

## Task 1: Add Vitest to the Worker package

**Files:**
- Modify: `cloudflare-worker/package.json`
- Create: `cloudflare-worker/vitest.config.ts`
- Create: `cloudflare-worker/tests/smoke.test.ts`

- [ ] **Step 1: Write the failing smoke test**

Create `cloudflare-worker/tests/smoke.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

describe("smoke", () => {
  it("runs vitest", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (no test runner yet)**

Run: `cd cloudflare-worker && npx vitest run`

Expected: `npx: command 'vitest' not found` or equivalent — vitest is not installed yet.

- [ ] **Step 3: Install vitest and worker pool, add test script**

Run:

```bash
cd cloudflare-worker
npm install --save-dev vitest@^1.6.0 @cloudflare/vitest-pool-workers@^0.5.0
```

Edit `cloudflare-worker/package.json` — add a `test` script under `"scripts"`:

```json
{
  "name": "bitcorn-onramp-worker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "jose": "^5.0.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.0.0",
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "typescript": "^5.0.0",
    "vitest": "^1.6.0",
    "wrangler": "^3.0.0"
  }
}
```

Create `cloudflare-worker/vitest.config.ts`:

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
      },
    },
  },
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`

Expected: `1 test passed` (the smoke test).

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/package.json cloudflare-worker/package-lock.json cloudflare-worker/vitest.config.ts cloudflare-worker/tests/smoke.test.ts
git commit -m "chore(worker): add vitest test runner"
```

---

## Task 2: Extract shared types and CORS constants from index.ts

**Files:**
- Create: `cloudflare-worker/src/lib/cors.ts`
- Create: `cloudflare-worker/src/lib/types.ts`
- Modify: `cloudflare-worker/src/index.ts`
- Create: `cloudflare-worker/tests/lib/cors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cloudflare-worker/tests/lib/cors.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CORS_HEADERS } from "../../src/lib/cors";

describe("CORS_HEADERS", () => {
  it("exposes the expected allow headers", () => {
    expect(CORS_HEADERS["Access-Control-Allow-Origin"]).toBe("*");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("GET");
    expect(CORS_HEADERS["Access-Control-Allow-Methods"]).toContain("POST");
    expect(CORS_HEADERS["Access-Control-Allow-Headers"]).toBe("Content-Type");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`

Expected: FAIL with module-not-found error on `../../src/lib/cors`.

- [ ] **Step 3: Create the files and update imports**

Create `cloudflare-worker/src/lib/cors.ts`:

```typescript
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "X-Price-Source",
} as const;
```

Create `cloudflare-worker/src/lib/types.ts`:

```typescript
export interface Env {
  CDP_KEY_NAME: string;
  CDP_PRIVATE_KEY: string;
  USDA_NASS_KEY: string;
  PRICES_CACHE: KVNamespace;
  TREASURY_PUBKEY?: string;
  TREASURY_SOCKET?: string;
  // Valuation upstreams (added in later tasks; optional here so tests can stub)
  GLASSNODE_API_KEY?: string;
  CRYPTOQUANT_API_KEY?: string;
  LOOKINTOBITCOIN_API_KEY?: string;
  PLANB_API_KEY?: string;
}

export type CommodityPrice = {
  price: number;
  unit: string;
  label: string;
  updated_at: string;
} | null;

export type CommodityPrices = {
  gold: CommodityPrice;
  corn: CommodityPrice;
  soybeans: CommodityPrice;
  wheat: CommodityPrice;
};
```

Edit `cloudflare-worker/src/index.ts` — replace the inline `CORS_HEADERS`, `Env`, `CommodityPrice`, `CommodityPrices` declarations with imports from `./lib/cors` and `./lib/types`. Leave the rest of the file untouched for now.

Find and **delete** these blocks from `index.ts`:

```typescript
interface Env {
  CDP_KEY_NAME: string;
  CDP_PRIVATE_KEY: string;
  USDA_NASS_KEY: string;
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
```

And add at the top of `index.ts`, just after the `jose` import:

```typescript
import { CORS_HEADERS } from "./lib/cors";
import type { Env, CommodityPrice, CommodityPrices } from "./lib/types";
```

- [ ] **Step 4: Run tests to verify they pass and type-check clean**

Run:

```bash
npm test
npx tsc --noEmit
```

Expected: both commands succeed. Smoke test still passes; cors test passes; no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/lib/ cloudflare-worker/src/index.ts cloudflare-worker/tests/lib/
git commit -m "refactor(worker): extract CORS and Env types into src/lib"
```

---

## Task 3: Move existing handlers into `src/handlers/`

**Files:**
- Create: `cloudflare-worker/src/handlers/onramp.ts`
- Create: `cloudflare-worker/src/handlers/prices.ts`
- Create: `cloudflare-worker/src/handlers/recommendedPeers.ts`
- Create: `cloudflare-worker/src/handlers/treasuryInfo.ts`
- Create: `cloudflare-worker/src/lib/sec1ToPkcs8.ts`
- Modify: `cloudflare-worker/src/index.ts`

This task is a pure move — no behaviour change. Tests for the handlers themselves come later; for now we just verify the move doesn't break anything by running the smoke + CORS tests.

- [ ] **Step 1: Extract `sec1ToPkcs8Pem` into its own file**

Create `cloudflare-worker/src/lib/sec1ToPkcs8.ts` with the contents currently at the top of `index.ts` (the entire `sec1ToPkcs8Pem` function). Export it as a named export:

```typescript
// Cloudflare Workers use the Web Crypto API which only accepts PKCS#8 format.
// CDP keys come in SEC1 format. This function wraps the SEC1 DER in a PKCS#8
// AlgorithmIdentifier envelope for P-256 (secp256r1).
export function sec1ToPkcs8Pem(sec1Pem: string): string {
  const b64 = sec1Pem
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("-----"))
    .join("")
    .replace(/\s/g, "");

  const invalidChars = [...b64].filter((c) => !/[A-Za-z0-9+/=]/.test(c));
  if (invalidChars.length > 0) {
    console.error("Invalid base64 char codes:", invalidChars.map((c) => c.charCodeAt(0)));
  }

  const b64clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  const sec1Der = Uint8Array.from(atob(b64clean), (c) => c.charCodeAt(0));

  const derLen = (n: number): number[] =>
    n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, (n >> 8) & 0xff, n & 0xff];

  const algId = [
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
  ];

  const octet = [0x04, ...derLen(sec1Der.length), ...sec1Der];
  const inner = [0x02, 0x01, 0x00, ...algId, ...octet];
  const pkcs8Der = new Uint8Array([0x30, ...derLen(inner.length), ...inner]);

  const b64out = btoa(String.fromCharCode(...pkcs8Der));
  const lines = (b64out.match(/.{1,64}/g) ?? []).join("\n");
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}
```

Delete the function from `index.ts`.

- [ ] **Step 2: Move the onramp handler**

Create `cloudflare-worker/src/handlers/onramp.ts`:

```typescript
import { SignJWT, importPKCS8 } from "jose";
import { sec1ToPkcs8Pem } from "../lib/sec1ToPkcs8";
import type { Env } from "../lib/types";

export async function handleOnramp(request: Request, env: Env): Promise<Response> {
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
      .replace(/^["']|["']$/g, "")
      .replace(/\\n/g, "\n");
    const pkcs8Pem = sec1Pem.includes("BEGIN EC PRIVATE KEY")
      ? sec1ToPkcs8Pem(sec1Pem)
      : sec1Pem;
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
```

Delete `handleOnramp` from `index.ts` and add the import at the top:

```typescript
import { handleOnramp } from "./handlers/onramp";
```

- [ ] **Step 3: Move the remaining handlers the same way**

Create `cloudflare-worker/src/handlers/prices.ts` by moving the entire `handlePrices` function, the `handleCornHistory` function, and all the TradingView / corn-history types and constants they depend on (`TV_SCANNER_URL`, `TV_SYMBOLS`, `TV_COLUMNS`, `COL_CLOSE`, `TVSymbolConfig`, `TVScanRow`, `TVScanResponse`, `fetchFuturesPrices`, `countPrices`, `CORN_HISTORY_KV_KEY`, `CORN_HISTORY_CACHE_TTL`, `CornHistoryEntry`, `KV_KEY`, `KV_FALLBACK_KEY`, `PRICES_CACHE_TTL`, `PRICES_FALLBACK_TTL`) from `index.ts` into that file. Import `CORS_HEADERS` from `../lib/cors` and `Env`, `CommodityPrice`, `CommodityPrices` from `../lib/types`. Export `handlePrices` and `handleCornHistory` as named exports.

Create `cloudflare-worker/src/handlers/recommendedPeers.ts`:

```typescript
import { CORS_HEADERS } from "../lib/cors";

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

export function handleRecommendedPeers(): Response {
  return Response.json(RECOMMENDED_PEERS, { headers: CORS_HEADERS });
}
```

Create `cloudflare-worker/src/handlers/treasuryInfo.ts`:

```typescript
import { CORS_HEADERS } from "../lib/cors";
import type { Env } from "../lib/types";

export function handleTreasuryInfo(env: Env): Response {
  const pubkey = env.TREASURY_PUBKEY || null;
  const socket = env.TREASURY_SOCKET || null;
  return Response.json({ pubkey, socket }, { headers: CORS_HEADERS });
}
```

Update `index.ts` to import all four handlers and delete the inline code they replaced. The `fetch` handler's body should now be a thin router:

```typescript
import { handleOnramp } from "./handlers/onramp";
import { handlePrices, handleCornHistory } from "./handlers/prices";
import { handleRecommendedPeers } from "./handlers/recommendedPeers";
import { handleTreasuryInfo } from "./handlers/treasuryInfo";
import { CORS_HEADERS } from "./lib/cors";
import type { Env } from "./lib/types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/recommended-peers") {
      return handleRecommendedPeers();
    }
    if (request.method === "GET" && url.pathname === "/treasury-info") {
      return handleTreasuryInfo(env);
    }
    if (request.method === "GET" && url.pathname === "/prices/corn-history") {
      return handleCornHistory(env);
    }
    if (request.method === "GET" && url.pathname === "/prices") {
      return handlePrices(env);
    }
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
      return handleOnramp(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
};
```

- [ ] **Step 4: Run tests and type-check**

Run:

```bash
npm test
npx tsc --noEmit
```

Expected: all tests pass; `tsc` succeeds.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/
git commit -m "refactor(worker): extract handlers into src/handlers tree"
```

---

## Task 4: Zone mapping — `src/valuation/zones.ts`

Pure function: given a composite Z-score, return the zone name and the buy multiplier. Boundaries are locked by the spec.

**Files:**
- Create: `cloudflare-worker/src/valuation/zones.ts`
- Create: `cloudflare-worker/tests/valuation/zones.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/valuation/zones.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { classifyZone, Zone } from "../../src/valuation/zones";

describe("classifyZone", () => {
  const cases: Array<[number, Zone, number]> = [
    [-3.0,  "extreme_buy",   3.0],
    [-2.01, "extreme_buy",   3.0],
    [-2.0,  "undervalued",   2.0],
    [-1.5,  "undervalued",   2.0],
    [-1.01, "undervalued",   2.0],
    [-1.0,  "fair_value",    1.0],
    [ 0.0,  "fair_value",    1.0],
    [ 0.99, "fair_value",    1.0],
    [ 1.0,  "elevated",      0.5],
    [ 1.49, "elevated",      0.5],
    [ 1.5,  "overvalued",    0.25],
    [ 2.49, "overvalued",    0.25],
    [ 2.5,  "extreme_sell",  0.0],
    [ 5.72, "extreme_sell",  0.0],
  ];

  it.each(cases)("Z=%f classifies to %s with multiplier %f", (z, expectedZone, expectedMult) => {
    const result = classifyZone(z);
    expect(result.zone).toBe(expectedZone);
    expect(result.multiplier).toBeCloseTo(expectedMult, 10);
  });

  it("returns extreme_sell for NaN (safe default)", () => {
    const result = classifyZone(Number.NaN);
    expect(result.zone).toBe("extreme_sell");
    expect(result.multiplier).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- zones`

Expected: FAIL — `classifyZone` is not defined.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/zones.ts`:

```typescript
export type Zone =
  | "extreme_buy"
  | "undervalued"
  | "fair_value"
  | "elevated"
  | "overvalued"
  | "extreme_sell";

export interface ZoneClassification {
  zone: Zone;
  multiplier: number;
}

// Boundaries lock the spec's §4.2 zone mapping.
// On boundaries (exact values): lower-side of the next zone wins per spec table:
//   Extreme Buy:   Z < -2
//   Undervalued:  -2 ≤ Z < -1
//   Fair Value:   -1 ≤ Z < 1
//   Elevated:      1 ≤ Z < 1.5
//   Overvalued:   1.5 ≤ Z < 2.5
//   Extreme Sell:  Z ≥ 2.5
export function classifyZone(z: number): ZoneClassification {
  if (!Number.isFinite(z)) return { zone: "extreme_sell", multiplier: 0 };
  if (z < -2.0)  return { zone: "extreme_buy",  multiplier: 3.0 };
  if (z < -1.0)  return { zone: "undervalued",  multiplier: 2.0 };
  if (z <  1.0)  return { zone: "fair_value",   multiplier: 1.0 };
  if (z <  1.5)  return { zone: "elevated",     multiplier: 0.5 };
  if (z <  2.5)  return { zone: "overvalued",   multiplier: 0.25 };
  return { zone: "extreme_sell", multiplier: 0 };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- zones`

Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/zones.ts cloudflare-worker/tests/valuation/zones.test.ts
git commit -m "feat(worker/valuation): add zone classifier (pure)"
```

---

## Task 5: Z-score math — `src/valuation/zscore.ts`

Pure function: given a numeric array, return the mean, stdev, and a function to map a new value to its Z-score. Used both on history (compute historical series) and on live values (map today's reading).

**Files:**
- Create: `cloudflare-worker/src/valuation/zscore.ts`
- Create: `cloudflare-worker/tests/valuation/zscore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/valuation/zscore.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { computeStats, toZScore, zScoreSeries } from "../../src/valuation/zscore";

describe("computeStats", () => {
  it("computes mean and sample stdev for a known series", () => {
    // Data: [2, 4, 4, 4, 5, 5, 7, 9]  → mean=5, sample stdev=2 (Bessel-corrected)
    const stats = computeStats([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(stats.mean).toBeCloseTo(5.0, 10);
    expect(stats.stdev).toBeCloseTo(2.138089935, 6);
  });

  it("returns stdev=0 for a constant series", () => {
    const stats = computeStats([3, 3, 3, 3]);
    expect(stats.mean).toBeCloseTo(3.0, 10);
    expect(stats.stdev).toBe(0);
  });

  it("throws on an empty series", () => {
    expect(() => computeStats([])).toThrow(/empty/);
  });
});

describe("toZScore", () => {
  it("returns (value - mean) / stdev", () => {
    const z = toZScore(7, { mean: 5, stdev: 2 });
    expect(z).toBeCloseTo(1.0, 10);
  });

  it("returns 0 when stdev is 0 (constant series)", () => {
    const z = toZScore(7, { mean: 5, stdev: 0 });
    expect(z).toBe(0);
  });
});

describe("zScoreSeries", () => {
  it("maps each value to its Z-score against the whole-series stats", () => {
    const result = zScoreSeries([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(result.length).toBe(8);
    expect(result[0]).toBeCloseTo((2 - 5) / 2.138089935, 5);
    expect(result[4]).toBeCloseTo((5 - 5) / 2.138089935, 5);
    expect(result[7]).toBeCloseTo((9 - 5) / 2.138089935, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- zscore`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/zscore.ts`:

```typescript
export interface Stats {
  mean: number;
  stdev: number; // sample (Bessel-corrected) standard deviation
}

export function computeStats(values: number[]): Stats {
  if (values.length === 0) {
    throw new Error("computeStats: empty input");
  }
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  if (values.length < 2) {
    return { mean, stdev: 0 };
  }
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, stdev: Math.sqrt(variance) };
}

export function toZScore(value: number, stats: Stats): number {
  if (stats.stdev === 0) return 0;
  return (value - stats.mean) / stats.stdev;
}

// For a whole-series Z-score pass (used for display history — accepts the
// look-ahead bias per spec §4.3).
export function zScoreSeries(values: number[]): number[] {
  const stats = computeStats(values);
  return values.map((v) => toZScore(v, stats));
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- zscore`

Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/zscore.ts cloudflare-worker/tests/valuation/zscore.test.ts
git commit -m "feat(worker/valuation): add Z-score math helpers (pure)"
```

---

## Task 6: Composite aggregator — `src/valuation/composite.ts`

Pure function: take a map of per-input Z-scores and a map of weights; return the weighted sum with weights renormalised to 1.0.

**Files:**
- Create: `cloudflare-worker/src/valuation/composite.ts`
- Create: `cloudflare-worker/tests/valuation/composite.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/valuation/composite.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { composite, INPUT_WEIGHTS } from "../../src/valuation/composite";

describe("INPUT_WEIGHTS", () => {
  it("defines exactly 12 inputs", () => {
    expect(Object.keys(INPUT_WEIGHTS).length).toBe(12);
  });

  it("all weights are positive and less than 1", () => {
    for (const [key, w] of Object.entries(INPUT_WEIGHTS)) {
      expect(w, `weight for ${key}`).toBeGreaterThan(0);
      expect(w, `weight for ${key}`).toBeLessThan(1);
    }
  });

  it("weights sum close to 1.0 (mockup rounding tolerance)", () => {
    const sum = Object.values(INPUT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(0.99);
    expect(sum).toBeLessThan(1.02);
  });
});

describe("composite", () => {
  it("computes a weighted sum and renormalises weights to 1.0", () => {
    // Three inputs, Z=1 each, weights [0.2, 0.3, 0.5] → sum = 1.0 naturally
    const z = composite({ a: 1, b: 1, c: 1 }, { a: 0.2, b: 0.3, c: 0.5 });
    expect(z).toBeCloseTo(1.0, 10);
  });

  it("renormalises when weights do not sum to 1.0", () => {
    // Weights [0.2, 0.3] sum to 0.5 → renormalised to [0.4, 0.6]
    // Z-scores [1, 2] → 0.4*1 + 0.6*2 = 1.6
    const z = composite({ a: 1, b: 2 }, { a: 0.2, b: 0.3 });
    expect(z).toBeCloseTo(1.6, 10);
  });

  it("ignores inputs missing from the readings map", () => {
    // c is in weights but not readings — we can't use it, so renormalise over {a,b}
    const z = composite({ a: 1, b: 2 }, { a: 0.2, b: 0.3, c: 0.5 });
    expect(z).toBeCloseTo(1.6, 10);
  });

  it("throws if no inputs overlap", () => {
    expect(() => composite({ x: 1 }, { a: 0.5, b: 0.5 })).toThrow(/no inputs/);
  });

  it("skips NaN/Infinity readings", () => {
    const z = composite({ a: 1, b: Number.NaN, c: 2 }, { a: 0.2, b: 0.3, c: 0.5 });
    // Only a and c are usable; renormalised weights: a=0.2/0.7, c=0.5/0.7
    const expected = (1 * 0.2 + 2 * 0.5) / (0.2 + 0.5);
    expect(z).toBeCloseTo(expected, 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- composite`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/composite.ts`:

```typescript
// Spec §4.1 weights — exactly as specified in the mockup (sum ≈ 1.01 due to rounding;
// composite() renormalises on every call).
export const INPUT_WEIGHTS: Record<string, number> = {
  mvrv:               0.18,
  puell:              0.10,
  sopr:               0.08,
  reserve_risk:       0.07,
  stock_to_flow:      0.12,
  ma_200w:            0.10,
  pi_cycle:           0.07,
  nvt:                0.08,
  hash_ribbons:       0.06,
  difficulty_ribbon:  0.05,
  miner_outflows:     0.04,
  hodl_waves:         0.06,
};

export function composite(
  readings: Record<string, number>,
  weights: Record<string, number> = INPUT_WEIGHTS,
): number {
  let weightSum = 0;
  let weightedZSum = 0;

  for (const [key, w] of Object.entries(weights)) {
    const z = readings[key];
    if (z === undefined || !Number.isFinite(z)) continue;
    weightSum += w;
    weightedZSum += w * z;
  }

  if (weightSum === 0) {
    throw new Error("composite: no inputs usable (weightSum=0)");
  }

  return weightedZSum / weightSum;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- composite`

Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/composite.ts cloudflare-worker/tests/valuation/composite.test.ts
git commit -m "feat(worker/valuation): add composite Z-score aggregator (pure)"
```

---

## Task 7: InputAdapter contract + first adapter (`stockToFlow`)

Sets the pattern every subsequent adapter follows. PlanB's Stock-to-Flow API is an unofficial community mirror; we document that and build in a graceful fallback (null reading, not a thrown error).

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/types.ts`
- Create: `cloudflare-worker/src/valuation/inputs/stockToFlow.ts`
- Create: `cloudflare-worker/tests/inputs/stockToFlow.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/inputs/stockToFlow.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stockToFlow } from "../../src/valuation/inputs/stockToFlow";
import type { Env } from "../../src/lib/types";

const env = { PLANB_API_KEY: "test-key" } as unknown as Env;

describe("stockToFlow adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has a key matching the composite INPUT_WEIGHTS key", () => {
    expect(stockToFlow.key).toBe("stock_to_flow");
  });

  it("fetchLatest parses the PlanB response and returns { timestamp, value }", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ t: 1744848000, s2f_deviation: -0.12 }] }), { status: 200 })
    );

    const reading = await stockToFlow.fetchLatest(env);

    expect(reading).not.toBeNull();
    expect(reading!.timestamp).toBe(1744848000);
    expect(reading!.value).toBeCloseTo(-0.12, 10);
  });

  it("fetchLatest returns null on upstream 5xx (does not throw)", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 503 }));
    const reading = await stockToFlow.fetchLatest(env);
    expect(reading).toBeNull();
  });

  it("fetchLatest returns null on malformed response body", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("not json", { status: 200 }));
    const reading = await stockToFlow.fetchLatest(env);
    expect(reading).toBeNull();
  });

  it("fetchHistory returns an array of readings sorted ascending by timestamp", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          { t: 1744848000, s2f_deviation: -0.12 },
          { t: 1744761600, s2f_deviation: -0.10 },
        ],
      }), { status: 200 })
    );

    const readings = await stockToFlow.fetchHistory(env);
    expect(readings.length).toBe(2);
    expect(readings[0].timestamp).toBeLessThan(readings[1].timestamp);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- stockToFlow`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/types.ts`:

```typescript
import type { Env } from "../../lib/types";

export type InputCategory = "on-chain" | "market" | "mining" | "sentiment";

export interface InputReading {
  // Unix seconds at UTC midnight of the day the value belongs to
  timestamp: number;
  value: number;
}

export interface InputAdapter {
  // Must match a key in INPUT_WEIGHTS in src/valuation/composite.ts
  key: string;
  label: string;
  category: InputCategory;
  source: string; // display name of the upstream, e.g. "Glassnode"
  // Latest single reading; returns null on upstream failure (caller handles fallback)
  fetchLatest(env: Env): Promise<InputReading | null>;
  // Full history from the earliest available date up to today; ascending by timestamp
  fetchHistory(env: Env): Promise<InputReading[]>;
}
```

Create `cloudflare-worker/src/valuation/inputs/stockToFlow.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests**

Run: `npm test -- stockToFlow`

Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/ cloudflare-worker/tests/inputs/stockToFlow.test.ts
git commit -m "feat(worker/valuation): add InputAdapter contract + stockToFlow adapter"
```

---

## Task 8: 200-Week MA Heatmap adapter — `src/valuation/inputs/ma200w.ts`

LookIntoBitcoin's published metric: the percentage deviation of price from the 200-week MA. Upstream is JSON served from their site (community-mirrored — document the fragility).

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/ma200w.ts`
- Create: `cloudflare-worker/tests/inputs/ma200w.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/inputs/ma200w.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ma200w } from "../../src/valuation/inputs/ma200w";
import type { Env } from "../../src/lib/types";

const env = { LOOKINTOBITCOIN_API_KEY: "test-key" } as unknown as Env;

describe("ma200w adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'ma_200w'", () => {
    expect(ma200w.key).toBe("ma_200w");
  });

  it("parses upstream response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          { timestamp: 1744761600, pct_deviation: 1.45 },
          { timestamp: 1744848000, pct_deviation: 1.50 },
        ],
      }), { status: 200 })
    );
    const readings = await ma200w.fetchHistory(env);
    expect(readings.length).toBe(2);
    expect(readings[0].value).toBeCloseTo(1.45, 10);
  });

  it("returns null on upstream failure", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await ma200w.fetchLatest(env)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ma200w`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/ma200w.ts`:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";

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
```

- [ ] **Step 4: Run tests**

Run: `npm test -- ma200w`

Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/ma200w.ts cloudflare-worker/tests/inputs/ma200w.test.ts
git commit -m "feat(worker/valuation): add 200-Week MA Heatmap adapter"
```

---

## Task 9: PI Cycle Top Indicator adapter — `src/valuation/inputs/piCycle.ts`

LookIntoBitcoin's PI Cycle Top: distance between `111d-SMA × 2` and `350d-SMA` as a ratio. Positive = 111d×2 > 350d (hotter); negative = below.

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/piCycle.ts`
- Create: `cloudflare-worker/tests/inputs/piCycle.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/inputs/piCycle.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piCycle } from "../../src/valuation/inputs/piCycle";
import type { Env } from "../../src/lib/types";

const env = { LOOKINTOBITCOIN_API_KEY: "test-key" } as unknown as Env;

describe("piCycle adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'pi_cycle'", () => {
    expect(piCycle.key).toBe("pi_cycle");
  });

  it("parses upstream response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        data: [
          { timestamp: 1744761600, ratio: 0.8 },
          { timestamp: 1744848000, ratio: 0.85 },
        ],
      }), { status: 200 })
    );
    const readings = await piCycle.fetchHistory(env);
    expect(readings.length).toBe(2);
    expect(readings[1].value).toBeCloseTo(0.85, 10);
  });

  it("returns null on upstream failure", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await piCycle.fetchLatest(env)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- piCycle`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/piCycle.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests**

Run: `npm test -- piCycle`

Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/piCycle.ts cloudflare-worker/tests/inputs/piCycle.test.ts
git commit -m "feat(worker/valuation): add PI Cycle Top adapter"
```

---

## Task 10: Glassnode shared client helper + MVRV Z-Score adapter

The 8 Glassnode adapters all share auth + request/response shape. Extract a `fetchGlassnodeMetric()` helper used by each of them.

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/glassnode.ts`
- Create: `cloudflare-worker/src/valuation/inputs/mvrv.ts`
- Create: `cloudflare-worker/tests/inputs/glassnode.test.ts`
- Create: `cloudflare-worker/tests/inputs/mvrv.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/inputs/glassnode.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchGlassnodeMetric } from "../../src/valuation/inputs/glassnode";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("fetchGlassnodeMetric", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("builds an URL using the given metric path and passes the API key header", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 2.1 }]), { status: 200 })
    );
    const readings = await fetchGlassnodeMetric(env, "market/mvrv_z_score");
    expect((globalThis.fetch as any).mock.calls[0][0]).toContain("/v1/metrics/market/mvrv_z_score");
    expect((globalThis.fetch as any).mock.calls[0][1].headers["X-Api-Key"]).toBe("glass-key");
    expect(readings.length).toBe(1);
    expect(readings[0].timestamp).toBe(1744848000);
    expect(readings[0].value).toBeCloseTo(2.1, 10);
  });

  it("returns [] on missing API key (does not throw)", async () => {
    const readings = await fetchGlassnodeMetric({} as Env, "market/mvrv_z_score");
    expect(readings).toEqual([]);
    expect((globalThis.fetch as any)).not.toHaveBeenCalled?.();
  });

  it("returns [] on HTTP error", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 429 }));
    const readings = await fetchGlassnodeMetric(env, "market/mvrv_z_score");
    expect(readings).toEqual([]);
  });
});
```

Create `cloudflare-worker/tests/inputs/mvrv.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mvrv } from "../../src/valuation/inputs/mvrv";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("mvrv adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'mvrv'", () => {
    expect(mvrv.key).toBe("mvrv");
  });

  it("fetchLatest returns the last point from the Glassnode response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744761600, v: 1.8 }, { t: 1744848000, v: 2.1 }]), { status: 200 })
    );
    const reading = await mvrv.fetchLatest(env);
    expect(reading).not.toBeNull();
    expect(reading!.value).toBeCloseTo(2.1, 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- glassnode mvrv`

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the helper and the first Glassnode adapter**

Create `cloudflare-worker/src/valuation/inputs/glassnode.ts`:

```typescript
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
    console.error(`[glassnode] ${metricPath}: GLASSNODE_API_KEY not set`);
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
```

Create `cloudflare-worker/src/valuation/inputs/mvrv.ts`:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

const METRIC_PATH = "market/mvrv_z_score";

export const mvrv: InputAdapter = {
  key: "mvrv",
  label: "MVRV Z-Score",
  category: "on-chain",
  source: "Glassnode",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchGlassnodeMetric(env, METRIC_PATH);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return fetchGlassnodeMetric(env, METRIC_PATH);
  },
};
```

- [ ] **Step 4: Run tests**

Run: `npm test -- glassnode mvrv`

Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/glassnode.ts cloudflare-worker/src/valuation/inputs/mvrv.ts cloudflare-worker/tests/inputs/glassnode.test.ts cloudflare-worker/tests/inputs/mvrv.test.ts
git commit -m "feat(worker/valuation): add Glassnode client + MVRV adapter"
```

---

## Task 11: Puell Multiple adapter — `src/valuation/inputs/puell.ts`

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/puell.ts`
- Create: `cloudflare-worker/tests/inputs/puell.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cloudflare-worker/tests/inputs/puell.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { puell } from "../../src/valuation/inputs/puell";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("puell adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'puell'", () => {
    expect(puell.key).toBe("puell");
  });

  it("fetchLatest parses Glassnode response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 0.42 }]), { status: 200 })
    );
    const reading = await puell.fetchLatest(env);
    expect(reading).not.toBeNull();
    expect(reading!.value).toBeCloseTo(0.42, 10);
  });

  it("calls the correct Glassnode metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 0.42 }]), { status: 200 })
    );
    await puell.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/puell_multiple");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- puell`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/puell.ts`:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

const METRIC_PATH = "indicators/puell_multiple";

export const puell: InputAdapter = {
  key: "puell",
  label: "Puell Multiple",
  category: "on-chain",
  source: "Glassnode",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchGlassnodeMetric(env, METRIC_PATH);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return fetchGlassnodeMetric(env, METRIC_PATH);
  },
};
```

- [ ] **Step 4: Run tests**

Run: `npm test -- puell`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/puell.ts cloudflare-worker/tests/inputs/puell.test.ts
git commit -m "feat(worker/valuation): add Puell Multiple adapter"
```

---

## Task 12: SOPR (30d MA) adapter — `src/valuation/inputs/sopr.ts`

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/sopr.ts`
- Create: `cloudflare-worker/tests/inputs/sopr.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cloudflare-worker/tests/inputs/sopr.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sopr } from "../../src/valuation/inputs/sopr";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("sopr adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'sopr'", () => {
    expect(sopr.key).toBe("sopr");
  });

  it("calls the adjusted-SOPR 30d-MA metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 1.008 }]), { status: 200 })
    );
    await sopr.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/sopr_adjusted");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- sopr`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/sopr.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests**

Run: `npm test -- sopr`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/sopr.ts cloudflare-worker/tests/inputs/sopr.test.ts
git commit -m "feat(worker/valuation): add SOPR 30d MA adapter"
```

---

## Task 13: Reserve Risk adapter — `src/valuation/inputs/reserveRisk.ts`

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/reserveRisk.ts`
- Create: `cloudflare-worker/tests/inputs/reserveRisk.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cloudflare-worker/tests/inputs/reserveRisk.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reserveRisk } from "../../src/valuation/inputs/reserveRisk";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("reserveRisk adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'reserve_risk'", () => {
    expect(reserveRisk.key).toBe("reserve_risk");
  });

  it("calls the reserve-risk metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 0.003 }]), { status: 200 })
    );
    await reserveRisk.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/reserve_risk");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- reserveRisk`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/reserveRisk.ts`:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

const METRIC_PATH = "indicators/reserve_risk";

export const reserveRisk: InputAdapter = {
  key: "reserve_risk",
  label: "Reserve Risk",
  category: "on-chain",
  source: "Glassnode",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchGlassnodeMetric(env, METRIC_PATH);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return fetchGlassnodeMetric(env, METRIC_PATH);
  },
};
```

- [ ] **Step 4: Run tests**

Run: `npm test -- reserveRisk`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/reserveRisk.ts cloudflare-worker/tests/inputs/reserveRisk.test.ts
git commit -m "feat(worker/valuation): add Reserve Risk adapter"
```

---

## Task 14: NVT Signal adapter — `src/valuation/inputs/nvt.ts`

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/nvt.ts`
- Create: `cloudflare-worker/tests/inputs/nvt.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// cloudflare-worker/tests/inputs/nvt.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nvt } from "../../src/valuation/inputs/nvt";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("nvt adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'nvt'", () => {
    expect(nvt.key).toBe("nvt");
  });

  it("calls the NVT signal metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 85.4 }]), { status: 200 })
    );
    await nvt.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/nvts");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- nvt`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/nvt.ts`:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

// Glassnode's NVT Signal endpoint is /indicators/nvts (NVT-Signal, 90d MA variant).
const METRIC_PATH = "indicators/nvts";

export const nvt: InputAdapter = {
  key: "nvt",
  label: "NVT Signal",
  category: "market",
  source: "Glassnode",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchGlassnodeMetric(env, METRIC_PATH);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return fetchGlassnodeMetric(env, METRIC_PATH);
  },
};
```

- [ ] **Step 4: Run tests**

Run: `npm test -- nvt`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/nvt.ts cloudflare-worker/tests/inputs/nvt.test.ts
git commit -m "feat(worker/valuation): add NVT Signal adapter"
```

---

## Task 15: Hash Ribbons adapter — `src/valuation/inputs/hashRibbons.ts`

Hash Ribbons is the normalized distance between the 30d and 60d hashrate MAs. Glassnode exposes this as a single scalar per day.

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/hashRibbons.ts`
- Create: `cloudflare-worker/tests/inputs/hashRibbons.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// cloudflare-worker/tests/inputs/hashRibbons.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashRibbons } from "../../src/valuation/inputs/hashRibbons";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("hashRibbons adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'hash_ribbons'", () => {
    expect(hashRibbons.key).toBe("hash_ribbons");
  });

  it("calls the hash-rate MA signal metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 1.02 }]), { status: 200 })
    );
    await hashRibbons.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/hash_ribbon");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- hashRibbons`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/hashRibbons.ts`:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

const METRIC_PATH = "indicators/hash_ribbon";

export const hashRibbons: InputAdapter = {
  key: "hash_ribbons",
  label: "Hash Ribbons",
  category: "mining",
  source: "Glassnode",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchGlassnodeMetric(env, METRIC_PATH);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return fetchGlassnodeMetric(env, METRIC_PATH);
  },
};
```

- [ ] **Step 4: Run tests**

Run: `npm test -- hashRibbons`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/hashRibbons.ts cloudflare-worker/tests/inputs/hashRibbons.test.ts
git commit -m "feat(worker/valuation): add Hash Ribbons adapter"
```

---

## Task 16: Difficulty Ribbon adapter — `src/valuation/inputs/difficultyRibbon.ts`

Difficulty Ribbon is the compression of 9 difficulty MAs. Glassnode exposes a single-scalar compression indicator.

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/difficultyRibbon.ts`
- Create: `cloudflare-worker/tests/inputs/difficultyRibbon.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// cloudflare-worker/tests/inputs/difficultyRibbon.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { difficultyRibbon } from "../../src/valuation/inputs/difficultyRibbon";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("difficultyRibbon adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'difficulty_ribbon'", () => {
    expect(difficultyRibbon.key).toBe("difficulty_ribbon");
  });

  it("calls the difficulty-ribbon compression metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 0.023 }]), { status: 200 })
    );
    await difficultyRibbon.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/difficulty_ribbon_compression");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- difficultyRibbon`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/difficultyRibbon.ts`:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

const METRIC_PATH = "indicators/difficulty_ribbon_compression";

export const difficultyRibbon: InputAdapter = {
  key: "difficulty_ribbon",
  label: "Difficulty Ribbon",
  category: "mining",
  source: "Glassnode",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchGlassnodeMetric(env, METRIC_PATH);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return fetchGlassnodeMetric(env, METRIC_PATH);
  },
};
```

- [ ] **Step 4: Run tests**

Run: `npm test -- difficultyRibbon`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/difficultyRibbon.ts cloudflare-worker/tests/inputs/difficultyRibbon.test.ts
git commit -m "feat(worker/valuation): add Difficulty Ribbon adapter"
```

---

## Task 17: Realized Cap HODL Waves adapter — `src/valuation/inputs/hodlWaves.ts`

HODL Waves decompose supply by coin age. The 1y-2y band is commonly used as a macro-sentiment signal. We use the *realized cap*-weighted 1y-2y band as one scalar per day.

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/hodlWaves.ts`
- Create: `cloudflare-worker/tests/inputs/hodlWaves.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// cloudflare-worker/tests/inputs/hodlWaves.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hodlWaves } from "../../src/valuation/inputs/hodlWaves";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("hodlWaves adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'hodl_waves'", () => {
    expect(hodlWaves.key).toBe("hodl_waves");
  });

  it("calls the realized-HODL-waves metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 0.15 }]), { status: 200 })
    );
    await hodlWaves.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/supply/realized_hodl_waves");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- hodlWaves`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/hodlWaves.ts`:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchGlassnodeMetric } from "./glassnode";

// Glassnode's Realized Cap HODL Waves. Metric returns the 1y-2y realized-cap
// share as a scalar per day via /supply/realized_hodl_waves with band=1y_2y.
const METRIC_PATH = "supply/realized_hodl_waves";

export const hodlWaves: InputAdapter = {
  key: "hodl_waves",
  label: "Realized Cap HODL Waves",
  category: "sentiment",
  source: "Glassnode",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await fetchGlassnodeMetric(env, METRIC_PATH, { i: "24h", band: "1y_2y" });
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return fetchGlassnodeMetric(env, METRIC_PATH, { i: "24h", band: "1y_2y" });
  },
};
```

- [ ] **Step 4: Run tests**

Run: `npm test -- hodlWaves`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/hodlWaves.ts cloudflare-worker/tests/inputs/hodlWaves.test.ts
git commit -m "feat(worker/valuation): add Realized HODL Waves adapter"
```

---

## Task 18: Miner Outflows adapter — `src/valuation/inputs/minerOutflows.ts`

CryptoQuant paid API. Endpoint: `/btc/flow-indicator/miner-outflow?exchange=all_miner&window=day`. Returns `{ result: { data: [{ datetime, flow_total }] } }`.

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/minerOutflows.ts`
- Create: `cloudflare-worker/tests/inputs/minerOutflows.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// cloudflare-worker/tests/inputs/minerOutflows.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { minerOutflows } from "../../src/valuation/inputs/minerOutflows";
import type { Env } from "../../src/lib/types";

const env = { CRYPTOQUANT_API_KEY: "cq-key" } as unknown as Env;

describe("minerOutflows adapter", () => {
  beforeEach(() => vi.spyOn(globalThis, "fetch"));
  afterEach(() => vi.restoreAllMocks());

  it("uses key 'miner_outflows'", () => {
    expect(minerOutflows.key).toBe("miner_outflows");
  });

  it("parses CryptoQuant response shape", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        result: { data: [
          { datetime: "2026-04-16T00:00:00Z", flow_total: 1500 },
          { datetime: "2026-04-17T00:00:00Z", flow_total: 1200 },
        ]},
      }), { status: 200 })
    );
    const readings = await minerOutflows.fetchHistory(env);
    expect(readings.length).toBe(2);
    expect(readings[0].value).toBe(1500);
    // Sorted ascending by timestamp
    expect(readings[0].timestamp).toBeLessThan(readings[1].timestamp);
  });

  it("passes the CryptoQuant bearer token header", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { data: [] } }), { status: 200 })
    );
    await minerOutflows.fetchLatest(env);
    const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer cq-key");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- minerOutflows`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/minerOutflows.ts`:

```typescript
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
    console.error("[minerOutflows] CRYPTOQUANT_API_KEY not set");
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
```

- [ ] **Step 4: Run tests**

Run: `npm test -- minerOutflows`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/minerOutflows.ts cloudflare-worker/tests/inputs/minerOutflows.test.ts
git commit -m "feat(worker/valuation): add Miner Outflows adapter"
```

---

## Task 19: Adapter registry — `src/valuation/inputs/index.ts`

Single export that enumerates all 12 adapters in a stable order. The engine imports this; new adapters go here.

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/index.ts`
- Create: `cloudflare-worker/tests/inputs/registry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cloudflare-worker/tests/inputs/registry.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../../src/valuation/inputs";
import { INPUT_WEIGHTS } from "../../src/valuation/composite";

describe("ADAPTERS registry", () => {
  it("contains exactly 12 adapters", () => {
    expect(ADAPTERS.length).toBe(12);
  });

  it("every adapter.key matches a key in INPUT_WEIGHTS", () => {
    for (const a of ADAPTERS) {
      expect(INPUT_WEIGHTS[a.key], `weight missing for ${a.key}`).toBeTypeOf("number");
    }
  });

  it("every INPUT_WEIGHTS key has exactly one adapter", () => {
    const adapterKeys = new Set(ADAPTERS.map((a) => a.key));
    for (const key of Object.keys(INPUT_WEIGHTS)) {
      expect(adapterKeys.has(key), `no adapter for weight key '${key}'`).toBe(true);
    }
  });

  it("adapter keys are unique", () => {
    const keys = ADAPTERS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- registry`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/index.ts`:

```typescript
import type { InputAdapter } from "./types";
import { mvrv } from "./mvrv";
import { puell } from "./puell";
import { sopr } from "./sopr";
import { reserveRisk } from "./reserveRisk";
import { stockToFlow } from "./stockToFlow";
import { ma200w } from "./ma200w";
import { piCycle } from "./piCycle";
import { nvt } from "./nvt";
import { hashRibbons } from "./hashRibbons";
import { difficultyRibbon } from "./difficultyRibbon";
import { minerOutflows } from "./minerOutflows";
import { hodlWaves } from "./hodlWaves";

export const ADAPTERS: InputAdapter[] = [
  mvrv,
  puell,
  sopr,
  reserveRisk,
  stockToFlow,
  ma200w,
  piCycle,
  nvt,
  hashRibbons,
  difficultyRibbon,
  minerOutflows,
  hodlWaves,
];
```

- [ ] **Step 4: Run tests**

Run: `npm test -- registry`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/index.ts cloudflare-worker/tests/inputs/registry.test.ts
git commit -m "feat(worker/valuation): add adapter registry"
```

---

## Task 20: KV persistence layer — `src/valuation/persist.ts`

Defines the shape of what's stored in KV and provides read/write functions.

**Files:**
- Create: `cloudflare-worker/src/valuation/persist.ts`
- Create: `cloudflare-worker/tests/valuation/persist.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/valuation/persist.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_KV_KEY,
  HISTORY_KV_KEY,
  INPUTS_KV_KEY,
  loadCurrent,
  loadHistory,
  loadInputs,
  saveCurrent,
  saveHistory,
  saveInputs,
  type CurrentValuation,
  type HistoryRow,
  type InputSnapshot,
} from "../../src/valuation/persist";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string): Promise<string | null> { return store.get(key) ?? null; },
    async put(key: string, value: string): Promise<void> { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("persist", () => {
  it("round-trips CurrentValuation", async () => {
    const kv = mockKV();
    const cv: CurrentValuation = {
      z_score: -1.44,
      zone: "undervalued",
      multiplier: 2.0,
      updated_at: "2026-04-17T00:15:00Z",
      price_usd: 71434,
    };
    await saveCurrent(kv, cv);
    const loaded = await loadCurrent(kv);
    expect(loaded).toEqual(cv);
  });

  it("returns null for missing current valuation", async () => {
    const kv = mockKV();
    expect(await loadCurrent(kv)).toBeNull();
  });

  it("round-trips history with stable ordering", async () => {
    const kv = mockKV();
    const rows: HistoryRow[] = [
      { date: "2026-04-15", z_score: -1.2, zone: "undervalued", price_usd: 71000 },
      { date: "2026-04-16", z_score: -1.3, zone: "undervalued", price_usd: 71200 },
      { date: "2026-04-17", z_score: -1.44, zone: "undervalued", price_usd: 71434 },
    ];
    await saveHistory(kv, rows);
    expect(await loadHistory(kv)).toEqual(rows);
  });

  it("round-trips input snapshots", async () => {
    const kv = mockKV();
    const snap: Record<string, InputSnapshot> = {
      mvrv: { value: 2.1, z: -1.8, weight: 0.18, updated_at: "2026-04-17T00:15:00Z" },
      puell: { value: 0.4, z: -1.2, weight: 0.10, updated_at: "2026-04-17T00:15:00Z" },
    };
    await saveInputs(kv, snap);
    expect(await loadInputs(kv)).toEqual(snap);
  });

  it("exports the exact KV key names the spec promised", () => {
    expect(CURRENT_KV_KEY).toBe("valuation_current_v1");
    expect(HISTORY_KV_KEY).toBe("valuation_history_v1");
    expect(INPUTS_KV_KEY).toBe("valuation_inputs_v1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- persist`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/persist.ts`:

```typescript
import type { Zone } from "./zones";

export const CURRENT_KV_KEY = "valuation_current_v1";
export const HISTORY_KV_KEY = "valuation_history_v1";
export const INPUTS_KV_KEY = "valuation_inputs_v1";

export interface CurrentValuation {
  z_score: number;
  zone: Zone;
  multiplier: number;
  updated_at: string;
  price_usd: number;
}

export interface HistoryRow {
  date: string;       // ISO yyyy-mm-dd
  z_score: number;
  zone: Zone;
  price_usd: number;
}

export interface InputSnapshot {
  value: number;
  z: number;
  weight: number;
  updated_at: string;
}

export async function saveCurrent(kv: KVNamespace, cv: CurrentValuation): Promise<void> {
  await kv.put(CURRENT_KV_KEY, JSON.stringify(cv));
}

export async function loadCurrent(kv: KVNamespace): Promise<CurrentValuation | null> {
  const raw = await kv.get(CURRENT_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CurrentValuation;
  } catch {
    return null;
  }
}

export async function saveHistory(kv: KVNamespace, rows: HistoryRow[]): Promise<void> {
  await kv.put(HISTORY_KV_KEY, JSON.stringify(rows));
}

export async function loadHistory(kv: KVNamespace): Promise<HistoryRow[]> {
  const raw = await kv.get(HISTORY_KV_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HistoryRow[]) : [];
  } catch {
    return [];
  }
}

export async function saveInputs(
  kv: KVNamespace,
  inputs: Record<string, InputSnapshot>,
): Promise<void> {
  await kv.put(INPUTS_KV_KEY, JSON.stringify(inputs));
}

export async function loadInputs(kv: KVNamespace): Promise<Record<string, InputSnapshot>> {
  const raw = await kv.get(INPUTS_KV_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, InputSnapshot>;
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- persist`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/persist.ts cloudflare-worker/tests/valuation/persist.test.ts
git commit -m "feat(worker/valuation): add KV persistence layer"
```

---

## Task 21: Orchestrator — `src/valuation/engine.ts`

Given an env and a price, run every adapter's `fetchHistory`, Z-score each series, pull the latest point, feed to `composite()`, and persist three KV blobs: current, history, inputs.

**Files:**
- Create: `cloudflare-worker/src/valuation/engine.ts`
- Create: `cloudflare-worker/tests/valuation/engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/valuation/engine.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { runEngine, fetchSpotPrice } from "../../src/valuation/engine";
import * as persist from "../../src/valuation/persist";
import * as registry from "../../src/valuation/inputs";
import type { InputAdapter } from "../../src/valuation/inputs/types";
import type { Env } from "../../src/lib/types";

function fakeAdapter(key: keyof typeof import("../../src/valuation/composite").INPUT_WEIGHTS, values: number[]): InputAdapter {
  return {
    key,
    label: key,
    category: "market",
    source: "test",
    async fetchLatest() { return values.length ? { timestamp: Date.now()/1000, value: values[values.length-1] } : null; },
    async fetchHistory() {
      return values.map((v, i) => ({ timestamp: 1700000000 + i * 86400, value: v }));
    },
  };
}

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string): Promise<string | null> { return store.get(key) ?? null; },
    async put(key: string, value: string): Promise<void> { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("runEngine", () => {
  it("computes a composite Z-score from adapter histories and writes 3 KV blobs", async () => {
    // Replace the registry with two small adapters
    const mockAdapters = [
      fakeAdapter("mvrv",  [1, 2, 3, 4, 5]),  // latest 5; mean=3; z=(5-3)/stdev
      fakeAdapter("puell", [5, 4, 3, 2, 1]),  // latest 1; mean=3; z=(1-3)/stdev
    ];
    vi.spyOn(registry, "ADAPTERS", "get").mockReturnValue(mockAdapters);

    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env;

    await runEngine(env, { priceUsd: 71000, nowISO: "2026-04-17T00:15:00Z" });

    const cv = await persist.loadCurrent(kv);
    expect(cv).not.toBeNull();
    expect(cv!.price_usd).toBe(71000);
    expect(cv!.updated_at).toBe("2026-04-17T00:15:00Z");
    expect(Number.isFinite(cv!.z_score)).toBe(true);

    const inputs = await persist.loadInputs(kv);
    expect(Object.keys(inputs)).toEqual(["mvrv", "puell"]);

    const history = await persist.loadHistory(kv);
    expect(history.length).toBe(5);
  });

  it("skips adapters that return empty history", async () => {
    const mockAdapters = [
      fakeAdapter("mvrv", [1, 2, 3, 4, 5]),
      fakeAdapter("puell", []), // upstream down
    ];
    vi.spyOn(registry, "ADAPTERS", "get").mockReturnValue(mockAdapters);

    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env;

    await runEngine(env, { priceUsd: 71000, nowISO: "2026-04-17T00:15:00Z" });
    const inputs = await persist.loadInputs(kv);
    expect(Object.keys(inputs)).toEqual(["mvrv"]);
  });
});

describe("fetchSpotPrice", () => {
  it("returns the current USD price from Coinbase Spot", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { amount: "71434.42" } }), { status: 200 })
    );
    const price = await fetchSpotPrice();
    expect(price).toBeCloseTo(71434.42, 2);
    vi.restoreAllMocks();
  });

  it("returns 0 on upstream failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await fetchSpotPrice()).toBe(0);
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- engine`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/engine.ts`:

```typescript
import type { Env } from "../lib/types";
import { composite, INPUT_WEIGHTS } from "./composite";
import { ADAPTERS } from "./inputs";
import type { InputReading } from "./inputs/types";
import {
  saveCurrent,
  saveHistory,
  saveInputs,
  type CurrentValuation,
  type HistoryRow,
  type InputSnapshot,
} from "./persist";
import { classifyZone } from "./zones";
import { computeStats, toZScore } from "./zscore";

export interface EngineContext {
  priceUsd: number;
  nowISO: string;
}

// Fetches Bitcoin spot price from Coinbase. Returns 0 on failure (caller may
// still persist the valuation; the UI shows "—" for unknown prices).
export async function fetchSpotPrice(): Promise<number> {
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
    if (!res.ok) return 0;
    const body = (await res.json()) as { data?: { amount?: string } };
    const amount = body.data?.amount;
    if (!amount) return 0;
    const n = Number(amount);
    return Number.isFinite(n) ? n : 0;
  } catch (err) {
    console.error("[engine] spot price fetch failed:", err instanceof Error ? err.message : err);
    return 0;
  }
}

export async function runEngine(env: Env, ctx: EngineContext): Promise<void> {
  // 1. Fetch every adapter's full history in parallel.
  const results = await Promise.all(
    ADAPTERS.map(async (a) => ({ adapter: a, history: await a.fetchHistory(env) })),
  );

  // 2. For each adapter with usable history, compute per-day Z-scores over
  //    the full series and capture (a) the latest Z (for composite), (b) the
  //    full Z-series (for the composite history rollup).
  const latestZByKey: Record<string, number> = {};
  const snapshots: Record<string, InputSnapshot> = {};
  // date (yyyy-mm-dd) → { [key]: z }
  const byDate = new Map<string, Record<string, number>>();

  for (const { adapter, history } of results) {
    if (history.length === 0) continue;

    const values = history.map((r) => r.value);
    const stats = computeStats(values);

    const zSeries = values.map((v) => toZScore(v, stats));
    latestZByKey[adapter.key] = zSeries[zSeries.length - 1];

    snapshots[adapter.key] = {
      value: values[values.length - 1],
      z: zSeries[zSeries.length - 1],
      weight: INPUT_WEIGHTS[adapter.key] ?? 0,
      updated_at: ctx.nowISO,
    };

    for (let i = 0; i < history.length; i++) {
      const date = isoDate(history[i].timestamp);
      const bucket = byDate.get(date) ?? {};
      bucket[adapter.key] = zSeries[i];
      byDate.set(date, bucket);
    }
  }

  // 3. Current composite + zone.
  let currentZ: number;
  try {
    currentZ = composite(latestZByKey);
  } catch {
    currentZ = Number.NaN;
  }
  const zone = classifyZone(currentZ);
  const current: CurrentValuation = {
    z_score: Number.isFinite(currentZ) ? currentZ : 0,
    zone: zone.zone,
    multiplier: zone.multiplier,
    updated_at: ctx.nowISO,
    price_usd: ctx.priceUsd,
  };

  // 4. Per-day composite history (uses whatever adapters had a reading that day).
  const history: HistoryRow[] = [];
  const sortedDates = [...byDate.keys()].sort();
  for (const date of sortedDates) {
    const bucket = byDate.get(date)!;
    let z: number;
    try {
      z = composite(bucket);
    } catch {
      continue;
    }
    history.push({
      date,
      z_score: z,
      zone: classifyZone(z).zone,
      price_usd: 0, // price history backfill is out of scope for Plan 1
    });
  }

  // 5. Persist.
  await saveCurrent(env.PRICES_CACHE, current);
  await saveHistory(env.PRICES_CACHE, history);
  await saveInputs(env.PRICES_CACHE, snapshots);
}

function isoDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toISOString().slice(0, 10);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- engine`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/engine.ts cloudflare-worker/tests/valuation/engine.test.ts
git commit -m "feat(worker/valuation): add orchestrator engine"
```

---

## Task 22: Scheduled (cron) handler — `src/valuation/cron.ts`

A thin wrapper around `runEngine` used by the Worker's `scheduled()` export.

**Files:**
- Create: `cloudflare-worker/src/valuation/cron.ts`
- Create: `cloudflare-worker/tests/valuation/cron.test.ts`

- [ ] **Step 1: Write the failing test**

Create `cloudflare-worker/tests/valuation/cron.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { handleScheduled } from "../../src/valuation/cron";
import * as engine from "../../src/valuation/engine";
import type { Env } from "../../src/lib/types";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("handleScheduled", () => {
  it("calls runEngine with current price and ISO timestamp", async () => {
    const spyPrice = vi.spyOn(engine, "fetchSpotPrice").mockResolvedValue(71434);
    const spyRun = vi.spyOn(engine, "runEngine").mockResolvedValue();

    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    await handleScheduled(env);

    expect(spyPrice).toHaveBeenCalled();
    expect(spyRun).toHaveBeenCalledOnce();
    const [, ctx] = spyRun.mock.calls[0];
    expect(ctx.priceUsd).toBe(71434);
    expect(ctx.nowISO).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    vi.restoreAllMocks();
  });

  it("tolerates a 0 price and still runs the engine", async () => {
    vi.spyOn(engine, "fetchSpotPrice").mockResolvedValue(0);
    const spyRun = vi.spyOn(engine, "runEngine").mockResolvedValue();
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    await handleScheduled(env);
    expect(spyRun).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- cron`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/cron.ts`:

```typescript
import type { Env } from "../lib/types";
import { fetchSpotPrice, runEngine } from "./engine";

export async function handleScheduled(env: Env): Promise<void> {
  const priceUsd = await fetchSpotPrice();
  const nowISO = new Date().toISOString();
  try {
    await runEngine(env, { priceUsd, nowISO });
  } catch (err) {
    console.error("[valuation-cron] runEngine failed:", err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- cron`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/cron.ts cloudflare-worker/tests/valuation/cron.test.ts
git commit -m "feat(worker/valuation): add scheduled() handler wrapper"
```

---

## Task 23: Valuation HTTP handlers — `src/handlers/valuation.ts`

The three GET endpoints the node will consume.

**Files:**
- Create: `cloudflare-worker/src/handlers/valuation.ts`
- Create: `cloudflare-worker/tests/handlers/valuation.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/handlers/valuation.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  handleValuationCurrent,
  handleValuationHistory,
  handleValuationInputs,
} from "../../src/handlers/valuation";
import { saveCurrent, saveHistory, saveInputs } from "../../src/valuation/persist";
import type { Env } from "../../src/lib/types";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("/valuation/current", () => {
  it("returns 404 when nothing persisted yet", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await handleValuationCurrent(env);
    expect(res.status).toBe(404);
  });

  it("returns the stored blob with CORS + JSON headers", async () => {
    const kv = mockKV();
    await saveCurrent(kv, {
      z_score: -1.44, zone: "undervalued", multiplier: 2,
      updated_at: "2026-04-17T00:15:00Z", price_usd: 71434,
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const res = await handleValuationCurrent(env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await res.json() as any;
    expect(body.z_score).toBeCloseTo(-1.44, 10);
    expect(body.zone).toBe("undervalued");
  });
});

describe("/valuation/history", () => {
  it("returns empty array when nothing persisted", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await handleValuationHistory(env, new URL("https://w/valuation/history"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ series: [] });
  });

  it("applies since/until filters", async () => {
    const kv = mockKV();
    await saveHistory(kv, [
      { date: "2026-04-14", z_score: -1.2, zone: "undervalued", price_usd: 0 },
      { date: "2026-04-15", z_score: -1.3, zone: "undervalued", price_usd: 0 },
      { date: "2026-04-16", z_score: -1.4, zone: "undervalued", price_usd: 0 },
      { date: "2026-04-17", z_score: -1.44, zone: "undervalued", price_usd: 0 },
    ]);
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const url = new URL("https://w/valuation/history?since=2026-04-15&until=2026-04-16");
    const res = await handleValuationHistory(env, url);
    const body = await res.json() as any;
    expect(body.series.map((r: any) => r.date)).toEqual(["2026-04-15", "2026-04-16"]);
  });
});

describe("/valuation/inputs", () => {
  it("returns {} when nothing persisted", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await handleValuationInputs(env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("returns the snapshot map", async () => {
    const kv = mockKV();
    await saveInputs(kv, {
      mvrv: { value: 2.1, z: -1.8, weight: 0.18, updated_at: "2026-04-17T00:15:00Z" },
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const res = await handleValuationInputs(env);
    const body = await res.json() as any;
    expect(body.mvrv.z).toBeCloseTo(-1.8, 10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- handlers/valuation`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/handlers/valuation.ts`:

```typescript
import { CORS_HEADERS } from "../lib/cors";
import type { Env } from "../lib/types";
import {
  loadCurrent,
  loadHistory,
  loadInputs,
} from "../valuation/persist";

export async function handleValuationCurrent(env: Env): Promise<Response> {
  const cv = await loadCurrent(env.PRICES_CACHE);
  if (!cv) {
    return new Response(JSON.stringify({ error: "no_valuation_data" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  }
  return new Response(JSON.stringify(cv), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleValuationHistory(env: Env, url: URL): Promise<Response> {
  const since = url.searchParams.get("since"); // yyyy-mm-dd
  const until = url.searchParams.get("until");
  let rows = await loadHistory(env.PRICES_CACHE);
  if (since) rows = rows.filter((r) => r.date >= since);
  if (until) rows = rows.filter((r) => r.date <= until);
  return new Response(JSON.stringify({ series: rows }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleValuationInputs(env: Env): Promise<Response> {
  const snap = await loadInputs(env.PRICES_CACHE);
  return new Response(JSON.stringify(snap), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- handlers/valuation`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/handlers/valuation.ts cloudflare-worker/tests/handlers/valuation.test.ts
git commit -m "feat(worker/valuation): add /valuation HTTP handlers"
```

---

## Task 24: Wire router + scheduled handler in `index.ts`

**Files:**
- Modify: `cloudflare-worker/src/index.ts`
- Create: `cloudflare-worker/tests/router.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/router.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/lib/types";
import { saveCurrent } from "../src/valuation/persist";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("router", () => {
  it("dispatches GET /valuation/current", async () => {
    const kv = mockKV();
    await saveCurrent(kv, {
      z_score: 0, zone: "fair_value", multiplier: 1,
      updated_at: "2026-04-17T00:15:00Z", price_usd: 70000,
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const res = await worker.fetch(new Request("https://w/valuation/current"), env, {} as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.zone).toBe("fair_value");
  });

  it("dispatches GET /valuation/history with filters", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await worker.fetch(
      new Request("https://w/valuation/history?since=2026-04-01"),
      env, {} as any,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ series: [] });
  });

  it("dispatches GET /valuation/inputs", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await worker.fetch(new Request("https://w/valuation/inputs"), env, {} as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("keeps existing routes working (/recommended-peers)", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await worker.fetch(new Request("https://w/recommended-peers"), env, {} as any);
    expect(res.status).toBe(200);
  });

  it("returns 404 for unknown paths", async () => {
    const env = { PRICES_CACHE: mockKV() } as unknown as Env;
    const res = await worker.fetch(new Request("https://w/nope"), env, {} as any);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- router`

Expected: FAIL — new valuation routes not wired.

- [ ] **Step 3: Update `index.ts`**

Replace the entire `export default { ... }` block at the bottom of `cloudflare-worker/src/index.ts` with:

```typescript
import { handleOnramp } from "./handlers/onramp";
import { handlePrices, handleCornHistory } from "./handlers/prices";
import { handleRecommendedPeers } from "./handlers/recommendedPeers";
import { handleTreasuryInfo } from "./handlers/treasuryInfo";
import {
  handleValuationCurrent,
  handleValuationHistory,
  handleValuationInputs,
} from "./handlers/valuation";
import { handleScheduled } from "./valuation/cron";
import { CORS_HEADERS } from "./lib/cors";
import type { Env } from "./lib/types";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/recommended-peers") {
      return handleRecommendedPeers();
    }
    if (request.method === "GET" && url.pathname === "/treasury-info") {
      return handleTreasuryInfo(env);
    }
    if (request.method === "GET" && url.pathname === "/prices/corn-history") {
      return handleCornHistory(env);
    }
    if (request.method === "GET" && url.pathname === "/prices") {
      return handlePrices(env);
    }
    if (request.method === "GET" && url.pathname === "/valuation/current") {
      return handleValuationCurrent(env);
    }
    if (request.method === "GET" && url.pathname === "/valuation/history") {
      return handleValuationHistory(env, url);
    }
    if (request.method === "GET" && url.pathname === "/valuation/inputs") {
      return handleValuationInputs(env);
    }
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "")) {
      return handleOnramp(request, env);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
};
```

Ensure every import at the top of the file is still used; remove any now-unused imports from earlier refactors.

- [ ] **Step 4: Run tests + type-check**

```bash
npm test
npx tsc --noEmit
```

Expected: all tests pass; no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/index.ts cloudflare-worker/tests/router.test.ts
git commit -m "feat(worker): wire valuation routes + scheduled handler"
```

---

## Task 25: Wrangler config — cron + document new secrets

**Files:**
- Modify: `cloudflare-worker/wrangler.toml`

- [ ] **Step 1: Update `wrangler.toml`**

Replace the contents of `cloudflare-worker/wrangler.toml` with:

```toml
name = "bitcorn-onramp"
main = "src/index.ts"
compatibility_date = "2024-01-01"

# Daily cron at 00:15 UTC — triggers valuation engine refresh.
# (5-field form: minute hour day-of-month month day-of-week)
[triggers]
crons = ["15 0 * * *"]

[[kv_namespaces]]
binding = "PRICES_CACHE"
id = "62c68c41830141cc8b0b6e7cdb193461"

# Secrets required (set via `wrangler secret put <NAME>`; never checked in):
#   CDP_KEY_NAME            — existing (Coinbase Onramp)
#   CDP_PRIVATE_KEY         — existing (Coinbase Onramp)
#   USDA_NASS_KEY           — existing (commodity prices)
#   GLASSNODE_API_KEY       — new (valuation: 8 inputs)
#   CRYPTOQUANT_API_KEY     — new (valuation: miner_outflows)
#   LOOKINTOBITCOIN_API_KEY — new (valuation: ma_200w, pi_cycle)
#   PLANB_API_KEY           — new (valuation: stock_to_flow; optional — adapter
#                              falls through to unauthenticated endpoint if unset)
```

- [ ] **Step 2: Verify wrangler parses the config**

Run:

```bash
cd cloudflare-worker
npx wrangler deploy --dry-run
```

Expected: wrangler reports it would deploy cleanly (no syntax errors). Do not do a real deploy yet — that's Task 27.

- [ ] **Step 3: Commit**

```bash
git add cloudflare-worker/wrangler.toml
git commit -m "chore(worker): add daily cron + document valuation secrets"
```

---

## Task 26: One-off backfill script — `scripts/backfill.ts`

A standalone script that runs `runEngine` locally (against real upstreams) to seed KV on first deploy. Takes env vars via command-line for safety.

**Files:**
- Create: `cloudflare-worker/scripts/backfill.ts`
- Modify: `cloudflare-worker/package.json` (add `backfill` script)

- [ ] **Step 1: Update `package.json`**

Add a `backfill` npm script:

```json
{
  "name": "bitcorn-onramp-worker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "backfill": "wrangler dev --test-scheduled --port 8787"
  },
  "dependencies": {
    "jose": "^5.0.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.0.0",
    "@cloudflare/vitest-pool-workers": "^0.5.0",
    "typescript": "^5.0.0",
    "vitest": "^1.6.0",
    "wrangler": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create `scripts/backfill.ts`** (reference doc, not executed by vitest)

Create `cloudflare-worker/scripts/backfill.ts`:

```typescript
// One-off backfill script — called on first deploy to seed KV with historical
// valuation data before the daily cron takes over.
//
// Usage (after `wrangler deploy` has shipped the Worker code):
//
//   # Start a local dev instance with production KV bindings wired through:
//   npx wrangler dev --test-scheduled --remote
//
//   # In another terminal, trigger the scheduled handler manually:
//   curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
//
// The scheduled handler is the same code that runs daily on cron; running it
// manually once is sufficient to populate the three KV keys:
//   - valuation_current_v1
//   - valuation_history_v1
//   - valuation_inputs_v1
//
// Verify with:
//   curl https://bitcorn-onramp.<you>.workers.dev/valuation/current
//
// This file exists as living documentation; it is not imported by any code.

export {};
```

- [ ] **Step 3: Commit**

```bash
git add cloudflare-worker/package.json cloudflare-worker/scripts/backfill.ts
git commit -m "chore(worker): add backfill runbook script"
```

---

## Task 27: Deploy + smoke test

**NO CODE CHANGES**. This task is operational — runs the full test suite one last time, gets secrets into Cloudflare, deploys, runs the scheduled trigger once manually, and verifies the three endpoints.

- [ ] **Step 1: Run the whole test suite**

```bash
cd cloudflare-worker
npm test
npx tsc --noEmit
```

Expected: all tests pass, no TypeScript errors.

- [ ] **Step 2: Set required secrets on Cloudflare**

For each of the following commands, the user pastes the real key value when prompted (then Ctrl-D). Do NOT proceed to the next step if any secret is missing.

```bash
npx wrangler secret put GLASSNODE_API_KEY
npx wrangler secret put CRYPTOQUANT_API_KEY
npx wrangler secret put LOOKINTOBITCOIN_API_KEY
npx wrangler secret put PLANB_API_KEY    # optional — Ctrl-D with empty input if you don't have one
```

Verify all secrets are present:

```bash
npx wrangler secret list
```

Expected to include: `CDP_KEY_NAME`, `CDP_PRIVATE_KEY`, `USDA_NASS_KEY`, `GLASSNODE_API_KEY`, `CRYPTOQUANT_API_KEY`, `LOOKINTOBITCOIN_API_KEY`, and `PLANB_API_KEY` (if set).

- [ ] **Step 3: Deploy**

```bash
npx wrangler deploy
```

Expected: `Deployed bitcorn-onramp (...)`. Note the URL.

- [ ] **Step 4: Trigger scheduled handler once to populate KV**

```bash
# Start local dev connected to production KV
npx wrangler dev --test-scheduled --remote &
DEV_PID=$!
sleep 5

# Fire the scheduled handler
curl -sS "http://localhost:8787/__scheduled?cron=15+0+*+*+*"
echo

kill $DEV_PID
```

Expected: the `curl` returns `200 OK` (empty body is fine — scheduled handlers don't return responses).

- [ ] **Step 5: Smoke-test the three endpoints**

Replace `<WORKER_URL>` with the URL wrangler printed (probably `https://bitcorn-onramp.ethancail.workers.dev`).

```bash
curl -s <WORKER_URL>/valuation/current | jq .
curl -s "<WORKER_URL>/valuation/history?since=2025-01-01" | jq '.series | length'
curl -s <WORKER_URL>/valuation/inputs | jq 'keys | length'
```

Expected:
- `/valuation/current` returns a JSON object with `z_score`, `zone`, `multiplier`, `updated_at`, `price_usd` fields, none of which are null. `zone` is one of the six known values. `multiplier` matches the zone per Task 4's table.
- `/valuation/history` returns an array; length should be > 0 (ideally hundreds of days if upstream history was available).
- `/valuation/inputs` returns an object with length 12 (all adapters reported) — or lower if some upstreams were temporarily down during the cron run.

- [ ] **Step 6: Sanity check logs**

```bash
npx wrangler tail
```

Expected: no errors in the tail for a few minutes. Look especially for any `[glassnode] ...: HTTP 401` or `[cryptoquant] ...: HTTP 403` — those mean the API keys are wrong. Fix before closing the task.

- [ ] **Step 7: Commit nothing, push the branch**

No new files were created in Task 27; everything was operational. Push the feature branch to origin so the user can open the PR to `develop` when they're ready:

```bash
git push -u origin feature/coinbase-auto-buy
```

Plan 1 is now done. The Worker serves live valuation data. Plan 2 (Node executor) can start.

---

## Self-review checklist (already performed)

- **Spec coverage**: every section of `docs/superpowers/specs/2026-04-17-coinbase-auto-buy-design.md` §4 (Valuation Engine, Worker side) has a corresponding task above. §4.1 inputs table → Tasks 7–18. §4.2 Z-score math → Tasks 4–6. §4.3 historical backfill → Task 21 (engine) + Task 27 (manual trigger). §4.4 endpoints → Task 23. §4.5 secrets → Task 25.
- **Placeholder scan**: no "TBD", "TODO", or "similar to Task N" anywhere.
- **Type consistency**: `InputAdapter` shape defined once in Task 7; every adapter in Tasks 7–18 imports that type. `InputReading` shape shared. `CurrentValuation`, `HistoryRow`, `InputSnapshot` defined once in Task 20; used by handlers in Task 23.
- **Adapter key ↔ weight key sync**: Task 19 includes a test (`registry.test.ts`) that fails if any adapter key is missing from `INPUT_WEIGHTS` or vice versa. If a future change adds an input, that test guards the registry.
