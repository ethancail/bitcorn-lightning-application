# Coinbase Auto-Buy — Plan 1 Revision: Manual-Input Pivot (Worker)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pivot the Cloudflare Worker to support manual daily entry of the 8 Glassnode-sourced valuation inputs. Remove paid-API dependencies (Glassnode, LookIntoBitcoin) and add an HMAC-authed `POST /valuation/manual` endpoint that the treasury node will call.

**Architecture:** Replace 8 Glassnode adapters with 8 `manualInput` adapters that read from a new KV blob `valuation_manual_v1`. Refactor `ma200w` and `piCycle` to compute locally from BTC daily price history (CoinGecko free tier + cached). Keep CryptoQuant Miner Outflows (free API) and PlanB Stock-to-Flow (unauthenticated) unchanged. Add HMAC signature verification on the new write endpoint.

**Tech Stack:** Cloudflare Workers (TypeScript, ESM), `jose` (already in deps, reused for HMAC), `vitest` + `@cloudflare/vitest-pool-workers`. No new dependencies.

---

## Context for the engineer

- Plan 1 (Valuation Engine) shipped 26 of 27 tasks. Current `feature/coinbase-auto-buy` branch HEAD is `a5d0237`. 94 tests across 24 files, all green; `tsc --noEmit` clean.
- This revision plan runs against that same branch — it does **not** create a new branch. The git history will show Plan 1 → Plan 1-revision → Plan 1b → Plan 2 → Plan 3 as sequential work on one branch.
- Spec reference: `docs/superpowers/specs/2026-04-17-coinbase-auto-buy-design.md` §4.1 (ingestion column) and §4.6 (manual-input workflow).
- Before starting: `cd cloudflare-worker && npm test` should show 94 passing. If not, stop and reconcile.
- A single commit per task. No pushing until the whole revision + Plan 1b are executed and smoke-tested.

## File structure after this revision

```
cloudflare-worker/
├── src/
│   ├── valuation/
│   │   ├── inputs/
│   │   │   ├── types.ts                         (unchanged)
│   │   │   ├── index.ts                         (modified: adapter registry updated)
│   │   │   ├── stockToFlow.ts                   (unchanged)
│   │   │   ├── ma200w.ts                        (rewritten: compute from price)
│   │   │   ├── piCycle.ts                       (rewritten: compute from price)
│   │   │   ├── minerOutflows.ts                 (unchanged)
│   │   │   ├── priceHistory.ts                  (new: CoinGecko daily price fetch + KV cache)
│   │   │   ├── manualInput.ts                   (new: shared factory for 8 manual adapters)
│   │   │   ├── mvrv.ts                          (rewritten: thin manualInput adapter)
│   │   │   ├── puell.ts                         (rewritten: thin manualInput adapter)
│   │   │   ├── sopr.ts                          (rewritten: thin manualInput adapter)
│   │   │   ├── reserveRisk.ts                   (rewritten: thin manualInput adapter)
│   │   │   ├── nvt.ts                           (rewritten: thin manualInput adapter)
│   │   │   ├── hashRibbons.ts                   (rewritten: thin manualInput adapter)
│   │   │   ├── difficultyRibbon.ts              (rewritten: thin manualInput adapter)
│   │   │   ├── hodlWaves.ts                     (rewritten: thin manualInput adapter)
│   │   │   └── glassnode.ts                     (DELETED)
│   │   └── manualStore.ts                       (new: read/write valuation_manual_v1 KV blob)
│   ├── handlers/
│   │   └── manualInput.ts                       (new: POST /valuation/manual handler with HMAC)
│   ├── lib/
│   │   ├── types.ts                             (modified: Env gains VALUATION_SUBMIT_HMAC, loses GLASSNODE_API_KEY/LOOKINTOBITCOIN_API_KEY)
│   │   └── hmac.ts                              (new: canonical-string + verify helpers)
│   └── index.ts                                 (modified: wire POST /valuation/manual)
├── wrangler.toml                                (modified: update secret documentation)
└── tests/
    ├── lib/
    │   └── hmac.test.ts                         (new)
    ├── inputs/
    │   ├── manualInput.test.ts                  (new)
    │   ├── priceHistory.test.ts                 (new)
    │   ├── ma200w.test.ts                       (rewritten: test local compute)
    │   ├── piCycle.test.ts                      (rewritten: test local compute)
    │   ├── glassnode.test.ts                    (DELETED)
    │   ├── mvrv.test.ts                         (rewritten: thin delegation test)
    │   ├── puell.test.ts                        (rewritten)
    │   ├── sopr.test.ts                         (rewritten)
    │   ├── reserveRisk.test.ts                  (rewritten)
    │   ├── nvt.test.ts                          (rewritten)
    │   ├── hashRibbons.test.ts                  (rewritten)
    │   ├── difficultyRibbon.test.ts             (rewritten)
    │   ├── hodlWaves.test.ts                    (rewritten)
    │   └── registry.test.ts                     (unchanged — still asserts 12 adapters)
    ├── handlers/
    │   └── manualInput.test.ts                  (new: HMAC auth + KV write behaviour)
    └── valuation/
        └── manualStore.test.ts                  (new)
```

---

## Task R1: HMAC verification helper — `src/lib/hmac.ts`

**Files:**
- Create: `cloudflare-worker/src/lib/hmac.ts`
- Create: `cloudflare-worker/tests/lib/hmac.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/lib/hmac.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { canonicalString, signHmac, verifyHmac } from "../../src/lib/hmac";

const SECRET = "test-secret-value";
const TIMESTAMP = "2026-04-17T14:32:00Z";
const BODY = '{"submitted_at":"2026-04-17T14:32:00Z","values":{"mvrv":2.1}}';

describe("canonicalString", () => {
  it("concatenates timestamp and hex SHA-256 of body with a newline", async () => {
    const s = await canonicalString(TIMESTAMP, BODY);
    // The body hash is deterministic; check shape rather than exact digest
    expect(s.startsWith(TIMESTAMP + "\n")).toBe(true);
    expect(s.length).toBe(TIMESTAMP.length + 1 + 64); // 64-char hex digest
  });
});

describe("signHmac + verifyHmac", () => {
  it("round-trips: a signature signed with SECRET verifies with SECRET", async () => {
    const sig = await signHmac(SECRET, TIMESTAMP, BODY);
    const ok = await verifyHmac(SECRET, TIMESTAMP, BODY, sig);
    expect(ok).toBe(true);
  });

  it("rejects a wrong signature", async () => {
    const ok = await verifyHmac(SECRET, TIMESTAMP, BODY, "deadbeef".repeat(8));
    expect(ok).toBe(false);
  });

  it("rejects a body mutation", async () => {
    const sig = await signHmac(SECRET, TIMESTAMP, BODY);
    const ok = await verifyHmac(SECRET, TIMESTAMP, BODY + " ", sig);
    expect(ok).toBe(false);
  });

  it("rejects a timestamp change", async () => {
    const sig = await signHmac(SECRET, TIMESTAMP, BODY);
    const ok = await verifyHmac(SECRET, "2026-04-17T14:33:00Z", BODY, sig);
    expect(ok).toBe(false);
  });

  it("rejects a wrong secret", async () => {
    const sig = await signHmac(SECRET, TIMESTAMP, BODY);
    const ok = await verifyHmac("other-secret", TIMESTAMP, BODY, sig);
    expect(ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- hmac`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/lib/hmac.ts`:

```typescript
// HMAC-SHA256 signature utilities for the POST /valuation/manual endpoint.
// Canonical string: <ISO timestamp>\n<hex SHA-256 of JSON body>
// Signature: HMAC-SHA256 of canonical string with VALUATION_SUBMIT_HMAC, hex-encoded.

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(s));
  return hex(digest);
}

export async function canonicalString(timestamp: string, body: string): Promise<string> {
  return `${timestamp}\n${await sha256Hex(body)}`;
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signHmac(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(await canonicalString(timestamp, body)));
  return hex(sig);
}

export async function verifyHmac(
  secret: string,
  timestamp: string,
  body: string,
  signatureHex: string,
): Promise<boolean> {
  if (!/^[0-9a-f]+$/i.test(signatureHex) || signatureHex.length % 2 !== 0) return false;
  const sigBytes = new Uint8Array(signatureHex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(signatureHex.slice(i * 2, i * 2 + 2), 16);
  }
  const key = await importKey(secret);
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(await canonicalString(timestamp, body)));
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- hmac`

Expected: all 6 cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/lib/hmac.ts cloudflare-worker/tests/lib/hmac.test.ts
git commit -m "feat(worker/lib): add HMAC-SHA256 sign/verify helpers"
```

---

## Task R2: Env type update — drop paid-API keys, add `VALUATION_SUBMIT_HMAC`

**Files:**
- Modify: `cloudflare-worker/src/lib/types.ts`

- [ ] **Step 1: Update the Env interface**

Edit `cloudflare-worker/src/lib/types.ts`. Replace the `Env` interface with:

```typescript
export interface Env {
  CDP_KEY_NAME: string;
  CDP_PRIVATE_KEY: string;
  USDA_NASS_KEY: string;
  PRICES_CACHE: KVNamespace;
  TREASURY_PUBKEY?: string;
  TREASURY_SOCKET?: string;
  // Valuation upstreams (only the auto-fetch adapters need keys now)
  CRYPTOQUANT_API_KEY?: string;
  PLANB_API_KEY?: string;
  // Manual-input HMAC (validated by POST /valuation/manual)
  VALUATION_SUBMIT_HMAC?: string;
}
```

The old `GLASSNODE_API_KEY` and `LOOKINTOBITCOIN_API_KEY` fields are removed.

- [ ] **Step 2: Run tests + type-check**

```bash
npm test
npx tsc --noEmit
```

Expected: tests still pass (existing adapters still reference the removed fields — `tsc` should FAIL at this point identifying them). List those files and prepare the fixes for Tasks R3-R11. If `tsc` passes unexpectedly, something is wrong — stop and investigate.

- [ ] **Step 3: Commit**

If tsc fails (expected), commit the type change standalone so the diff is isolated:

```bash
git add cloudflare-worker/src/lib/types.ts
git commit -m "refactor(worker): remove Glassnode/LookIntoBitcoin env keys; add VALUATION_SUBMIT_HMAC

Breaks typechecking in 9 files (glassnode.ts, ma200w.ts, piCycle.ts, and the 8
Glassnode adapters) — intentional. Subsequent tasks in the manual-input
revision will migrate each one off the removed keys."
```

Do NOT try to fix the `tsc` errors yet. They're expected and will be resolved as each downstream file is rewritten.

---

## Task R3: Manual-input KV store — `src/valuation/manualStore.ts`

**Files:**
- Create: `cloudflare-worker/src/valuation/manualStore.ts`
- Create: `cloudflare-worker/tests/valuation/manualStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/valuation/manualStore.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  MANUAL_KV_KEY,
  MANUAL_METRIC_KEYS,
  appendManualSubmission,
  loadManualHistory,
  type ManualValues,
} from "../../src/valuation/manualStore";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("MANUAL_METRIC_KEYS", () => {
  it("lists exactly the 8 manual-entry metrics", () => {
    expect(MANUAL_METRIC_KEYS).toEqual([
      "mvrv", "puell", "sopr", "reserve_risk",
      "nvt", "hash_ribbons", "difficulty_ribbon", "hodl_waves",
    ]);
  });
});

describe("appendManualSubmission + loadManualHistory", () => {
  it("appends one row per metric keyed by submission timestamp", async () => {
    const kv = mockKV();
    const values: ManualValues = {
      mvrv: 2.1, puell: 0.4, sopr: 1.008, reserve_risk: 0.003,
      nvt: 85.4, hash_ribbons: 1.02, difficulty_ribbon: 0.023, hodl_waves: 0.15,
    };
    await appendManualSubmission(kv, "2026-04-17T14:32:00Z", values);

    const history = await loadManualHistory(kv);
    expect(Object.keys(history)).toEqual(MANUAL_METRIC_KEYS);
    expect(history.mvrv.length).toBe(1);
    expect(history.mvrv[0].value).toBeCloseTo(2.1, 10);
    // Unix-seconds conversion of the ISO timestamp
    expect(history.mvrv[0].timestamp).toBe(Math.floor(new Date("2026-04-17T14:32:00Z").getTime() / 1000));
  });

  it("a second submission appends another row", async () => {
    const kv = mockKV();
    const v1: ManualValues = { mvrv: 1, puell: 1, sopr: 1, reserve_risk: 1, nvt: 1, hash_ribbons: 1, difficulty_ribbon: 1, hodl_waves: 1 };
    const v2: ManualValues = { mvrv: 2, puell: 2, sopr: 2, reserve_risk: 2, nvt: 2, hash_ribbons: 2, difficulty_ribbon: 2, hodl_waves: 2 };
    await appendManualSubmission(kv, "2026-04-16T14:00:00Z", v1);
    await appendManualSubmission(kv, "2026-04-17T14:00:00Z", v2);
    const history = await loadManualHistory(kv);
    expect(history.mvrv.map((r) => r.value)).toEqual([1, 2]);
  });

  it("loadManualHistory returns empty series for each metric when nothing persisted", async () => {
    const kv = mockKV();
    const history = await loadManualHistory(kv);
    for (const k of MANUAL_METRIC_KEYS) {
      expect(history[k]).toEqual([]);
    }
  });

  it("KV key name is stable contract", () => {
    expect(MANUAL_KV_KEY).toBe("valuation_manual_v1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- manualStore`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/manualStore.ts`:

```typescript
import type { InputReading } from "./inputs/types";

export const MANUAL_KV_KEY = "valuation_manual_v1";

export const MANUAL_METRIC_KEYS = [
  "mvrv",
  "puell",
  "sopr",
  "reserve_risk",
  "nvt",
  "hash_ribbons",
  "difficulty_ribbon",
  "hodl_waves",
] as const;

export type ManualMetricKey = (typeof MANUAL_METRIC_KEYS)[number];

export type ManualValues = Record<ManualMetricKey, number>;
export type ManualHistory = Record<ManualMetricKey, InputReading[]>;

function emptyHistory(): ManualHistory {
  const h: Partial<ManualHistory> = {};
  for (const k of MANUAL_METRIC_KEYS) h[k] = [];
  return h as ManualHistory;
}

export async function loadManualHistory(kv: KVNamespace): Promise<ManualHistory> {
  const raw = await kv.get(MANUAL_KV_KEY);
  if (!raw) return emptyHistory();
  try {
    const parsed = JSON.parse(raw) as Partial<ManualHistory>;
    const out = emptyHistory();
    for (const k of MANUAL_METRIC_KEYS) {
      const series = parsed[k];
      if (Array.isArray(series)) out[k] = series;
    }
    return out;
  } catch (err) {
    console.error("[manualStore] load parse failed:", err instanceof Error ? err.message : err);
    return emptyHistory();
  }
}

export async function appendManualSubmission(
  kv: KVNamespace,
  submittedAtISO: string,
  values: ManualValues,
): Promise<void> {
  const history = await loadManualHistory(kv);
  const timestamp = Math.floor(new Date(submittedAtISO).getTime() / 1000);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`[manualStore] invalid submittedAt: ${submittedAtISO}`);
  }
  for (const k of MANUAL_METRIC_KEYS) {
    const value = values[k];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    history[k].push({ timestamp, value });
  }
  await kv.put(MANUAL_KV_KEY, JSON.stringify(history));
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- manualStore`

Expected: all 4 cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/manualStore.ts cloudflare-worker/tests/valuation/manualStore.test.ts
git commit -m "feat(worker/valuation): add manualStore — KV shape for manual-entry history"
```

---

## Task R4: Manual-input adapter factory — `src/valuation/inputs/manualInput.ts`

Produces an `InputAdapter` that reads its series from `manualStore` for a given metric key.

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/manualInput.ts`
- Create: `cloudflare-worker/tests/inputs/manualInput.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/inputs/manualInput.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { makeManualAdapter } from "../../src/valuation/inputs/manualInput";
import { MANUAL_KV_KEY } from "../../src/valuation/manualStore";
import type { Env } from "../../src/lib/types";

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("makeManualAdapter", () => {
  it("produces an adapter with correct key/label/category/source", () => {
    const a = makeManualAdapter({
      key: "mvrv",
      label: "MVRV Z-Score",
      category: "on-chain",
    });
    expect(a.key).toBe("mvrv");
    expect(a.label).toBe("MVRV Z-Score");
    expect(a.category).toBe("on-chain");
    expect(a.source).toBe("manual");
  });

  it("fetchHistory returns the series from the manual KV blob", async () => {
    const kv = mockKV({
      [MANUAL_KV_KEY]: JSON.stringify({
        mvrv: [{ timestamp: 100, value: 1 }, { timestamp: 200, value: 2 }],
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const a = makeManualAdapter({ key: "mvrv", label: "MVRV Z-Score", category: "on-chain" });
    const history = await a.fetchHistory(env);
    expect(history.length).toBe(2);
    expect(history[1].value).toBe(2);
  });

  it("fetchLatest returns the most recent reading", async () => {
    const kv = mockKV({
      [MANUAL_KV_KEY]: JSON.stringify({
        puell: [{ timestamp: 100, value: 0.4 }, { timestamp: 200, value: 0.45 }],
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const a = makeManualAdapter({ key: "puell", label: "Puell Multiple", category: "on-chain" });
    const reading = await a.fetchLatest(env);
    expect(reading).not.toBeNull();
    expect(reading!.value).toBeCloseTo(0.45, 10);
  });

  it("fetchLatest returns null when no submissions yet", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const a = makeManualAdapter({ key: "sopr", label: "SOPR (30d MA)", category: "on-chain" });
    expect(await a.fetchLatest(env)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- manualInput`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/manualInput.ts`:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputCategory, InputReading } from "./types";
import { loadManualHistory, type ManualMetricKey } from "../manualStore";

export interface ManualAdapterConfig {
  key: ManualMetricKey;
  label: string;
  category: InputCategory;
}

export function makeManualAdapter(cfg: ManualAdapterConfig): InputAdapter {
  return {
    key: cfg.key,
    label: cfg.label,
    category: cfg.category,
    source: "manual",

    async fetchLatest(env: Env): Promise<InputReading | null> {
      const history = await loadManualHistory(env.PRICES_CACHE);
      const series = history[cfg.key];
      if (!series || series.length === 0) return null;
      return series[series.length - 1];
    },

    async fetchHistory(env: Env): Promise<InputReading[]> {
      const history = await loadManualHistory(env.PRICES_CACHE);
      return history[cfg.key] ?? [];
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- manualInput`

Expected: all 4 cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/manualInput.ts cloudflare-worker/tests/inputs/manualInput.test.ts
git commit -m "feat(worker/valuation): add manualInput adapter factory"
```

---

## Task R5: Rewrite the 8 Glassnode adapters as manual-input adapters

Replaces 8 API-fetching adapters with 8 thin manualInput delegations. Each file becomes 5-8 lines. The 8 test files also shrink — they now test "the adapter correctly delegates to manualInput" rather than testing a mocked fetch.

**Files to rewrite** (both source and test for each):
- `cloudflare-worker/src/valuation/inputs/mvrv.ts` + test
- `cloudflare-worker/src/valuation/inputs/puell.ts` + test
- `cloudflare-worker/src/valuation/inputs/sopr.ts` + test
- `cloudflare-worker/src/valuation/inputs/reserveRisk.ts` + test
- `cloudflare-worker/src/valuation/inputs/nvt.ts` + test
- `cloudflare-worker/src/valuation/inputs/hashRibbons.ts` + test
- `cloudflare-worker/src/valuation/inputs/difficultyRibbon.ts` + test
- `cloudflare-worker/src/valuation/inputs/hodlWaves.ts` + test

**Files to delete**:
- `cloudflare-worker/src/valuation/inputs/glassnode.ts`
- `cloudflare-worker/tests/inputs/glassnode.test.ts`

- [ ] **Step 1: Rewrite each adapter source**

For each of the 8 adapters, replace the entire file content with the `makeManualAdapter` call. The mapping:

| File | key | label | category |
|------|-----|-------|----------|
| `mvrv.ts` | `"mvrv"` | `"MVRV Z-Score"` | `"on-chain"` |
| `puell.ts` | `"puell"` | `"Puell Multiple"` | `"on-chain"` |
| `sopr.ts` | `"sopr"` | `"SOPR (30d MA)"` | `"on-chain"` |
| `reserveRisk.ts` | `"reserve_risk"` | `"Reserve Risk"` | `"on-chain"` |
| `nvt.ts` | `"nvt"` | `"NVT Signal"` | `"market"` |
| `hashRibbons.ts` | `"hash_ribbons"` | `"Hash Ribbons"` | `"mining"` |
| `difficultyRibbon.ts` | `"difficulty_ribbon"` | `"Difficulty Ribbon"` | `"mining"` |
| `hodlWaves.ts` | `"hodl_waves"` | `"Realized Cap HODL Waves"` | `"sentiment"` |

Template for each file (replacing `<NAME>`, `<KEY>`, `<LABEL>`, `<CATEGORY>` per the table):

```typescript
import { makeManualAdapter } from "./manualInput";

export const <NAME> = makeManualAdapter({
  key: "<KEY>",
  label: "<LABEL>",
  category: "<CATEGORY>",
});
```

Example for `mvrv.ts`:

```typescript
import { makeManualAdapter } from "./manualInput";

export const mvrv = makeManualAdapter({
  key: "mvrv",
  label: "MVRV Z-Score",
  category: "on-chain",
});
```

Do NOT leave any traces of the old Glassnode imports/consts in these files.

- [ ] **Step 2: Rewrite each adapter test**

Replace each test file with a minimal delegation check. Example for `mvrv.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mvrv } from "../../src/valuation/inputs/mvrv";
import { MANUAL_KV_KEY } from "../../src/valuation/manualStore";
import type { Env } from "../../src/lib/types";

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("mvrv adapter", () => {
  it("has key 'mvrv' and source 'manual'", () => {
    expect(mvrv.key).toBe("mvrv");
    expect(mvrv.source).toBe("manual");
  });

  it("reads from manualStore", async () => {
    const kv = mockKV({
      [MANUAL_KV_KEY]: JSON.stringify({
        mvrv: [{ timestamp: 100, value: 2.1 }],
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const r = await mvrv.fetchLatest(env);
    expect(r!.value).toBeCloseTo(2.1, 10);
  });
});
```

Create one test file per adapter following this pattern, substituting the adapter's `key` value. Do NOT retain the old mocked-fetch tests.

- [ ] **Step 3: Delete `glassnode.ts` + `glassnode.test.ts`**

```bash
rm cloudflare-worker/src/valuation/inputs/glassnode.ts
rm cloudflare-worker/tests/inputs/glassnode.test.ts
```

- [ ] **Step 4: Run tests + type-check**

```bash
npm test
npx tsc --noEmit
```

Expected: all tests pass (including the 8 new delegation tests + existing registry test). `tsc --noEmit` exits 0 — this is the task that fully resolves the tsc errors introduced in R2.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/ cloudflare-worker/tests/inputs/
git commit -m "refactor(worker/valuation): rewrite 8 Glassnode adapters as manualInput delegates

Removes glassnode.ts helper + 8 adapter implementations that fetched live
from Glassnode. Each adapter now delegates to makeManualAdapter(), reading
the series from the valuation_manual_v1 KV blob populated by POST /valuation/manual.
The 12-adapter registry and composite math are unchanged."
```

---

## Task R6: BTC price history helper — `src/valuation/inputs/priceHistory.ts`

Needed by the rewritten `ma200w` and `piCycle` adapters. Fetches daily BTC close prices from CoinGecko's free tier (up to `max` days) and caches in KV to stay under rate limits.

**Files:**
- Create: `cloudflare-worker/src/valuation/inputs/priceHistory.ts`
- Create: `cloudflare-worker/tests/inputs/priceHistory.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/inputs/priceHistory.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BTC_PRICE_HISTORY_KV_KEY, fetchBtcPriceHistory } from "../../src/valuation/inputs/priceHistory";
import type { Env } from "../../src/lib/types";

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("fetchBtcPriceHistory", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses cached KV blob if fresh (< 12h old)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cached = [
      { timestamp: now - 86400, value: 70000 },
      { timestamp: now, value: 71000 },
    ];
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({ fetched_at: now - 600, series: cached }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const series = await fetchBtcPriceHistory(env);
    expect(series).toEqual(cached);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fetches from CoinGecko when cache is missing", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        prices: [
          [1700000000000, 30000],
          [1700086400000, 30500],
        ],
      }), { status: 200 }),
    );
    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const series = await fetchBtcPriceHistory(env);
    expect(series.length).toBe(2);
    expect(series[0].timestamp).toBe(1700000000); // ms → s
    expect(series[0].value).toBe(30000);
  });

  it("returns [] on upstream failure (no cache available)", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(new Response("", { status: 503 }));
    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const series = await fetchBtcPriceHistory(env);
    expect(series).toEqual([]);
  });

  it("refetches when cache is stale (> 12h old)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = { fetched_at: now - 86400, series: [{ timestamp: 100, value: 50000 }] };
    const kv = mockKV({ [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify(stale) });
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({
        prices: [[1700000000000, 30000]],
      }), { status: 200 }),
    );
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const series = await fetchBtcPriceHistory(env);
    expect(series[0].value).toBe(30000);
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- priceHistory`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/valuation/inputs/priceHistory.ts`:

```typescript
import type { Env } from "../../lib/types";
import type { InputReading } from "./types";

export const BTC_PRICE_HISTORY_KV_KEY = "btc_price_history_v1";
const CACHE_TTL_SECONDS = 12 * 60 * 60; // 12h
const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=max&interval=daily";

interface CachedBlob {
  fetched_at: number;
  series: InputReading[];
}

// Returns BTC daily close price series (unix seconds / USD). Uses a 12h KV cache
// to stay under CoinGecko's free-tier rate limit. Returns [] on total failure.
export async function fetchBtcPriceHistory(env: Env): Promise<InputReading[]> {
  const cached = await readCache(env.PRICES_CACHE);
  const now = Math.floor(Date.now() / 1000);
  if (cached && now - cached.fetched_at < CACHE_TTL_SECONDS) {
    return cached.series;
  }

  try {
    const res = await fetch(COINGECKO_URL);
    if (!res.ok) {
      console.error(`[priceHistory] CoinGecko HTTP ${res.status}`);
      return cached?.series ?? [];
    }
    const body = (await res.json()) as { prices?: Array<[number, number]> };
    if (!body.prices || !Array.isArray(body.prices)) return cached?.series ?? [];
    const series: InputReading[] = body.prices
      .filter(([ms, value]) => typeof ms === "number" && typeof value === "number" && Number.isFinite(value))
      .map(([ms, value]) => ({ timestamp: Math.floor(ms / 1000), value }));
    series.sort((a, b) => a.timestamp - b.timestamp);
    const blob: CachedBlob = { fetched_at: now, series };
    await env.PRICES_CACHE.put(BTC_PRICE_HISTORY_KV_KEY, JSON.stringify(blob));
    return series;
  } catch (err) {
    console.error("[priceHistory] fetch error:", err instanceof Error ? err.message : err);
    return cached?.series ?? [];
  }
}

async function readCache(kv: KVNamespace): Promise<CachedBlob | null> {
  const raw = await kv.get(BTC_PRICE_HISTORY_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CachedBlob;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- priceHistory`

Expected: all 4 cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/priceHistory.ts cloudflare-worker/tests/inputs/priceHistory.test.ts
git commit -m "feat(worker/valuation): add BTC price history helper (CoinGecko + KV cache)"
```

---

## Task R7: Rewrite `ma200w.ts` to compute from BTC price history

**Files:**
- Modify: `cloudflare-worker/src/valuation/inputs/ma200w.ts` (full rewrite)
- Modify: `cloudflare-worker/tests/inputs/ma200w.test.ts` (full rewrite)

- [ ] **Step 1: Rewrite the test**

Replace `cloudflare-worker/tests/inputs/ma200w.test.ts` with:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ma200w } from "../../src/valuation/inputs/ma200w";
import { BTC_PRICE_HISTORY_KV_KEY } from "../../src/valuation/inputs/priceHistory";
import type { Env } from "../../src/lib/types";

const DAY = 86400;

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

// Build a 1500-day synthetic series with prices given by (day_index + 1) * 10.
// 200W = 1400 days, so the 200W-MA at day N (for N >= 1399) is the average of
// days (N-1399)..N. The adapter emits (price - MA) / MA at each eligible day.
function syntheticSeries(): Array<{ timestamp: number; value: number }> {
  const series = [];
  for (let i = 0; i < 1500; i++) {
    series.push({ timestamp: 1_700_000_000 + i * DAY, value: (i + 1) * 10 });
  }
  return series;
}

describe("ma200w adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'ma_200w' and source 'derived'", () => {
    expect(ma200w.key).toBe("ma_200w");
    expect(ma200w.source).toBe("derived");
  });

  it("returns empty history if price history has < 1400 days", async () => {
    const shortSeries = [{ timestamp: 100, value: 50 }];
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({
        fetched_at: Math.floor(Date.now() / 1000),
        series: shortSeries,
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const history = await ma200w.fetchHistory(env);
    expect(history).toEqual([]);
  });

  it("emits (price - MA) / MA for each day starting at index 1399", async () => {
    const series = syntheticSeries();
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({
        fetched_at: Math.floor(Date.now() / 1000),
        series,
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const history = await ma200w.fetchHistory(env);
    // 1500 days total - 1399 warm-up = 101 output points
    expect(history.length).toBe(101);
    // At day index 1399: MA = avg of days 0..1399 = mean((1..1400)*10) = 7005
    // Price = 14000; (14000 - 7005) / 7005 ≈ 0.9986
    expect(history[0].value).toBeCloseTo((14000 - 7005) / 7005, 4);
    expect(history[0].timestamp).toBe(series[1399].timestamp);
  });

  it("fetchLatest returns the last emitted point", async () => {
    const series = syntheticSeries();
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({
        fetched_at: Math.floor(Date.now() / 1000),
        series,
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const reading = await ma200w.fetchLatest(env);
    expect(reading).not.toBeNull();
    // Day 1499: MA = avg of days 100..1499 = mean((101..1500)*10) = 8005
    // Price = 15000; (15000 - 8005) / 8005 ≈ 0.8739
    expect(reading!.value).toBeCloseTo((15000 - 8005) / 8005, 4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ma200w`

Expected: FAIL — existing impl calls LookIntoBitcoin fetch.

- [ ] **Step 3: Implement**

Replace `cloudflare-worker/src/valuation/inputs/ma200w.ts` with:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchBtcPriceHistory } from "./priceHistory";

const WINDOW_DAYS = 200 * 7; // 1400

// 200-Week Moving Average Heatmap metric: percentage deviation of the daily
// BTC close price from its 200-week (1400-day) simple moving average.
// Value formula per day: (price - MA) / MA. Positive = price above 200W MA.
export const ma200w: InputAdapter = {
  key: "ma_200w",
  label: "200-Week MA Heatmap",
  category: "market",
  source: "derived",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await computeSeries(env);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return computeSeries(env);
  },
};

async function computeSeries(env: Env): Promise<InputReading[]> {
  const prices = await fetchBtcPriceHistory(env);
  if (prices.length < WINDOW_DAYS) return [];

  const out: InputReading[] = [];
  let runningSum = 0;
  for (let i = 0; i < WINDOW_DAYS; i++) runningSum += prices[i].value;

  // First output point is at index WINDOW_DAYS - 1
  const firstMa = runningSum / WINDOW_DAYS;
  out.push({
    timestamp: prices[WINDOW_DAYS - 1].timestamp,
    value: (prices[WINDOW_DAYS - 1].value - firstMa) / firstMa,
  });

  for (let i = WINDOW_DAYS; i < prices.length; i++) {
    runningSum += prices[i].value - prices[i - WINDOW_DAYS].value;
    const ma = runningSum / WINDOW_DAYS;
    out.push({
      timestamp: prices[i].timestamp,
      value: (prices[i].value - ma) / ma,
    });
  }

  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- ma200w`

Expected: all 4 cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/ma200w.ts cloudflare-worker/tests/inputs/ma200w.test.ts
git commit -m "refactor(worker/valuation): compute 200W MA locally from BTC price history

Removes LookIntoBitcoin dependency. Uses fetchBtcPriceHistory (Task R6) as
input; O(n) sliding window over 1400-day window. Same output shape, same
zero-bias metric the previous adapter approximated."
```

---

## Task R8: Rewrite `piCycle.ts` to compute from BTC price history

**Files:**
- Modify: `cloudflare-worker/src/valuation/inputs/piCycle.ts` (full rewrite)
- Modify: `cloudflare-worker/tests/inputs/piCycle.test.ts` (full rewrite)

- [ ] **Step 1: Rewrite the test**

Replace `cloudflare-worker/tests/inputs/piCycle.test.ts` with:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { piCycle } from "../../src/valuation/inputs/piCycle";
import { BTC_PRICE_HISTORY_KV_KEY } from "../../src/valuation/inputs/priceHistory";
import type { Env } from "../../src/lib/types";

const DAY = 86400;

function mockKV(seed?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

describe("piCycle adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'pi_cycle' and source 'derived'", () => {
    expect(piCycle.key).toBe("pi_cycle");
    expect(piCycle.source).toBe("derived");
  });

  it("returns empty history if price history has < 350 days", async () => {
    const short = [{ timestamp: 100, value: 50 }];
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({
        fetched_at: Math.floor(Date.now() / 1000),
        series: short,
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    expect(await piCycle.fetchHistory(env)).toEqual([]);
  });

  it("emits (111 SMA * 2) / (350 SMA) for each eligible day", async () => {
    // Build a 400-day constant-price series at $10 each. Both MAs are 10,
    // so the ratio is (10 * 2) / 10 = 2 on every day.
    const series = Array.from({ length: 400 }, (_, i) => ({
      timestamp: 1_700_000_000 + i * DAY,
      value: 10,
    }));
    const kv = mockKV({
      [BTC_PRICE_HISTORY_KV_KEY]: JSON.stringify({
        fetched_at: Math.floor(Date.now() / 1000),
        series,
      }),
    });
    const env = { PRICES_CACHE: kv } as unknown as Env;
    const history = await piCycle.fetchHistory(env);
    expect(history.length).toBe(51); // 400 - 349 warm-up = 51
    for (const r of history) {
      expect(r.value).toBeCloseTo(2, 10);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- piCycle`

Expected: FAIL.

- [ ] **Step 3: Implement**

Replace `cloudflare-worker/src/valuation/inputs/piCycle.ts` with:

```typescript
import type { Env } from "../../lib/types";
import type { InputAdapter, InputReading } from "./types";
import { fetchBtcPriceHistory } from "./priceHistory";

const SMA_FAST = 111;
const SMA_SLOW = 350;

// PI Cycle Top Indicator: ratio of (111-day SMA × 2) / (350-day SMA).
// Historically, values approaching 1.0 from above have marked cycle tops.
// A raw ratio rather than a boolean flag so the Z-score composite can
// express the distance-to-top as a continuous signal.
export const piCycle: InputAdapter = {
  key: "pi_cycle",
  label: "PI Cycle Top Indicator",
  category: "market",
  source: "derived",

  async fetchLatest(env: Env): Promise<InputReading | null> {
    const history = await computeSeries(env);
    if (history.length === 0) return null;
    return history[history.length - 1];
  },

  async fetchHistory(env: Env): Promise<InputReading[]> {
    return computeSeries(env);
  },
};

async function computeSeries(env: Env): Promise<InputReading[]> {
  const prices = await fetchBtcPriceHistory(env);
  if (prices.length < SMA_SLOW) return [];

  const out: InputReading[] = [];
  let fastSum = 0;
  let slowSum = 0;

  // Seed both sums
  for (let i = 0; i < SMA_SLOW; i++) {
    slowSum += prices[i].value;
    if (i >= SMA_SLOW - SMA_FAST) fastSum += prices[i].value;
  }

  // First output at index SMA_SLOW - 1
  out.push({
    timestamp: prices[SMA_SLOW - 1].timestamp,
    value: ((fastSum / SMA_FAST) * 2) / (slowSum / SMA_SLOW),
  });

  for (let i = SMA_SLOW; i < prices.length; i++) {
    fastSum += prices[i].value - prices[i - SMA_FAST].value;
    slowSum += prices[i].value - prices[i - SMA_SLOW].value;
    out.push({
      timestamp: prices[i].timestamp,
      value: ((fastSum / SMA_FAST) * 2) / (slowSum / SMA_SLOW),
    });
  }

  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- piCycle`

Expected: all 3 cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/valuation/inputs/piCycle.ts cloudflare-worker/tests/inputs/piCycle.test.ts
git commit -m "refactor(worker/valuation): compute PI Cycle locally from BTC price history"
```

---

## Task R9: Manual-input handler — `POST /valuation/manual`

**Files:**
- Create: `cloudflare-worker/src/handlers/manualInput.ts`
- Create: `cloudflare-worker/tests/handlers/manualInput.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `cloudflare-worker/tests/handlers/manualInput.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { handleManualInput } from "../../src/handlers/manualInput";
import { signHmac } from "../../src/lib/hmac";
import { loadManualHistory, MANUAL_KV_KEY } from "../../src/valuation/manualStore";
import type { Env } from "../../src/lib/types";

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { return store.get(key) ?? null; },
    async put(key: string, value: string) { store.set(key, value); },
  } as unknown as KVNamespace;
}

const SECRET = "test-shared-secret";

function validBody(timestamp = "2026-04-17T14:32:00Z"): string {
  return JSON.stringify({
    submitted_at: timestamp,
    values: {
      mvrv: 2.1, puell: 0.4, sopr: 1.008, reserve_risk: 0.003,
      nvt: 85.4, hash_ribbons: 1.02, difficulty_ribbon: 0.023, hodl_waves: 0.15,
    },
  });
}

async function signedRequest(body: string, timestampHeader: string, signature?: string): Promise<Request> {
  const sig = signature ?? await signHmac(SECRET, timestampHeader, body);
  return new Request("https://w/valuation/manual", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Valuation-Timestamp": timestampHeader,
      "X-Valuation-Signature": sig,
    },
    body,
  });
}

describe("POST /valuation/manual", () => {
  it("returns 204 on valid signed submission and appends to KV", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const now = new Date().toISOString();
    const body = validBody(now);
    const req = await signedRequest(body, now);

    const res = await handleManualInput(req, env);
    expect(res.status).toBe(204);

    const history = await loadManualHistory(kv);
    expect(history.mvrv.length).toBe(1);
    expect(history.mvrv[0].value).toBeCloseTo(2.1, 10);
  });

  it("returns 401 when VALUATION_SUBMIT_HMAC is not configured", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv } as unknown as Env; // no secret
    const now = new Date().toISOString();
    const req = await signedRequest(validBody(now), now);
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 on signature mismatch", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const now = new Date().toISOString();
    const body = validBody(now);
    const req = await signedRequest(body, now, "deadbeef".repeat(8));
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 when timestamp header is absent", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const body = validBody();
    const req = new Request("https://w/valuation/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Valuation-Signature": "abc" },
      body,
    });
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 when timestamp is >5 min skewed", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const body = validBody(stale);
    const req = await signedRequest(body, stale);
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 400 on missing 'values' object", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const now = new Date().toISOString();
    const body = JSON.stringify({ submitted_at: now });
    const req = await signedRequest(body, now);
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 on missing required metric key", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const now = new Date().toISOString();
    const body = JSON.stringify({
      submitted_at: now,
      values: { mvrv: 2.1 }, // missing 7 others
    });
    const req = await signedRequest(body, now);
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 on non-finite numeric value", async () => {
    const kv = mockKV();
    const env = { PRICES_CACHE: kv, VALUATION_SUBMIT_HMAC: SECRET } as unknown as Env;
    const now = new Date().toISOString();
    const body = JSON.stringify({
      submitted_at: now,
      values: {
        mvrv: Number.NaN, puell: 0.4, sopr: 1.008, reserve_risk: 0.003,
        nvt: 85.4, hash_ribbons: 1.02, difficulty_ribbon: 0.023, hodl_waves: 0.15,
      },
    });
    const req = await signedRequest(body, now);
    const res = await handleManualInput(req, env);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- handlers/manualInput`

Expected: FAIL.

- [ ] **Step 3: Implement**

Create `cloudflare-worker/src/handlers/manualInput.ts`:

```typescript
import { CORS_HEADERS } from "../lib/cors";
import { verifyHmac } from "../lib/hmac";
import type { Env } from "../lib/types";
import { appendManualSubmission, MANUAL_METRIC_KEYS, type ManualValues } from "../valuation/manualStore";

const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

function deny(status: number, reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleManualInput(request: Request, env: Env): Promise<Response> {
  const secret = env.VALUATION_SUBMIT_HMAC;
  if (!secret) return deny(401, "valuation_submit_hmac_not_configured");

  const timestampHeader = request.headers.get("X-Valuation-Timestamp");
  const signature = request.headers.get("X-Valuation-Signature");
  if (!timestampHeader || !signature) return deny(401, "missing_signature_headers");

  const parsedTs = Date.parse(timestampHeader);
  if (!Number.isFinite(parsedTs)) return deny(401, "invalid_timestamp_header");
  if (Math.abs(Date.now() - parsedTs) > MAX_TIMESTAMP_SKEW_MS) return deny(401, "timestamp_skew_too_large");

  const body = await request.text();
  const ok = await verifyHmac(secret, timestampHeader, body, signature);
  if (!ok) return deny(401, "signature_mismatch");

  let parsed: { submitted_at?: string; values?: Partial<ManualValues> };
  try {
    parsed = JSON.parse(body);
  } catch {
    return deny(400, "invalid_json");
  }

  if (!parsed.submitted_at || typeof parsed.submitted_at !== "string") {
    return deny(400, "submitted_at_required");
  }
  if (!parsed.values || typeof parsed.values !== "object") {
    return deny(400, "values_required");
  }

  const values: Partial<ManualValues> = parsed.values;
  for (const k of MANUAL_METRIC_KEYS) {
    const v = values[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return deny(400, `invalid_value_for_${k}`);
    }
  }

  try {
    await appendManualSubmission(env.PRICES_CACHE, parsed.submitted_at, values as ManualValues);
  } catch (err) {
    console.error("[manualInput] append failed:", err instanceof Error ? err.message : err);
    return deny(503, "storage_failure");
  }

  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- handlers/manualInput`

Expected: all 8 cases pass.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/handlers/manualInput.ts cloudflare-worker/tests/handlers/manualInput.test.ts
git commit -m "feat(worker): add POST /valuation/manual with HMAC + timestamp-skew auth"
```

---

## Task R10: Wire `POST /valuation/manual` into `index.ts`

**Files:**
- Modify: `cloudflare-worker/src/index.ts`
- Modify: `cloudflare-worker/tests/router.test.ts`

- [ ] **Step 1: Extend router tests**

Add these two tests to `cloudflare-worker/tests/router.test.ts`, inside the existing `describe("router", …)`:

```typescript
it("dispatches POST /valuation/manual (rejects unsigned request)", async () => {
  const env = { PRICES_CACHE: mockKV() } as unknown as Env;
  const res = await worker.fetch(
    new Request("https://w/valuation/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    env, {} as any,
  );
  expect(res.status).toBe(401);
});

it("returns 404 on GET /valuation/manual (only POST is supported)", async () => {
  const env = { PRICES_CACHE: mockKV() } as unknown as Env;
  const res = await worker.fetch(new Request("https://w/valuation/manual"), env, {} as any);
  expect(res.status).toBe(404);
});
```

Run `npm test -- router`. Expected: FAIL — route not wired.

- [ ] **Step 2: Update `index.ts`**

Add the import:

```typescript
import { handleManualInput } from "./handlers/manualInput";
```

Add this dispatch branch immediately after the last `GET /valuation/*` branch and before the POST `/` (onramp) branch:

```typescript
if (request.method === "POST" && url.pathname === "/valuation/manual") {
  return handleManualInput(request, env);
}
```

Also expand the header comment to document the new endpoint:

```
//   POST /valuation/manual    — Treasury-signed manual metric entries (HMAC; handlers/manualInput.ts)
```

- [ ] **Step 3: Run tests + type-check**

```bash
npm test
npx tsc --noEmit
```

Expected: all router tests pass; full suite green; tsc clean.

- [ ] **Step 4: Commit**

```bash
git add cloudflare-worker/src/index.ts cloudflare-worker/tests/router.test.ts
git commit -m "feat(worker): wire POST /valuation/manual route"
```

---

## Task R11: Update `wrangler.toml` secret documentation

**Files:**
- Modify: `cloudflare-worker/wrangler.toml`

- [ ] **Step 1: Update `wrangler.toml`**

Replace the secrets-documentation comment block (and nothing else) to reflect the pivot. The file's other sections (`[triggers]`, `[[kv_namespaces]]`, `compatibility_flags`) stay unchanged.

Replace:

```toml
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

With:

```toml
# Secrets required (set via `wrangler secret put <NAME>`; never checked in):
#   CDP_KEY_NAME            — existing (Coinbase Onramp)
#   CDP_PRIVATE_KEY         — existing (Coinbase Onramp)
#   USDA_NASS_KEY           — existing (commodity prices)
#   CRYPTOQUANT_API_KEY     — valuation: miner_outflows (CryptoQuant free tier)
#   PLANB_API_KEY           — valuation: stock_to_flow (OPTIONAL — falls through
#                              to unauthenticated endpoint if unset)
#   VALUATION_SUBMIT_HMAC   — shared secret between treasury node and Worker
#                              for authenticating POST /valuation/manual
# Removed after 2026-04-17 manual-input pivot:
#   GLASSNODE_API_KEY       — 8 Glassnode metrics now manually entered via the
#                              treasury node; Worker no longer calls Glassnode.
#   LOOKINTOBITCOIN_API_KEY — 200W MA + PI Cycle now computed locally from
#                              CoinGecko price history (no API key needed).
```

- [ ] **Step 2: Verify config still parses**

Run: `cd cloudflare-worker && npm test`

Expected: full suite still green (pool-workers reads wrangler.toml on startup).

- [ ] **Step 3: Commit**

```bash
git add cloudflare-worker/wrangler.toml
git commit -m "chore(worker): document VALUATION_SUBMIT_HMAC; remove Glassnode/LookIntoBitcoin secrets"
```

---

## Task R12: Verification — full suite + end-to-end sanity

**No code changes.** Just run everything and confirm.

- [ ] **Step 1: Full test suite**

```bash
cd cloudflare-worker
npm test
npx tsc --noEmit
```

Expected: all tests pass; `tsc --noEmit` exit 0. Note the final test count (should be >= 100 — was 94 before this revision; R1 added 6, R3 added 4, R4 added 4, R6 added 4, R7 and R8 rewrote existing tests, R9 added 8, R10 added 2 ≈ +28 tests, but -8 Glassnode tests removed and 8 adapter tests shrunk to 2 cases each which is -16 ≈ net +4 from adapter rewrites).

- [ ] **Step 2: Registry consistency check**

Confirm `tests/inputs/registry.test.ts` still passes — all 12 adapters present, all keys match `INPUT_WEIGHTS`.

- [ ] **Step 3: Manual exploratory smoke**

Start a dev instance with a local test secret:

```bash
export VALUATION_SUBMIT_HMAC=test-secret
cd cloudflare-worker
npx wrangler dev --var VALUATION_SUBMIT_HMAC:test-secret
```

In another terminal, send a signed POST:

```bash
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
BODY='{"submitted_at":"'$TS'","values":{"mvrv":2.1,"puell":0.4,"sopr":1.008,"reserve_risk":0.003,"nvt":85.4,"hash_ribbons":1.02,"difficulty_ribbon":0.023,"hodl_waves":0.15}}'
BODY_HASH=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANONICAL=$(printf '%s\n%s' "$TS" "$BODY_HASH")
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac 'test-secret' -hex | awk '{print $2}')

curl -i -X POST http://localhost:8787/valuation/manual \
  -H "Content-Type: application/json" \
  -H "X-Valuation-Timestamp: $TS" \
  -H "X-Valuation-Signature: $SIG" \
  -d "$BODY"
```

Expected: `HTTP/1.1 204 No Content`.

Fire the scheduled handler once:

```bash
curl "http://localhost:8787/__scheduled?cron=15+0+*+*+*"
curl -s http://localhost:8787/valuation/current | jq .
```

The response should include `z_score`, `zone`, `multiplier`. The 8 manually-entered metrics will have contribution 0 to the composite (only one reading, stdev=0) — that's expected; fidelity grows as more daily submissions accumulate.

- [ ] **Step 4: Commit nothing**

This task is verification-only. Do not make a "verification" commit.

Plan 1-revision complete. Proceed to Plan 1b (treasury-side manual-entry UI + notification).

---

## Self-review checklist (already performed)

- **Spec coverage**: §4.1 ingestion column → R5 (manualInput delegations) + R7/R8 (local compute). §4.5 secrets → R2 (Env) + R11 (wrangler.toml). §4.6 manual-input workflow → R3 (KV store) + R4 (adapter factory) + R9 (handler) + R10 (router).
- **Placeholder scan**: no TBD / TODO / "Similar to Task N" cross-references.
- **Type consistency**: `MANUAL_METRIC_KEYS` declared once in R3 and referenced in R4, R5, R9. `canonicalString` / `signHmac` / `verifyHmac` defined once in R1, consumed in R9 handler tests. `InputReading` shape unchanged from original plan.
- **Registry consistency**: 12-adapter registry test (unchanged since Task 19) serves as the invariant guard — if any R5 adapter rename broke the registry, that test fails.
