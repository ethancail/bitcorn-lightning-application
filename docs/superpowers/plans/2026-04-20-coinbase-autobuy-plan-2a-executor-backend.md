# Coinbase Auto-Buy — Plan 2a: Executor Backend (Node API)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Node-side backend for Coinbase Auto-Buy — migration, credential vault, Coinbase Advanced Trade v3 client, safety caps, valuation Worker proxy, scheduler with the 5-step state machine, and 12 API routes (9 `/api/autobuy/*` + 3 `/api/valuation/*` proxies). End state: you can curl the backend + drive a full scheduled-buy → fill → sweep → withdraw-confirmed flow end-to-end, but there is no UI yet (that's Plan 2b).

**Architecture:** Thin modules under `app/api/src/autoBuy/`. Scheduler runs on a `setInterval(tick, 15 * 60 * 1000)` started from `src/index.ts`. Each tick executes 5 atomic steps over `autobuy_runs` / `autobuy_sweeps` rows; any uncaught error inside a step is logged and the step short-circuits (the next tick retries). Credentials encrypted at rest with AES-256-GCM using an HKDF-derived key from the existing `/data/secrets/master.key`. Auth is the existing role-gating pattern: `assertNonEmpty(node?.node_role)` — both treasury AND member nodes run auto-buy (per spec §5.6 amendment).

**Tech Stack:** TypeScript on Node 20, `better-sqlite3`, raw `http.createServer` routing (same as everything else in `app/api`), `jose` (new dep, matches the Worker's JWT signing pattern for CDP ES256 keys), Node stdlib `crypto` for HMAC/HKDF/AES-GCM.

---

## Context for the engineer

- Plan 1 (Worker valuation engine) + Plan 1-revision (manual-input pivot) + Plan 1b (treasury manual-entry UI) are all shipped on branch `feature/coinbase-auto-buy` (PR #106 to `develop`).
- This plan's branch is `feature/coinbase-autobuy-executor`, forked from `feature/coinbase-auto-buy` HEAD. The spec amendment for Plan 2 landed in commit `f47ae5e`.
- Spec reference: `docs/superpowers/specs/2026-04-17-coinbase-auto-buy-design.md` §5 (data model, state machine, caps, credentials, Coinbase client, routes). Read it once end-to-end before starting.
- `CLAUDE.md` applies. Key rules: commit frequently, do not push without explicit approval, never skip hooks, follow the existing raw-http routing pattern in `app/api/src/index.ts`.
- **No automated test suite for `app/api`** per repo convention (CLAUDE.md: "No automated test suite yet"). Each task's verification is `npm run build` (catches TypeScript errors) + an optional curl smoke-test where meaningful. Plan 1b established this pattern; we follow it here.
- Coinbase Advanced Trade v3 API uses **ES256 JWTs** signed with the operator's Cloud Key private key (SEC1 PEM format). Claims: `{ sub: key_name, iss: "cdp", nbf, exp: nbf+120, uri: "<METHOD> api.coinbase.com<path>" }`. Same shape as the Worker's Onramp JWT in `cloudflare-worker/src/handlers/onramp.ts`.

## File structure after this plan

```
app/api/
├── package.json                                        (modified: add jose dep)
├── src/
│   ├── config/env.ts                                  (modified: add 7 AUTOBUY_* env vars)
│   ├── db/migrations/034_coinbase_autobuy.sql         (new)
│   ├── autoBuy/
│   │   ├── credentials.ts                             (new: AES-256-GCM + HKDF)
│   │   ├── coinbaseClient.ts                          (new: ES256 JWT + 5 API ops)
│   │   ├── caps.ts                                    (new: 7 env-based safety checks)
│   │   ├── valuationClient.ts                         (new: Worker proxy + 60-min cache)
│   │   └── scheduler.ts                               (new: 15-min tick + state machine)
│   └── index.ts                                       (modified: start scheduler + 12 new routes)
```

No changes to `app/web`, the Worker, or any existing module's behaviour. Treasury alerts are NOT modified — auto-buy surfaces its own paused-state via `GET /api/autobuy/status` and the Plan 2b UI will read it directly.

---

## Task 1: Migration 034 — autobuy tables

**Files:**
- Create: `app/api/src/db/migrations/034_coinbase_autobuy.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- 034_coinbase_autobuy.sql — Coinbase Auto-Buy Executor tables.
--
-- Four tables: credentials (singleton encrypted Cloud Key), config (singleton
-- per-node settings + runtime state), runs (one row per scheduled buy, moves
-- through the state machine), sweeps (one row per weekly withdraw batch).
--
-- Numbered 034 because 028–033 are taken by unrelated migrations that landed
-- while this feature was on a branch (advisor_min_channel_capacity through
-- valuation_manual_inputs).

CREATE TABLE IF NOT EXISTS coinbase_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  key_name TEXT NOT NULL,
  encrypted_private_key BLOB NOT NULL,
  nonce BLOB NOT NULL,
  connected_at INTEGER NOT NULL,
  last_verified_at INTEGER
);

CREATE TABLE IF NOT EXISTS autobuy_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  base_unit_usd REAL NOT NULL DEFAULT 100,
  frequency TEXT NOT NULL DEFAULT 'weekly',
  zone_multipliers TEXT NOT NULL DEFAULT '{"extreme_buy":3,"undervalued":2,"fair_value":1,"elevated":0.5,"overvalued":0.25,"extreme_sell":0}',
  withdraw_address TEXT NOT NULL DEFAULT '',
  withdraw_address_whitelisted_at INTEGER,
  sweep_day_of_week INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  last_run_at INTEGER,
  next_run_at INTEGER
);

-- Seed the singleton config row with defaults. The withdraw_address stays
-- empty until the first GET /api/autobuy/status call generates one via
-- createLndChainAddress() (done in business logic, not in this migration).
INSERT OR IGNORE INTO autobuy_config (id) VALUES (1);

CREATE TABLE IF NOT EXISTS autobuy_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scheduled_for INTEGER NOT NULL,
  z_score REAL,
  zone TEXT,
  multiplier REAL,
  base_unit_usd REAL,
  intended_buy_usd REAL,
  status TEXT NOT NULL,
  coinbase_order_id TEXT,
  filled_btc REAL,
  filled_usd REAL,
  filled_at INTEGER,
  withdraw_txid TEXT,
  withdraw_sweep_id INTEGER,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autobuy_runs_status
  ON autobuy_runs(status);
CREATE INDEX IF NOT EXISTS idx_autobuy_runs_scheduled
  ON autobuy_runs(scheduled_for);

CREATE TABLE IF NOT EXISTS autobuy_sweeps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  swept_at INTEGER NOT NULL,
  btc_amount REAL NOT NULL,
  coinbase_tx_id TEXT,
  withdraw_txid TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_autobuy_sweeps_status
  ON autobuy_sweeps(status);
```

- [ ] **Step 2: Build to confirm migration runner picks it up**

Run:

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean TS build. Migrations auto-run on API startup via the existing migration runner (see `src/db/migrations.ts` — it reads every `.sql` file in the `migrations/` directory in lexical order).

- [ ] **Step 3: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/src/db/migrations/034_coinbase_autobuy.sql
git commit -m "feat(api): migration 034 — coinbase_credentials/config/runs/sweeps"
```

---

## Task 2: Env config — 7 AUTOBUY_* variables

**Files:**
- Modify: `app/api/src/config/env.ts`

- [ ] **Step 1: Add env fields**

Open `app/api/src/config/env.ts`. Locate the `// --- Valuation manual input ...` block added in Plan 1b B2. Immediately AFTER that block (before the closing `};`), add:

```typescript
    // --- Coinbase Auto-Buy Executor ---
    // Global kill switch. When false, the scheduler refuses to create any
    // scheduled rows. Default false so a fresh install doesn't start buying
    // until the operator explicitly enables via POST /api/autobuy/enable.
    autoBuyEnabled: process.env.AUTOBUY_ENABLED === "true",
    // Max USD per single scheduled buy. Caps the result of
    // base_unit × multiplier. Row transitions to skipped_cap_hit on breach.
    autoBuyMaxSingleBuyUsd: Number(process.env.AUTOBUY_MAX_SINGLE_BUY_USD ?? "1000"),
    // Rolling 7-day cap on filled_usd across all completed runs.
    autoBuyMax7dUsd: Number(process.env.AUTOBUY_MAX_7D_USD ?? "2000"),
    // Rolling 30-day cap.
    autoBuyMax30dUsd: Number(process.env.AUTOBUY_MAX_30D_USD ?? "5000"),
    // Max base_unit the user can set via PATCH /api/autobuy/config.
    // Prevents a UI typo from setting $1,000,000 as the base.
    autoBuyBaseUnitMaxUsd: Number(process.env.AUTOBUY_BASE_UNIT_MAX_USD ?? "500"),
    // If the Worker's /valuation/current.updated_at is older than this many
    // hours, the scheduler refuses to buy (row → skipped_stale_data).
    autoBuyStaleDataMaxHours: Number(process.env.AUTOBUY_STALE_DATA_MAX_HOURS ?? "48"),
    // Auto-pause after N consecutive failed_buy or failed_withdraw transitions.
    // Operator must click Resume to re-enable. Reset on any successful sweep.
    autoBuyFailurePauseThreshold: Number(process.env.AUTOBUY_FAILURE_PAUSE_THRESHOLD ?? "3"),
```

- [ ] **Step 2: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/src/config/env.ts
git commit -m "feat(api/config): add 7 AUTOBUY_* env vars (caps + kill switch)"
```

---

## Task 3: Credential vault — `src/autoBuy/credentials.ts`

AES-256-GCM encryption of Coinbase Cloud Key PEM, with HKDF-derived key from `/data/secrets/master.key`.

**Files:**
- Create: `app/api/src/autoBuy/credentials.ts`

- [ ] **Step 1: Implement**

Create `app/api/src/autoBuy/credentials.ts`:

```typescript
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

// The same master key used elsewhere in the app (e.g. JWT signing). Generated
// on first API run with 32 random bytes and stored at this path. If it doesn't
// exist (fresh install before any other module touched it), we create it here
// rather than silently failing.
const MASTER_KEY_PATH = "/data/secrets/master.key";

// HKDF "info" context string — domain-separates the auto-buy credential key
// from any other key derived from the same master secret. Changing this
// string invalidates all previously-encrypted blobs.
const HKDF_INFO = "coinbase-autobuy";

function loadOrCreateMasterKey(): Buffer {
  if (existsSync(MASTER_KEY_PATH)) {
    const buf = readFileSync(MASTER_KEY_PATH);
    if (buf.length < 16) {
      throw new Error(`[credentials] master key at ${MASTER_KEY_PATH} is too short (got ${buf.length} bytes)`);
    }
    return buf;
  }
  // First run — create a 32-byte secret and persist it with restrictive mode.
  const dir = dirname(MASTER_KEY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(MASTER_KEY_PATH, key, { mode: 0o600 });
  console.log(`[credentials] initialized master key at ${MASTER_KEY_PATH}`);
  return key;
}

// HKDF-SHA256 extract-then-expand. Node 15+ has crypto.hkdfSync, but we
// implement by hand to avoid version-gating and to make the derivation
// explicit for code review.
function hkdfSha256(masterKey: Buffer, info: string, lengthBytes: number): Buffer {
  // Extract: PRK = HMAC-SHA256(salt=0*32, IKM=masterKey)
  const salt = Buffer.alloc(32, 0);
  const prk = createHmac("sha256", salt).update(masterKey).digest();
  // Expand: T(1) = HMAC-SHA256(PRK, info || 0x01), output first lengthBytes bytes
  const infoBuf = Buffer.from(info, "utf8");
  const t1 = createHmac("sha256", prk).update(Buffer.concat([infoBuf, Buffer.from([0x01])])).digest();
  return t1.subarray(0, lengthBytes);
}

let cachedKey: Buffer | null = null;
function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;
  const master = loadOrCreateMasterKey();
  cachedKey = hkdfSha256(master, HKDF_INFO, 32);
  return cachedKey;
}

export interface EncryptedBlob {
  ciphertext: Buffer; // ciphertext || authTag  (GCM convention)
  nonce: Buffer;      // 12 bytes
}

/**
 * Encrypt a plaintext PEM. Returns ciphertext (with appended 16-byte auth
 * tag) and a fresh 12-byte nonce. Caller persists both in the DB row.
 */
export function encrypt(plaintext: string): EncryptedBlob {
  const key = getEncryptionKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, authTag]), nonce };
}

/**
 * Decrypt a blob. Throws "credentials_corrupted" if the auth tag doesn't
 * verify — the caller (route handler) maps that to a 500 response that
 * prompts the operator to reconnect their Coinbase credentials.
 */
export function decrypt(blob: EncryptedBlob): string {
  const key = getEncryptionKey();
  if (blob.ciphertext.length < 16) {
    throw new Error("credentials_corrupted");
  }
  const authTag = blob.ciphertext.subarray(blob.ciphertext.length - 16);
  const enc = blob.ciphertext.subarray(0, blob.ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, blob.nonce);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("credentials_corrupted");
  }
}

// Helper for debugging — NEVER call this in a running API. Returns a hash of
// the master key so you can compare across runs without exposing it.
export function masterKeyFingerprint(): string {
  return createHash("sha256").update(loadOrCreateMasterKey()).digest("hex").slice(0, 16);
}
```

- [ ] **Step 2: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/src/autoBuy/credentials.ts
git commit -m "feat(api/autoBuy): add AES-256-GCM credential vault (HKDF from master.key)"
```

---

## Task 4: Coinbase Advanced Trade v3 client — `src/autoBuy/coinbaseClient.ts`

Adds `jose` as a dep (used for ES256 JWT signing). Wraps 5 Coinbase API operations.

**Files:**
- Modify: `app/api/package.json` (add jose)
- Create: `app/api/src/autoBuy/coinbaseClient.ts`

- [ ] **Step 1: Add `jose` dependency**

Run:

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm install --save jose@^5.0.0
```

Expected: `package.json` + `package-lock.json` updated to include `jose` at ^5.0.0 (same version the Worker uses).

- [ ] **Step 2: Implement the client**

Create `app/api/src/autoBuy/coinbaseClient.ts`:

```typescript
import { createPrivateKey } from "crypto";
import { SignJWT } from "jose";

const API_HOST = "api.coinbase.com";
const BASE_URL = `https://${API_HOST}`;

export interface CoinbaseCredentials {
  keyName: string;    // e.g. "organizations/abc/apiKeys/xyz"
  privateKeyPem: string; // SEC1 or PKCS#8 PEM, BEGIN [EC] PRIVATE KEY
}

export interface CoinbaseAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: { value: string; currency: string };
}

export interface PlaceOrderResult {
  order_id: string;
}

export interface PolledOrder {
  order_id: string;
  status: "OPEN" | "FILLED" | "CANCELLED" | "EXPIRED" | "FAILED" | "PENDING";
  filled_size: string;      // BTC amount
  filled_value: string;     // USD value
  filled_at?: string;
}

export interface PlaceWithdrawResult {
  transaction_id: string;
}

export interface PolledWithdraw {
  transaction_id: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  network_tx_hash?: string;
}

// ───────────────────────────────────────────────────────────────────────
// JWT signing
// ───────────────────────────────────────────────────────────────────────

async function signJwt(creds: CoinbaseCredentials, method: string, path: string): Promise<string> {
  // Node's createPrivateKey handles both SEC1 ("BEGIN EC PRIVATE KEY") and
  // PKCS#8 ("BEGIN PRIVATE KEY") PEMs directly — no SEC1→PKCS#8 conversion
  // needed (that workaround only existed in the Worker because Web Crypto
  // only accepts PKCS#8).
  const keyObj = createPrivateKey({ key: creds.privateKeyPem, format: "pem" });
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: creds.keyName,
    iss: "cdp",
    nbf: now,
    exp: now + 120,
    uri: `${method} ${API_HOST}${path}`,
  })
    .setProtectedHeader({ alg: "ES256", kid: creds.keyName, typ: "JWT" })
    .sign(keyObj);
}

// ───────────────────────────────────────────────────────────────────────
// HTTP helper
// ───────────────────────────────────────────────────────────────────────

async function coinbaseRequest<T>(
  creds: CoinbaseCredentials,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; error: string }> {
  const jwt = await signJwt(creds, method, path);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: text.slice(0, 500) };
    }
    if (text === "") {
      return { ok: true, status: res.status, data: undefined as unknown as T };
    }
    try {
      return { ok: true, status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { ok: false, status: res.status, error: `non_json_response: ${text.slice(0, 200)}` };
    }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ───────────────────────────────────────────────────────────────────────
// Operations used by the scheduler
// ───────────────────────────────────────────────────────────────────────

/**
 * Verify credentials work. Returns the full account list on success.
 * Called from POST /api/autobuy/credentials/verify and from the scheduler
 * before each buy to fetch USD + BTC account UUIDs and balances.
 */
export async function listAccounts(creds: CoinbaseCredentials) {
  return coinbaseRequest<{ accounts: CoinbaseAccount[] }>(creds, "GET", "/api/v3/brokerage/accounts");
}

/**
 * Place a market BUY order for the given USD amount (quote_size).
 * Returns the Coinbase order_id on success. Uses a random client_order_id
 * to prevent accidental duplicate fills on retry.
 */
export async function placeMarketBuy(
  creds: CoinbaseCredentials,
  quoteSizeUsd: number,
): Promise<{ ok: true; order_id: string } | { ok: false; status: number; error: string }> {
  const clientOrderId = `autobuy-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const body = {
    client_order_id: clientOrderId,
    product_id: "BTC-USD",
    side: "BUY",
    order_configuration: {
      market_market_ioc: { quote_size: quoteSizeUsd.toFixed(2) },
    },
  };
  const res = await coinbaseRequest<{
    success: boolean;
    order_id?: string;
    success_response?: { order_id: string };
    error_response?: { error: string; message?: string };
  }>(creds, "POST", "/api/v3/brokerage/orders", body);
  if (!res.ok) return res;
  const orderId = res.data.order_id || res.data.success_response?.order_id;
  if (!orderId) {
    const err = res.data.error_response?.message || res.data.error_response?.error || "no_order_id_in_response";
    return { ok: false, status: 200, error: err };
  }
  return { ok: true, order_id: orderId };
}

/**
 * Poll a previously-placed order. Returns normalized status + filled amounts.
 */
export async function pollOrder(
  creds: CoinbaseCredentials,
  orderId: string,
): Promise<{ ok: true; order: PolledOrder } | { ok: false; status: number; error: string }> {
  const res = await coinbaseRequest<{ order: PolledOrder }>(
    creds,
    "GET",
    `/api/v3/brokerage/orders/historical/${encodeURIComponent(orderId)}`,
  );
  if (!res.ok) return res;
  return { ok: true, order: res.data.order };
}

/**
 * Withdraw BTC from the Coinbase BTC account to an on-chain address. Uses
 * the /v2 transactions endpoint with type=send. The BTC account UUID comes
 * from listAccounts() output.
 */
export async function placeWithdraw(
  creds: CoinbaseCredentials,
  btcAccountId: string,
  toAddress: string,
  btcAmount: number,
): Promise<{ ok: true; transaction_id: string } | { ok: false; status: number; error: string }> {
  const body = {
    type: "send",
    to: toAddress,
    amount: btcAmount.toFixed(8),
    currency: "BTC",
  };
  const res = await coinbaseRequest<{ data: { id: string } }>(
    creds,
    "POST",
    `/v2/accounts/${encodeURIComponent(btcAccountId)}/transactions`,
    body,
  );
  if (!res.ok) return res;
  return { ok: true, transaction_id: res.data.data.id };
}

/**
 * Poll a previously-placed withdraw transaction for confirmation status.
 */
export async function pollWithdraw(
  creds: CoinbaseCredentials,
  btcAccountId: string,
  transactionId: string,
): Promise<{ ok: true; withdraw: PolledWithdraw } | { ok: false; status: number; error: string }> {
  const res = await coinbaseRequest<{
    data: { id: string; status: string; network?: { hash?: string } };
  }>(
    creds,
    "GET",
    `/v2/accounts/${encodeURIComponent(btcAccountId)}/transactions/${encodeURIComponent(transactionId)}`,
  );
  if (!res.ok) return res;
  const normalized: PolledWithdraw = {
    transaction_id: res.data.data.id,
    status: res.data.data.status as PolledWithdraw["status"],
    network_tx_hash: res.data.data.network?.hash,
  };
  return { ok: true, withdraw: normalized };
}
```

- [ ] **Step 3: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/package.json app/api/package-lock.json app/api/src/autoBuy/coinbaseClient.ts
git commit -m "feat(api/autoBuy): add Coinbase Advanced Trade v3 client (jose + 5 ops)"
```

---

## Task 5: Safety caps — `src/autoBuy/caps.ts`

Pure functions that read from `ENV` + the DB and return `{ ok: true } | { ok: false, reason: string }`.

**Files:**
- Create: `app/api/src/autoBuy/caps.ts`

- [ ] **Step 1: Implement**

Create `app/api/src/autoBuy/caps.ts`:

```typescript
import type Database from "better-sqlite3";
import { ENV } from "../config/env";

export type CapResult = { ok: true } | { ok: false; reason: string };

/**
 * Can the scheduler create ANY new scheduled row? Checks:
 *  - env-level kill switch (AUTOBUY_ENABLED)
 *  - per-node enabled flag in autobuy_config
 *  - no pending paused_reason
 *  - consecutive-failure threshold
 */
export function canSchedule(db: Database.Database): CapResult {
  if (!ENV.autoBuyEnabled) return { ok: false, reason: "env_kill_switch" };
  const cfg = db.prepare(`SELECT enabled, paused_reason, consecutive_failures FROM autobuy_config WHERE id = 1`)
    .get() as { enabled: number; paused_reason: string | null; consecutive_failures: number } | undefined;
  if (!cfg) return { ok: false, reason: "config_missing" };
  if (cfg.enabled !== 1) return { ok: false, reason: "disabled" };
  if (cfg.paused_reason) return { ok: false, reason: `paused:${cfg.paused_reason}` };
  if (cfg.consecutive_failures >= ENV.autoBuyFailurePauseThreshold) {
    return { ok: false, reason: "failure_threshold_exceeded" };
  }
  return { ok: true };
}

/**
 * Is the intended per-run USD amount under the hard cap?
 */
export function checkSingleBuyCap(intendedUsd: number): CapResult {
  if (intendedUsd > ENV.autoBuyMaxSingleBuyUsd) {
    return { ok: false, reason: `single_buy_cap:${intendedUsd}>${ENV.autoBuyMaxSingleBuyUsd}` };
  }
  return { ok: true };
}

/**
 * Is the rolling 7-day + 30-day filled spend under the cap if we add this
 * intended amount? Sums filled_usd from rows in states that represent actual
 * spend (buy_filled and later; skipped_* and failed_* don't count per spec §5.2).
 */
export function checkRollingCaps(db: Database.Database, intendedUsd: number): CapResult {
  const nowSec = Math.floor(Date.now() / 1000);
  const countedStates = ["buy_filled", "awaiting_withdraw_hold", "sweep_assigned", "withdraw_placed", "withdraw_confirmed"];
  const placeholders = countedStates.map(() => "?").join(",");

  const row7 = db.prepare(
    `SELECT COALESCE(SUM(filled_usd), 0) AS total
     FROM autobuy_runs
     WHERE status IN (${placeholders}) AND filled_at >= ?`,
  ).get(...countedStates, nowSec - 7 * 86400) as { total: number };
  if (row7.total + intendedUsd > ENV.autoBuyMax7dUsd) {
    return { ok: false, reason: `7d_cap:${(row7.total + intendedUsd).toFixed(2)}>${ENV.autoBuyMax7dUsd}` };
  }

  const row30 = db.prepare(
    `SELECT COALESCE(SUM(filled_usd), 0) AS total
     FROM autobuy_runs
     WHERE status IN (${placeholders}) AND filled_at >= ?`,
  ).get(...countedStates, nowSec - 30 * 86400) as { total: number };
  if (row30.total + intendedUsd > ENV.autoBuyMax30dUsd) {
    return { ok: false, reason: `30d_cap:${(row30.total + intendedUsd).toFixed(2)}>${ENV.autoBuyMax30dUsd}` };
  }

  return { ok: true };
}

/**
 * Is the requested base_unit_usd (from a user PATCH request) under the hard cap?
 */
export function checkBaseUnitCap(proposedUsd: number): CapResult {
  if (proposedUsd > ENV.autoBuyBaseUnitMaxUsd) {
    return { ok: false, reason: `base_unit_cap:${proposedUsd}>${ENV.autoBuyBaseUnitMaxUsd}` };
  }
  return { ok: true };
}

/**
 * Is the Worker's composite valuation fresh enough? updatedAtISO is the
 * updated_at field from /valuation/current. Stale threshold lives in env.
 */
export function checkValuationFreshness(updatedAtISO: string): CapResult {
  const updatedAt = Date.parse(updatedAtISO);
  if (!Number.isFinite(updatedAt)) {
    return { ok: false, reason: "invalid_updated_at" };
  }
  const ageHours = (Date.now() - updatedAt) / (1000 * 60 * 60);
  if (ageHours > ENV.autoBuyStaleDataMaxHours) {
    return { ok: false, reason: `stale_data:${ageHours.toFixed(1)}h>${ENV.autoBuyStaleDataMaxHours}h` };
  }
  return { ok: true };
}

/**
 * On a failed_* transition, increment the counter and auto-pause if threshold
 * hit. Returns the new count.
 */
export function recordFailure(db: Database.Database): { consecutive_failures: number; paused: boolean } {
  const row = db.prepare(
    `UPDATE autobuy_config
     SET consecutive_failures = consecutive_failures + 1,
         paused_reason = CASE
           WHEN consecutive_failures + 1 >= ? THEN 'consecutive_failures'
           ELSE paused_reason
         END,
         enabled = CASE
           WHEN consecutive_failures + 1 >= ? THEN 0
           ELSE enabled
         END
     WHERE id = 1
     RETURNING consecutive_failures, paused_reason`,
  ).get(ENV.autoBuyFailurePauseThreshold, ENV.autoBuyFailurePauseThreshold) as
    | { consecutive_failures: number; paused_reason: string | null }
    | undefined;
  if (!row) return { consecutive_failures: 0, paused: false };
  return {
    consecutive_failures: row.consecutive_failures,
    paused: row.paused_reason === "consecutive_failures",
  };
}

/**
 * On a successful sweep/withdraw, reset the failure counter.
 */
export function resetFailureCounter(db: Database.Database): void {
  db.prepare(`UPDATE autobuy_config SET consecutive_failures = 0 WHERE id = 1`).run();
}
```

- [ ] **Step 2: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/src/autoBuy/caps.ts
git commit -m "feat(api/autoBuy): add safety caps module (6 checks + failure counter)"
```

---

## Task 6: Valuation Worker proxy — `src/autoBuy/valuationClient.ts`

Proxies Worker `/valuation/*` with a 60-min in-memory cache (same pattern as `/api/commodity-prices`).

**Files:**
- Create: `app/api/src/autoBuy/valuationClient.ts`

- [ ] **Step 1: Implement**

Create `app/api/src/autoBuy/valuationClient.ts`:

```typescript
import { ENV } from "../config/env";

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 min

interface CacheEntry<T> {
  value: T;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

export interface CurrentValuation {
  z_score: number;
  zone: string;
  multiplier: number;
  updated_at: string;
  price_usd: number;
}

export interface HistoryRow {
  date: string;
  z_score: number;
  zone: string;
  price_usd: number;
}

export interface InputSnapshot {
  value: number;
  z: number;
  weight: number;
  updated_at: string;
}

async function fetchAndCache<T>(key: string, url: string): Promise<T | null> {
  const hit = cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) {
    return hit.value;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[valuationClient] ${url} → HTTP ${res.status}`);
      return hit?.value ?? null; // stale fallback on upstream failure
    }
    const value = (await res.json()) as T;
    cache.set(key, { value, cachedAt: Date.now() });
    return value;
  } catch (err) {
    console.error(`[valuationClient] ${url} fetch error:`, err instanceof Error ? err.message : err);
    return hit?.value ?? null;
  }
}

function workerBase(): string | null {
  return ENV.valuationWorkerUrl || ENV.coinbaseWorkerUrl || null;
}

/**
 * Latest composite valuation. Returns null on upstream failure with no cache.
 * Callers (scheduler) should treat null as "skip this tick".
 */
export async function getCurrent(): Promise<CurrentValuation | null> {
  const base = workerBase();
  if (!base) return null;
  return fetchAndCache<CurrentValuation>("current", `${base}/valuation/current`);
}

/**
 * Composite history series. The optional query params are passed through to
 * the Worker; cache key folds them so different ranges are cached separately.
 */
export async function getHistory(sinceISO?: string, untilISO?: string): Promise<{ series: HistoryRow[] } | null> {
  const base = workerBase();
  if (!base) return null;
  const qs = new URLSearchParams();
  if (sinceISO) qs.set("since", sinceISO);
  if (untilISO) qs.set("until", untilISO);
  const suffix = qs.toString();
  const url = `${base}/valuation/history${suffix ? `?${suffix}` : ""}`;
  return fetchAndCache<{ series: HistoryRow[] }>(`history:${suffix}`, url);
}

/**
 * Per-input snapshot map (12 keys).
 */
export async function getInputs(): Promise<Record<string, InputSnapshot> | null> {
  const base = workerBase();
  if (!base) return null;
  return fetchAndCache<Record<string, InputSnapshot>>("inputs", `${base}/valuation/inputs`);
}

/**
 * For tests and debugging only. Clears the in-memory cache so the next call
 * will refetch.
 */
export function resetCacheForTest(): void {
  cache.clear();
}
```

- [ ] **Step 2: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/src/autoBuy/valuationClient.ts
git commit -m "feat(api/autoBuy): add valuation Worker proxy (60-min cache + fallback)"
```

---

## Task 7: Scheduler + state machine — `src/autoBuy/scheduler.ts`

The orchestrator. `startScheduler(db)` begins a 15-min tick. Each tick runs 5 steps in order and returns; any error inside a step is logged and the step short-circuits (next tick retries).

**Files:**
- Create: `app/api/src/autoBuy/scheduler.ts`

- [ ] **Step 1: Implement**

Create `app/api/src/autoBuy/scheduler.ts`:

```typescript
import type Database from "better-sqlite3";
import { createLndChainAddress } from "../lightning/lnd";
import * as caps from "./caps";
import {
  listAccounts,
  placeMarketBuy,
  placeWithdraw,
  pollOrder,
  pollWithdraw,
  type CoinbaseCredentials,
} from "./coinbaseClient";
import { decrypt } from "./credentials";
import { getCurrent } from "./valuationClient";

const TICK_INTERVAL_MS = 15 * 60 * 1000;
const SWEEP_MIN_BTC = 0.0001;
const WITHDRAW_HOLD_SECONDS = 72 * 3600;

// ───────────────────────────────────────────────────────────────────────
// Public entry point
// ───────────────────────────────────────────────────────────────────────

let tickHandle: ReturnType<typeof setInterval> | null = null;

export function startScheduler(db: Database.Database): void {
  if (tickHandle) return; // already running
  // Delay the first tick 30s so the API has time to finish startup, LND
  // connection is ready, etc.
  setTimeout(() => { runTickSafe(db); }, 30_000);
  tickHandle = setInterval(() => { runTickSafe(db); }, TICK_INTERVAL_MS);
  console.log("[autobuy-scheduler] started (15-min tick)");
}

export function stopScheduler(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

async function runTickSafe(db: Database.Database): Promise<void> {
  try {
    await runTick(db);
  } catch (err) {
    console.error("[autobuy-scheduler] tick failed:", err instanceof Error ? err.stack : err);
  }
}

// Exposed for POST /api/autobuy/execute-now to trigger an out-of-band tick.
export async function runTick(db: Database.Database): Promise<void> {
  await stepEnqueueAndPlaceBuy(db);
  await stepPollBuyPlaced(db);
  await stepAssignToSweep(db);
  await stepRunSweep(db);
  await stepPollWithdraws(db);
}

// ───────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function loadCredentials(db: Database.Database): CoinbaseCredentials | null {
  const row = db.prepare(
    `SELECT key_name, encrypted_private_key, nonce FROM coinbase_credentials WHERE id = 1`,
  ).get() as { key_name: string; encrypted_private_key: Buffer; nonce: Buffer } | undefined;
  if (!row) return null;
  try {
    const privateKeyPem = decrypt({ ciphertext: row.encrypted_private_key, nonce: row.nonce });
    return { keyName: row.key_name, privateKeyPem };
  } catch {
    // credentials_corrupted — flag via paused_reason and return null
    db.prepare(`UPDATE autobuy_config SET enabled = 0, paused_reason = 'credentials_corrupted' WHERE id = 1`).run();
    return null;
  }
}

function pauseWithReason(db: Database.Database, reason: string): void {
  db.prepare(`UPDATE autobuy_config SET enabled = 0, paused_reason = ? WHERE id = 1`).run(reason);
}

function readConfig(db: Database.Database) {
  return db.prepare(`SELECT * FROM autobuy_config WHERE id = 1`).get() as {
    id: number;
    enabled: number;
    base_unit_usd: number;
    frequency: string;
    zone_multipliers: string;
    withdraw_address: string;
    withdraw_address_whitelisted_at: number | null;
    sweep_day_of_week: number;
    consecutive_failures: number;
    paused_reason: string | null;
    last_run_at: number | null;
    next_run_at: number | null;
  };
}

function frequencyToSeconds(frequency: string): number {
  switch (frequency) {
    case "daily": return 86400;
    case "weekly": return 7 * 86400;
    case "biweekly": return 14 * 86400;
    case "monthly": return 30 * 86400;
    default: return 7 * 86400;
  }
}

function computeIntendedBuy(baseUnit: number, multiplier: number): number {
  return Math.round(baseUnit * multiplier * 100) / 100;
}

// ───────────────────────────────────────────────────────────────────────
// Step 1: Enqueue scheduled + place buy
// ───────────────────────────────────────────────────────────────────────

async function stepEnqueueAndPlaceBuy(db: Database.Database): Promise<void> {
  const gate = caps.canSchedule(db);
  if (!gate.ok) return; // not enabled / paused / over failure threshold

  const cfg = readConfig(db);
  if (!cfg.withdraw_address_whitelisted_at) {
    pauseWithReason(db, "address_not_whitelisted");
    return;
  }

  const now = nowSec();
  if (cfg.next_run_at && now < cfg.next_run_at) return; // not due yet

  // If a scheduled row already exists (previous tick created one but didn't
  // transition it — e.g. because credentials were missing), let that one run.
  const pending = db.prepare(`SELECT id FROM autobuy_runs WHERE status = 'scheduled' LIMIT 1`).get() as
    | { id: number } | undefined;
  if (pending) return; // will be handled on the next step's existing path

  // Fetch composite valuation
  const val = await getCurrent();
  if (!val) {
    console.warn("[autobuy-scheduler] no valuation data; skipping tick");
    return;
  }

  const freshness = caps.checkValuationFreshness(val.updated_at);
  if (!freshness.ok) {
    insertSkippedRow(db, "skipped_stale_data", freshness.reason, null, val);
    scheduleNext(db, cfg);
    return;
  }

  // Resolve multiplier from zone
  const mult = parseZoneMultiplier(cfg.zone_multipliers, val.zone);
  if (mult === 0) {
    insertSkippedRow(db, "skipped_zero_multiplier", `zone=${val.zone}`, 0, val);
    scheduleNext(db, cfg);
    return;
  }

  const intendedUsd = computeIntendedBuy(cfg.base_unit_usd, mult);

  const singleCap = caps.checkSingleBuyCap(intendedUsd);
  if (!singleCap.ok) {
    insertSkippedRow(db, "skipped_cap_hit", singleCap.reason, mult, val, intendedUsd);
    scheduleNext(db, cfg);
    return;
  }

  const rollingCap = caps.checkRollingCaps(db, intendedUsd);
  if (!rollingCap.ok) {
    insertSkippedRow(db, "skipped_cap_hit", rollingCap.reason, mult, val, intendedUsd);
    scheduleNext(db, cfg);
    return;
  }

  // Need credentials to proceed — also do a balance check
  const creds = loadCredentials(db);
  if (!creds) {
    pauseWithReason(db, "no_credentials");
    return;
  }

  const accounts = await listAccounts(creds);
  if (!accounts.ok) {
    if (accounts.status === 401 || accounts.status === 403) {
      pauseWithReason(db, "credentials_invalid");
      return;
    }
    console.warn(`[autobuy-scheduler] account check failed: ${accounts.status} ${accounts.error}`);
    return;
  }

  const usdAcct = accounts.data.accounts.find((a) => a.currency === "USD");
  const usdBalance = usdAcct ? Number(usdAcct.available_balance.value) : 0;
  if (usdBalance < intendedUsd) {
    insertSkippedRow(db, "skipped_insufficient_usd", `usd_balance=${usdBalance}`, mult, val, intendedUsd);
    scheduleNext(db, cfg);
    return;
  }

  // All checks pass — place the buy
  const placed = await placeMarketBuy(creds, intendedUsd);
  if (!placed.ok) {
    insertFailedBuyRow(db, placed.error, mult, val, intendedUsd, null);
    caps.recordFailure(db);
    scheduleNext(db, cfg);
    return;
  }

  db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, coinbase_order_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'buy_placed', ?, ?, ?)`,
  ).run(
    now, val.z_score, val.zone, mult, cfg.base_unit_usd, intendedUsd,
    placed.order_id, now, now,
  );
  scheduleNext(db, cfg);
  console.log(`[autobuy-scheduler] placed buy order=${placed.order_id} usd=${intendedUsd} zone=${val.zone}`);
}

function parseZoneMultiplier(zoneMultipliersJson: string, zone: string): number {
  try {
    const m = JSON.parse(zoneMultipliersJson) as Record<string, number>;
    const v = m[zone];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function insertSkippedRow(
  db: Database.Database,
  status: string,
  reason: string,
  multiplier: number | null,
  val: { z_score: number; zone: string },
  intendedUsd: number | null = null,
): void {
  const now = nowSec();
  db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, error_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(now, val.z_score, val.zone, multiplier, intendedUsd, status, reason, now, now);
}

function insertFailedBuyRow(
  db: Database.Database,
  errorMessage: string,
  multiplier: number,
  val: { z_score: number; zone: string },
  intendedUsd: number,
  orderId: string | null,
): void {
  const now = nowSec();
  db.prepare(
    `INSERT INTO autobuy_runs
       (scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
        status, coinbase_order_id, error_message, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'failed_buy', ?, ?, ?, ?)`,
  ).run(now, val.z_score, val.zone, multiplier, intendedUsd, orderId, errorMessage.slice(0, 500), now, now);
}

function scheduleNext(
  db: Database.Database,
  cfg: { frequency: string; next_run_at: number | null },
): void {
  const now = nowSec();
  const increment = frequencyToSeconds(cfg.frequency);
  const base = cfg.next_run_at && cfg.next_run_at > 0 ? cfg.next_run_at : now;
  const nextRunAt = base + increment;
  db.prepare(`UPDATE autobuy_config SET last_run_at = ?, next_run_at = ? WHERE id = 1`).run(now, nextRunAt);
}

// ───────────────────────────────────────────────────────────────────────
// Step 2: Poll buy_placed → buy_filled or failed_buy
// ───────────────────────────────────────────────────────────────────────

async function stepPollBuyPlaced(db: Database.Database): Promise<void> {
  const rows = db.prepare(
    `SELECT id, coinbase_order_id FROM autobuy_runs WHERE status = 'buy_placed' LIMIT 10`,
  ).all() as Array<{ id: number; coinbase_order_id: string }>;
  if (rows.length === 0) return;

  const creds = loadCredentials(db);
  if (!creds) { pauseWithReason(db, "no_credentials"); return; }

  for (const row of rows) {
    const res = await pollOrder(creds, row.coinbase_order_id);
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        pauseWithReason(db, "credentials_invalid");
        return;
      }
      console.warn(`[autobuy-scheduler] pollOrder failed order=${row.coinbase_order_id}: ${res.error}`);
      continue; // next tick retries
    }
    const order = res.order;
    const now = nowSec();
    if (order.status === "FILLED") {
      const filledBtc = Number(order.filled_size);
      const filledUsd = Number(order.filled_value);
      const filledAt = order.filled_at ? Math.floor(Date.parse(order.filled_at) / 1000) : now;
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'buy_filled', filled_btc = ?, filled_usd = ?, filled_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(filledBtc, filledUsd, filledAt, now, row.id);
      console.log(`[autobuy-scheduler] filled order=${row.coinbase_order_id} btc=${filledBtc} usd=${filledUsd}`);
    } else if (order.status === "CANCELLED" || order.status === "EXPIRED" || order.status === "FAILED") {
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'failed_buy', error_code = ?, updated_at = ?
         WHERE id = ?`,
      ).run(order.status.toLowerCase(), now, row.id);
      caps.recordFailure(db);
    }
    // OPEN / PENDING → leave as-is, poll again next tick
  }
}

// ───────────────────────────────────────────────────────────────────────
// Step 3: Past-hold buy_filled → awaiting_withdraw_hold → sweep_assigned
// ───────────────────────────────────────────────────────────────────────

async function stepAssignToSweep(db: Database.Database): Promise<void> {
  const now = nowSec();
  const cutoff = now - WITHDRAW_HOLD_SECONDS;

  // First: move buy_filled rows into awaiting_withdraw_hold tracking (just a
  // status rename to make the state machine explicit).
  db.prepare(
    `UPDATE autobuy_runs
     SET status = 'awaiting_withdraw_hold', updated_at = ?
     WHERE status = 'buy_filled'`,
  ).run(now);

  // Second: find rows whose hold has elapsed and mark them sweep_assigned.
  // Don't create a sweep row yet — that happens in step 4 when we actually
  // issue the withdraw.
  db.prepare(
    `UPDATE autobuy_runs
     SET status = 'sweep_assigned', updated_at = ?
     WHERE status = 'awaiting_withdraw_hold' AND filled_at IS NOT NULL AND filled_at <= ?`,
  ).run(now, cutoff);
}

// ───────────────────────────────────────────────────────────────────────
// Step 4: Daily sweep gate — runs at most once per UTC day
// ───────────────────────────────────────────────────────────────────────

async function stepRunSweep(db: Database.Database): Promise<void> {
  const cfg = readConfig(db);
  if (!cfg.withdraw_address_whitelisted_at) return;

  const nowDate = new Date();
  const todayDow = nowDate.getUTCDay(); // 0=Sunday
  if (todayDow !== cfg.sweep_day_of_week) return;

  const todayStart = Math.floor(Date.UTC(
    nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate(),
  ) / 1000);
  const alreadySwept = db.prepare(
    `SELECT id FROM autobuy_sweeps WHERE swept_at >= ? LIMIT 1`,
  ).get(todayStart) as { id: number } | undefined;
  if (alreadySwept) return;

  // Total BTC across sweep_assigned rows
  const totalRow = db.prepare(
    `SELECT COALESCE(SUM(filled_btc), 0) AS total
     FROM autobuy_runs WHERE status = 'sweep_assigned'`,
  ).get() as { total: number };
  if (totalRow.total < SWEEP_MIN_BTC) return; // defer, retry next week

  const creds = loadCredentials(db);
  if (!creds) { pauseWithReason(db, "no_credentials"); return; }

  const accounts = await listAccounts(creds);
  if (!accounts.ok) {
    if (accounts.status === 401 || accounts.status === 403) {
      pauseWithReason(db, "credentials_invalid");
    }
    return;
  }
  const btcAcct = accounts.data.accounts.find((a) => a.currency === "BTC");
  if (!btcAcct) {
    console.warn("[autobuy-scheduler] no BTC account found");
    return;
  }

  const withdrawResult = await placeWithdraw(
    creds, btcAcct.uuid, cfg.withdraw_address, totalRow.total,
  );
  const now = nowSec();

  if (!withdrawResult.ok) {
    // Record a failed sweep row for audit + mark all assigned runs as failed_withdraw
    const errorCode = withdrawResult.status === 400 ? "address_not_whitelisted" : `http_${withdrawResult.status}`;
    db.prepare(
      `INSERT INTO autobuy_sweeps (swept_at, btc_amount, status, error_code, error_message)
       VALUES (?, ?, 'failed', ?, ?)`,
    ).run(now, totalRow.total, errorCode, withdrawResult.error.slice(0, 500));
    db.prepare(
      `UPDATE autobuy_runs
       SET status = 'failed_withdraw', error_message = ?, updated_at = ?
       WHERE status = 'sweep_assigned'`,
    ).run(withdrawResult.error.slice(0, 500), now);
    if (withdrawResult.status === 400) {
      pauseWithReason(db, "address_not_whitelisted");
    }
    caps.recordFailure(db);
    return;
  }

  // Create the sweep row + link all sweep_assigned runs to it + transition them
  const sweepInsert = db.prepare(
    `INSERT INTO autobuy_sweeps (swept_at, btc_amount, coinbase_tx_id, status)
     VALUES (?, ?, ?, 'placed') RETURNING id`,
  ).get(now, totalRow.total, withdrawResult.transaction_id) as { id: number };

  db.prepare(
    `UPDATE autobuy_runs
     SET status = 'withdraw_placed', withdraw_sweep_id = ?, updated_at = ?
     WHERE status = 'sweep_assigned'`,
  ).run(sweepInsert.id, now);
  console.log(`[autobuy-scheduler] sweep placed tx=${withdrawResult.transaction_id} btc=${totalRow.total}`);
}

// ───────────────────────────────────────────────────────────────────────
// Step 5: Poll withdraw_placed sweeps → confirmed / failed
// ───────────────────────────────────────────────────────────────────────

async function stepPollWithdraws(db: Database.Database): Promise<void> {
  const sweeps = db.prepare(
    `SELECT id, coinbase_tx_id FROM autobuy_sweeps WHERE status = 'placed' LIMIT 5`,
  ).all() as Array<{ id: number; coinbase_tx_id: string }>;
  if (sweeps.length === 0) return;

  const creds = loadCredentials(db);
  if (!creds) return;

  const accounts = await listAccounts(creds);
  if (!accounts.ok) return;
  const btcAcct = accounts.data.accounts.find((a) => a.currency === "BTC");
  if (!btcAcct) return;

  for (const sweep of sweeps) {
    const res = await pollWithdraw(creds, btcAcct.uuid, sweep.coinbase_tx_id);
    if (!res.ok) continue; // retry next tick

    const now = nowSec();
    if (res.withdraw.status === "completed") {
      db.prepare(
        `UPDATE autobuy_sweeps SET status = 'confirmed', withdraw_txid = ? WHERE id = ?`,
      ).run(res.withdraw.network_tx_hash ?? null, sweep.id);
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'withdraw_confirmed', withdraw_txid = ?, updated_at = ?
         WHERE withdraw_sweep_id = ? AND status = 'withdraw_placed'`,
      ).run(res.withdraw.network_tx_hash ?? null, now, sweep.id);
      caps.resetFailureCounter(db);
      console.log(`[autobuy-scheduler] sweep confirmed sweep=${sweep.id} txid=${res.withdraw.network_tx_hash ?? "<pending>"}`);
    } else if (res.withdraw.status === "failed" || res.withdraw.status === "cancelled") {
      db.prepare(
        `UPDATE autobuy_sweeps SET status = 'failed', error_code = ? WHERE id = ?`,
      ).run(res.withdraw.status, sweep.id);
      db.prepare(
        `UPDATE autobuy_runs
         SET status = 'failed_withdraw', updated_at = ?
         WHERE withdraw_sweep_id = ? AND status = 'withdraw_placed'`,
      ).run(now, sweep.id);
      caps.recordFailure(db);
    }
    // "pending" → leave as-is
  }
}

/**
 * Fresh withdraw address provisioning — called from GET /api/autobuy/status
 * if the config's withdraw_address is empty. Generates one via LND and
 * persists it. The operator then whitelists it in Coinbase.
 */
export async function ensureWithdrawAddress(db: Database.Database): Promise<string> {
  const cfg = readConfig(db);
  if (cfg.withdraw_address) return cfg.withdraw_address;
  const { address } = await createLndChainAddress();
  db.prepare(`UPDATE autobuy_config SET withdraw_address = ? WHERE id = 1`).run(address);
  return address;
}
```

- [ ] **Step 2: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean. If the build fails with "Cannot find module '../lightning/lnd'" or similar, the existing export path may differ — check `app/api/src/lightning/lnd.ts` for the exact name of the chain-address-generation function and update the import. The function should exist; if its actual export is e.g. `newChainAddress`, rename the call.

- [ ] **Step 3: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/src/autoBuy/scheduler.ts
git commit -m "feat(api/autoBuy): scheduler with 5-step state machine (enqueue → buy → hold → sweep → confirm)"
```

---

## Task 8: Start scheduler + add enable/pause/execute-now routes

**Files:**
- Modify: `app/api/src/index.ts`

- [ ] **Step 1: Add imports**

Near the top of `app/api/src/index.ts`, alongside other autoBuy-adjacent imports (or after the `./valuation/*` imports from Plan 1b), add:

```typescript
import { startScheduler, runTick, ensureWithdrawAddress } from "./autoBuy/scheduler";
import { encrypt, decrypt } from "./autoBuy/credentials";
import { listAccounts } from "./autoBuy/coinbaseClient";
import * as caps from "./autoBuy/caps";
```

- [ ] **Step 2: Start the scheduler on API boot**

Find where the existing schedulers are started (look for `startRebalanceScheduler` or `startStalenessScheduler`). Add, immediately after:

```typescript
startScheduler(db);
```

- [ ] **Step 3: Add the three control endpoints**

Locate a sensible insertion point — alongside the other `/api/autobuy/*` routes you'll add in Tasks 9–11 is fine, or grouped with existing treasury controls.

```typescript
if (req.method === "POST" && req.url === "/api/autobuy/enable") {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  try {
    const cfg = db.prepare(`SELECT * FROM autobuy_config WHERE id = 1`).get() as any;
    if (!cfg) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "config_missing" }));
      return;
    }
    const creds = db.prepare(`SELECT id FROM coinbase_credentials WHERE id = 1`).get();
    if (!creds) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no_credentials" }));
      return;
    }
    if (!cfg.withdraw_address_whitelisted_at) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "address_not_whitelisted" }));
      return;
    }
    db.prepare(
      `UPDATE autobuy_config SET enabled = 1, paused_reason = NULL, consecutive_failures = 0 WHERE id = 1`,
    ).run();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, enabled: true }));
  } catch (err: any) {
    console.error("[autobuy-enable]", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
  return;
}

if (req.method === "POST" && req.url === "/api/autobuy/pause") {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  try {
    db.prepare(
      `UPDATE autobuy_config SET enabled = 0, paused_reason = 'user_paused' WHERE id = 1`,
    ).run();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, enabled: false }));
  } catch (err: any) {
    console.error("[autobuy-pause]", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
  return;
}

if (req.method === "POST" && req.url === "/api/autobuy/execute-now") {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  // Force next_run_at to now so the next-tick check passes; then run a tick
  // immediately. Still respects caps + credential gates.
  try {
    db.prepare(`UPDATE autobuy_config SET next_run_at = ? WHERE id = 1`).run(Math.floor(Date.now() / 1000));
    await runTick(db);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err: any) {
    console.error("[autobuy-execute-now]", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
  return;
}
```

- [ ] **Step 4: Add `assertNonEmpty` helper if it doesn't exist**

Check `app/api/src/utils/role.ts` — it exports `assertTreasury` and probably `assertMember`. If `assertNonEmpty(role)` is not already there, add it:

```typescript
// At the bottom of app/api/src/utils/role.ts:
export function assertNonEmpty(role: string | undefined): void {
  if (!role) {
    throw new Error("Node role required");
  }
}
```

Then import it alongside `assertTreasury` / `assertMember` wherever used.

- [ ] **Step 5: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/src/index.ts app/api/src/utils/role.ts
git commit -m "feat(api): start autobuy scheduler on boot + enable/pause/execute-now routes"
```

---

## Task 9: Credentials API routes

`POST /api/autobuy/credentials`, `DELETE /api/autobuy/credentials`, `POST /api/autobuy/credentials/verify`.

**Files:**
- Modify: `app/api/src/index.ts`

- [ ] **Step 1: Add the three handlers**

Insert alongside the other `/api/autobuy/*` routes:

```typescript
if (req.method === "POST" && req.url === "/api/autobuy/credentials") {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(body || "{}");
      // Accept either { json_blob: "<full Coinbase key JSON string>" } or
      // { key_name, private_key } explicitly.
      let keyName: string | null = null;
      let privateKeyPem: string | null = null;
      if (typeof parsed.json_blob === "string") {
        let inner: any;
        try { inner = JSON.parse(parsed.json_blob); } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json_blob" }));
          return;
        }
        keyName = typeof inner.name === "string" ? inner.name : null;
        privateKeyPem = typeof inner.privateKey === "string" ? inner.privateKey : null;
      } else if (typeof parsed.key_name === "string" && typeof parsed.private_key === "string") {
        keyName = parsed.key_name;
        privateKeyPem = parsed.private_key;
      }
      if (!keyName || !privateKeyPem) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "key_name_and_private_key_required" }));
        return;
      }

      // Verify by making a live Coinbase call before persisting
      const verifyResult = await listAccounts({ keyName, privateKeyPem });
      if (!verifyResult.ok) {
        res.writeHead(verifyResult.status === 401 || verifyResult.status === 403 ? 401 : 502, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ error: "verification_failed", detail: verifyResult.error }));
        return;
      }

      const blob = encrypt(privateKeyPem);
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `INSERT INTO coinbase_credentials (id, key_name, encrypted_private_key, nonce, connected_at, last_verified_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           key_name = excluded.key_name,
           encrypted_private_key = excluded.encrypted_private_key,
           nonce = excluded.nonce,
           connected_at = excluded.connected_at,
           last_verified_at = excluded.last_verified_at`,
      ).run(keyName, blob.ciphertext, blob.nonce, now, now);
      // Clear any "no_credentials" / "credentials_invalid" pause reason
      db.prepare(
        `UPDATE autobuy_config SET paused_reason = CASE
           WHEN paused_reason IN ('no_credentials','credentials_invalid','credentials_corrupted') THEN NULL
           ELSE paused_reason END
         WHERE id = 1`,
      ).run();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, key_name: keyName, connected_at: now }));
    } catch (err: any) {
      console.error("[autobuy-credentials-post]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    }
  });
  return;
}

if (req.method === "DELETE" && req.url === "/api/autobuy/credentials") {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  try {
    db.prepare(`DELETE FROM coinbase_credentials WHERE id = 1`).run();
    db.prepare(
      `UPDATE autobuy_config SET enabled = 0, paused_reason = 'no_credentials' WHERE id = 1`,
    ).run();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err: any) {
    console.error("[autobuy-credentials-delete]", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
  return;
}

if (req.method === "POST" && req.url === "/api/autobuy/credentials/verify") {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  try {
    const row = db.prepare(
      `SELECT key_name, encrypted_private_key, nonce FROM coinbase_credentials WHERE id = 1`,
    ).get() as { key_name: string; encrypted_private_key: Buffer; nonce: Buffer } | undefined;
    if (!row) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no_credentials" }));
      return;
    }
    let privateKeyPem: string;
    try {
      privateKeyPem = decrypt({ ciphertext: row.encrypted_private_key, nonce: row.nonce });
    } catch {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "credentials_corrupted" }));
      return;
    }
    const verifyResult = await listAccounts({ keyName: row.key_name, privateKeyPem });
    if (!verifyResult.ok) {
      res.writeHead(verifyResult.status === 401 || verifyResult.status === 403 ? 401 : 502, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ ok: false, status: verifyResult.status, error: verifyResult.error }));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`UPDATE coinbase_credentials SET last_verified_at = ? WHERE id = 1`).run(now);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      last_verified_at: now,
      accounts: verifyResult.data.accounts.map((a) => ({
        currency: a.currency,
        available: Number(a.available_balance.value),
      })),
    }));
  } catch (err: any) {
    console.error("[autobuy-credentials-verify]", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
  return;
}
```

- [ ] **Step 2: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/src/index.ts
git commit -m "feat(api): POST/DELETE/verify /api/autobuy/credentials routes"
```

---

## Task 10: Status + history + config-patch routes

**Files:**
- Modify: `app/api/src/index.ts`

- [ ] **Step 1: Add three handlers**

```typescript
if (req.method === "GET" && req.url === "/api/autobuy/status") {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  try {
    const cfg = db.prepare(`SELECT * FROM autobuy_config WHERE id = 1`).get() as any;
    const creds = db.prepare(
      `SELECT key_name, connected_at, last_verified_at FROM coinbase_credentials WHERE id = 1`,
    ).get() as { key_name: string; connected_at: number; last_verified_at: number | null } | undefined;
    // Generate withdraw_address on first call if absent (per spec §7 edge case)
    if (cfg && !cfg.withdraw_address) {
      try {
        const addr = await ensureWithdrawAddress(db);
        cfg.withdraw_address = addr;
      } catch (err) {
        console.warn("[autobuy-status] ensureWithdrawAddress failed:", err);
      }
    }
    const next = db.prepare(
      `SELECT id, scheduled_for, z_score, zone, multiplier, intended_buy_usd, status
       FROM autobuy_runs WHERE status IN ('scheduled','buy_placed','awaiting_withdraw_hold','sweep_assigned','withdraw_placed')
       ORDER BY scheduled_for ASC LIMIT 10`,
    ).all();
    const recent = db.prepare(
      `SELECT id, scheduled_for, z_score, zone, multiplier, intended_buy_usd, filled_btc, filled_usd,
              status, filled_at, withdraw_txid, error_code, error_message
       FROM autobuy_runs ORDER BY id DESC LIMIT 20`,
    ).all();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      config: cfg ? {
        enabled: cfg.enabled === 1,
        base_unit_usd: cfg.base_unit_usd,
        frequency: cfg.frequency,
        zone_multipliers: JSON.parse(cfg.zone_multipliers),
        withdraw_address: cfg.withdraw_address,
        withdraw_address_whitelisted_at: cfg.withdraw_address_whitelisted_at,
        sweep_day_of_week: cfg.sweep_day_of_week,
        consecutive_failures: cfg.consecutive_failures,
        paused_reason: cfg.paused_reason,
        last_run_at: cfg.last_run_at,
        next_run_at: cfg.next_run_at,
      } : null,
      credentials: creds ? {
        key_name: creds.key_name,
        connected_at: creds.connected_at,
        last_verified_at: creds.last_verified_at,
      } : null,
      in_flight: next,
      recent,
    }));
  } catch (err: any) {
    console.error("[autobuy-status]", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
  return;
}

if (req.method === "GET" && req.url?.startsWith("/api/autobuy/history")) {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  try {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10));
    const statusFilter = url.searchParams.get("status");
    const params: Array<string | number> = [];
    let where = "";
    if (statusFilter) {
      where = "WHERE status = ?";
      params.push(statusFilter);
    }
    params.push(limit, offset);
    const rows = db.prepare(
      `SELECT id, scheduled_for, z_score, zone, multiplier, base_unit_usd, intended_buy_usd,
              status, coinbase_order_id, filled_btc, filled_usd, filled_at,
              withdraw_txid, error_code, error_message, created_at, updated_at
       FROM autobuy_runs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...params);
    const total = db.prepare(
      `SELECT COUNT(*) AS c FROM autobuy_runs ${where}`,
    ).get(...(statusFilter ? [statusFilter] : [])) as { c: number };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ rows, total: total.c, limit, offset }));
  } catch (err: any) {
    console.error("[autobuy-history]", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
  return;
}

if (req.method === "PATCH" && req.url === "/api/autobuy/config") {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const parsed = JSON.parse(body || "{}");
      const updates: string[] = [];
      const params: Array<string | number> = [];

      if (parsed.base_unit_usd !== undefined) {
        const n = Number(parsed.base_unit_usd);
        if (!Number.isFinite(n) || n <= 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_base_unit_usd" }));
          return;
        }
        const cap = caps.checkBaseUnitCap(n);
        if (!cap.ok) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "base_unit_exceeds_cap", detail: cap.reason }));
          return;
        }
        updates.push("base_unit_usd = ?");
        params.push(n);
      }
      if (parsed.frequency !== undefined) {
        if (!["daily", "weekly", "biweekly", "monthly"].includes(parsed.frequency)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_frequency" }));
          return;
        }
        updates.push("frequency = ?");
        params.push(parsed.frequency);
      }
      if (parsed.zone_multipliers !== undefined) {
        const zm = parsed.zone_multipliers;
        if (!zm || typeof zm !== "object") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_zone_multipliers" }));
          return;
        }
        const required = ["extreme_buy", "undervalued", "fair_value", "elevated", "overvalued", "extreme_sell"];
        for (const k of required) {
          if (typeof zm[k] !== "number" || !Number.isFinite(zm[k]) || zm[k] < 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `invalid_zone_multiplier:${k}` }));
            return;
          }
        }
        updates.push("zone_multipliers = ?");
        params.push(JSON.stringify(zm));
      }
      if (parsed.sweep_day_of_week !== undefined) {
        const d = Number(parsed.sweep_day_of_week);
        if (!Number.isInteger(d) || d < 0 || d > 6) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_sweep_day_of_week" }));
          return;
        }
        updates.push("sweep_day_of_week = ?");
        params.push(d);
      }
      if (parsed.whitelist_confirmed === true) {
        updates.push("withdraw_address_whitelisted_at = ?");
        params.push(Math.floor(Date.now() / 1000));
      }

      if (updates.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no_fields_to_update" }));
        return;
      }

      params.push(1);
      db.prepare(`UPDATE autobuy_config SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      const cfg = db.prepare(`SELECT * FROM autobuy_config WHERE id = 1`).get();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, config: cfg }));
    } catch (err: any) {
      console.error("[autobuy-config-patch]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    }
  });
  return;
}
```

- [ ] **Step 2: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/src/index.ts
git commit -m "feat(api): GET /autobuy/status, /autobuy/history; PATCH /autobuy/config"
```

---

## Task 11: Valuation proxy routes

`GET /api/valuation/current`, `GET /api/valuation/history?since&until`, `GET /api/valuation/inputs`.

**Files:**
- Modify: `app/api/src/index.ts`

- [ ] **Step 1: Add three handlers**

```typescript
if (req.method === "GET" && req.url === "/api/valuation/current") {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  try {
    const { getCurrent } = await import("./autoBuy/valuationClient");
    const data = await getCurrent();
    if (!data) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "valuation_unavailable" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err: any) {
    console.error("[valuation-current]", err);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "valuation_unavailable" }));
  }
  return;
}

if (req.method === "GET" && req.url?.startsWith("/api/valuation/history")) {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  try {
    const url = new URL(req.url, "http://localhost");
    const since = url.searchParams.get("since") ?? undefined;
    const until = url.searchParams.get("until") ?? undefined;
    const { getHistory } = await import("./autoBuy/valuationClient");
    const data = await getHistory(since, until);
    if (!data) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "valuation_unavailable" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err: any) {
    console.error("[valuation-history]", err);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "valuation_unavailable" }));
  }
  return;
}

if (req.method === "GET" && req.url === "/api/valuation/inputs") {
  const node = getNodeInfo();
  try { assertNonEmpty(node?.node_role); } catch (err: any) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message }));
    return;
  }
  try {
    const { getInputs } = await import("./autoBuy/valuationClient");
    const data = await getInputs();
    if (!data) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "valuation_unavailable" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (err: any) {
    console.error("[valuation-inputs]", err);
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "valuation_unavailable" }));
  }
  return;
}
```

The dynamic `await import(...)` inside the handlers keeps the proxy module from being loaded until actually needed, which is harmless but consistent with the "lazy load" pattern used elsewhere in the repo for optional modules. If you prefer a static top-of-file import (as used in other modules), that's equally fine.

- [ ] **Step 2: Build**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application
git add app/api/src/index.ts
git commit -m "feat(api): /api/valuation/* proxy routes (current, history, inputs)"
```

---

## Task 12: End-to-end smoke test (no code — operational)

**Files:**
- None. This task is verification-only.

- [ ] **Step 1: Build + start the API**

```bash
cd /home/user/Documents/BitCorn/bitcorn-lightning-application/app/api
npm run build
AUTOBUY_ENABLED=true npm start &
API_PID=$!
sleep 3
```

- [ ] **Step 2: Confirm migration ran + scheduler started**

Check stdout for `[autobuy-scheduler] started (15-min tick)`. If the migration log shows `Applied: 034_coinbase_autobuy.sql`, DB setup is OK. If not, look for migration runner errors.

- [ ] **Step 3: Hit GET /api/autobuy/status (no credentials yet)**

```bash
curl -s http://localhost:3101/api/autobuy/status | jq .
```

Expected shape:
```json
{
  "config": {
    "enabled": false,
    "base_unit_usd": 100,
    "frequency": "weekly",
    "zone_multipliers": { "extreme_buy": 3, ... },
    "withdraw_address": "bc1q...",     // auto-generated on first call
    "withdraw_address_whitelisted_at": null,
    "paused_reason": null,
    ...
  },
  "credentials": null,
  "in_flight": [],
  "recent": []
}
```

If `withdraw_address` is `""` instead of a bc1 address, the LND call probably failed — check API logs for `[autobuy-status] ensureWithdrawAddress failed`.

- [ ] **Step 4: Try to enable without credentials (expect 400)**

```bash
curl -i -X POST http://localhost:3101/api/autobuy/enable
```

Expected: `HTTP/1.1 400 Bad Request` with `{"error":"no_credentials"}`.

- [ ] **Step 5: Verify the valuation proxy works**

```bash
curl -s http://localhost:3101/api/valuation/current | jq .
```

Expected: same shape as the Worker's direct `/valuation/current` response (z_score, zone, multiplier, updated_at, price_usd). If you get 503 `valuation_unavailable`, the Worker URL env isn't set — check `VALUATION_WORKER_URL` / `COINBASE_WORKER_URL`.

- [ ] **Step 6: Submit test credentials (sandbox keys work great; production keys work if boss is okay with $1 test buys)**

Create a Coinbase Cloud Key (at coinbase.com/cloud). Save the JSON as `/tmp/cb-key.json`. Then:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d "$(jq -c '{json_blob: (.|tojson)}' /tmp/cb-key.json)" \
  http://localhost:3101/api/autobuy/credentials | jq .
```

Expected: `{"ok":true,"key_name":"organizations/...","connected_at":<unix>}`.

- [ ] **Step 7: Verify connection**

```bash
curl -s -X POST http://localhost:3101/api/autobuy/credentials/verify | jq .
```

Expected: `{"ok":true,"last_verified_at":<unix>,"accounts":[{"currency":"USD","available":<n>},{"currency":"BTC","available":<n>},...]}`. A 401 here means the JWT signing is off or the key is inactive.

- [ ] **Step 8: Confirm the whitelist step (UI normally handles this; we fake it via PATCH)**

Copy the deposit address from step 3; add it to your Coinbase withdraw allowlist in the Coinbase web UI; then:

```bash
curl -s -X PATCH -H "Content-Type: application/json" \
  -d '{"whitelist_confirmed": true}' \
  http://localhost:3101/api/autobuy/config | jq .
```

Expected: `{"ok":true,"config":{...,"withdraw_address_whitelisted_at":<unix>,...}}`.

- [ ] **Step 9: Dial down caps for a live $1 test**

```bash
AUTOBUY_MAX_SINGLE_BUY_USD=1 AUTOBUY_BASE_UNIT_MAX_USD=1 AUTOBUY_MAX_7D_USD=5 AUTOBUY_MAX_30D_USD=10 \
  AUTOBUY_ENABLED=true npm start
```

(Restart the API with these env overrides.)

Set base_unit to $1:

```bash
curl -s -X PATCH -H "Content-Type: application/json" \
  -d '{"base_unit_usd": 1}' http://localhost:3101/api/autobuy/config | jq .
```

Enable + execute-now:

```bash
curl -s -X POST http://localhost:3101/api/autobuy/enable | jq .
curl -s -X POST http://localhost:3101/api/autobuy/execute-now | jq .
```

Watch logs for `[autobuy-scheduler] placed buy order=... usd=1` + later `[autobuy-scheduler] filled order=...`. Inspect state:

```bash
curl -s http://localhost:3101/api/autobuy/history?limit=5 | jq .
```

Row progresses scheduled → buy_placed → buy_filled → awaiting_withdraw_hold over successive ticks / executes.

- [ ] **Step 10: Kill the API when done**

```bash
kill $API_PID 2>/dev/null
```

- [ ] **Step 11: Push the branch**

No new files created in this task; just push the branch when you're confident everything works:

```bash
git push -u origin feature/coinbase-autobuy-executor
```

Plan 2a backend is complete.

---

## Self-review checklist (already performed)

- **Spec coverage**: §5.1 data schema → Task 1. §5.2 state machine → Task 7. §5.3 caps → Tasks 2 + 5. §5.4 credential storage → Task 3. §5.5 Coinbase client → Task 4. §5.6 routes → Tasks 8–11. §7 edge cases → handled inside Task 7's step functions + Task 10's status route (withdraw_address generation).
- **Placeholder scan**: no "TBD" / "TODO" / "Similar to Task N" cross-references.
- **Type consistency**: `CoinbaseCredentials`, `EncryptedBlob`, `CapResult` types defined once and reused. `listAccounts` / `placeMarketBuy` / `pollOrder` / `placeWithdraw` / `pollWithdraw` names match across scheduler + route handlers. Role gate uses `assertNonEmpty` (new helper added in Task 8 if missing).
- **Path guard**: Every new file path is under `app/api/src/autoBuy/` or `app/api/src/db/migrations/`. No changes to the Worker, web app, or existing module behavior.

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-04-20-coinbase-autobuy-plan-2a-executor-backend.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task with two-stage review after each. Same cadence as Plans 1 / 1-rev / 1b used successfully.

**2. Inline Execution** — I execute tasks in this session using `superpowers:executing-plans` with checkpoints for review.

Which approach?
