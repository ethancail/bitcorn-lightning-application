# Loop-Based Swap Subsystem Implementation Plan

> **Shipped — see `app/api/src/swaps/` for the current implementation.**

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Loop-based swap subsystem with member "Withdraw to Bitcoin Wallet" and treasury Loop In/Out operations, replacing keysend as the primary liquidity mechanism.

**Architecture:** New `src/swaps/` service layer wraps existing `loop.ts` gRPC client. Four new DB tables (migration 029-030). Swap poller on 15s interval. Frontend pages for member withdrawal and treasury swap ops.

**Tech Stack:** TypeScript, better-sqlite3, gRPC (loopd proto), React 18, Vite, existing ln-service + loop.ts

---

## Task 1: Database Migrations

**Files:**
- Create: `app/api/src/db/migrations/029_swap_subsystem.sql`
- Create: `app/api/src/db/migrations/030_swap_withdrawal_config.sql`

**Step 1: Create migration 029 — four core swap tables**

Create `app/api/src/db/migrations/029_swap_subsystem.sql`:

```sql
-- Migration 029: Loop-based swap subsystem
-- Four tables: swap_requests, swap_executions, swap_events, liquidity_actions

CREATE TABLE IF NOT EXISTS swap_requests (
  id                   TEXT PRIMARY KEY,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  node_pubkey          TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK(role IN ('member', 'treasury')),
  swap_type            TEXT NOT NULL CHECK(swap_type IN ('loop_in', 'loop_out')),
  direction            TEXT NOT NULL CHECK(direction IN ('lightning_to_chain', 'chain_to_lightning')),
  status               TEXT NOT NULL,
  amount_sat           INTEGER NOT NULL,
  max_fee_sat          INTEGER,
  quoted_fee_sat       INTEGER,
  actual_fee_sat       INTEGER,
  destination_address  TEXT,
  channel_id           TEXT,
  quote_expires_at     INTEGER,
  failure_reason       TEXT,
  notes                TEXT
);

CREATE INDEX IF NOT EXISTS idx_swap_requests_pubkey ON swap_requests(node_pubkey);
CREATE INDEX IF NOT EXISTS idx_swap_requests_status ON swap_requests(status);
CREATE INDEX IF NOT EXISTS idx_swap_requests_created ON swap_requests(created_at DESC);

CREATE TABLE IF NOT EXISTS swap_executions (
  id                     TEXT PRIMARY KEY,
  swap_request_id        TEXT NOT NULL,
  provider               TEXT NOT NULL,
  provider_swap_id       TEXT,
  invoice                TEXT,
  prepay_invoice         TEXT,
  payment_hash           TEXT,
  prepay_payment_hash    TEXT,
  htlc_address           TEXT,
  onchain_txid           TEXT,
  sweep_txid             TEXT,
  timeout_block_height   INTEGER,
  status                 TEXT NOT NULL,
  raw_provider_status    TEXT,
  started_at             INTEGER NOT NULL,
  completed_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_swap_exec_request ON swap_executions(swap_request_id);
CREATE INDEX IF NOT EXISTS idx_swap_exec_provider_id ON swap_executions(provider_swap_id);
CREATE INDEX IF NOT EXISTS idx_swap_exec_status ON swap_executions(status);

CREATE TABLE IF NOT EXISTS swap_events (
  id                   TEXT PRIMARY KEY,
  swap_request_id      TEXT NOT NULL,
  swap_execution_id    TEXT,
  event_type           TEXT NOT NULL,
  event_json           TEXT NOT NULL,
  created_at           INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_swap_events_request ON swap_events(swap_request_id);
CREATE INDEX IF NOT EXISTS idx_swap_events_created ON swap_events(created_at DESC);

CREATE TABLE IF NOT EXISTS liquidity_actions (
  id                       TEXT PRIMARY KEY,
  created_at               INTEGER NOT NULL,
  updated_at               INTEGER NOT NULL,
  node_pubkey              TEXT NOT NULL,
  channel_id               TEXT,
  actor_role               TEXT NOT NULL CHECK(actor_role IN ('member', 'treasury')),
  action_type              TEXT NOT NULL CHECK(action_type IN (
    'loop_in', 'loop_out', 'rebalance', 'open_channel', 'wait', 'manual_review'
  )),
  reason_code              TEXT NOT NULL,
  recommended_amount_sat   INTEGER,
  priority                 TEXT NOT NULL CHECK(priority IN ('low', 'medium', 'high', 'critical')),
  status                   TEXT NOT NULL CHECK(status IN (
    'recommended', 'approved', 'rejected', 'executing', 'completed', 'failed'
  )),
  approved_by              TEXT,
  linked_swap_request_id   TEXT,
  expires_at               INTEGER
);

CREATE INDEX IF NOT EXISTS idx_liq_actions_pubkey ON liquidity_actions(node_pubkey);
CREATE INDEX IF NOT EXISTS idx_liq_actions_status ON liquidity_actions(status);
CREATE INDEX IF NOT EXISTS idx_liq_actions_swap ON liquidity_actions(linked_swap_request_id);
```

**Step 2: Create migration 030 — add withdrawal config to advisor config**

Create `app/api/src/db/migrations/030_swap_withdrawal_config.sql`:

```sql
-- Extend advisor config with member withdrawal limits
ALTER TABLE member_liquidity_advisor_config
  ADD COLUMN max_daily_withdrawal_sat INTEGER NOT NULL DEFAULT 5000000;

ALTER TABLE member_liquidity_advisor_config
  ADD COLUMN min_withdrawal_sat INTEGER NOT NULL DEFAULT 250000;

ALTER TABLE member_liquidity_advisor_config
  ADD COLUMN max_withdrawal_sat INTEGER NOT NULL DEFAULT 2000000;
```

**Step 3: Verify migrations apply**

Run: `cd app/api && npm run build && node -e "require('./dist/db').initDb(); require('./dist/db/migrate').runMigrations();"`
Expected: Migrations 029 and 030 applied successfully (check console output).

**Step 4: Commit**

```bash
git add app/api/src/db/migrations/029_swap_subsystem.sql app/api/src/db/migrations/030_swap_withdrawal_config.sql
git commit -m "feat: add swap subsystem database tables (migrations 029-030)"
```

---

## Task 2: Loop In Implementation in loop.ts

**Files:**
- Modify: `app/api/src/lightning/loop.ts`

**Step 1: Add Loop In types and functions**

Append to `app/api/src/lightning/loop.ts` (after the existing `listLoopSwaps` function):

```typescript
// ─── Loop In ────────────────────────────────────────────────────────────────

export type LoopInTerms = {
  min_swap_amount: number;
  max_swap_amount: number;
};

/** Get the minimum and maximum swap amounts for Loop In. */
export async function getLoopInTerms(): Promise<LoopInTerms> {
  const res = await rpcCall<{
    min_swap_amount: number;
    max_swap_amount: number;
  }>("GetLoopInTerms", {});
  return {
    min_swap_amount: Number(res.min_swap_amount),
    max_swap_amount: Number(res.max_swap_amount),
  };
}

export type LoopInQuote = {
  swap_fee_sat: number;
  htlc_publish_fee_sat: number;
  cltv_delta: number;
  conf_target: number;
  total_cost_sats: number;
};

/** Get a cost quote for a Loop In swap of a given amount. */
export async function getLoopInQuote(
  amountSats: number,
  confTarget?: number
): Promise<LoopInQuote> {
  const target = confTarget ?? ENV.loopConfTarget;
  const res = await rpcCall<{
    swap_fee_sat: number;
    htlc_publish_fee_sat: number;
    cltv_delta: number;
    conf_target: number;
  }>("GetLoopInQuote", { amt: amountSats, conf_target: target });

  const swapFee = Number(res.swap_fee_sat);
  const htlcFee = Number(res.htlc_publish_fee_sat);

  return {
    swap_fee_sat: swapFee,
    htlc_publish_fee_sat: Math.max(0, htlcFee), // -1 means estimation failed
    cltv_delta: Number(res.cltv_delta),
    conf_target: Number(res.conf_target) || target,
    total_cost_sats: swapFee + Math.max(0, htlcFee),
  };
}

export type LoopInSwapResult = {
  swap_hash: string;
  id: string;
  server_message: string;
  htlc_address: string;
};

/** Initiate a Loop In swap. Sends on-chain, receives Lightning inbound. */
export async function executeLoopInSwap(params: {
  amt: number;
  max_swap_fee: number;
  max_miner_fee: number;
  htlc_conf_target: number;
  last_hop?: string;
  label?: string;
}): Promise<LoopInSwapResult> {
  const res = await rpcCall<{
    id_bytes: Buffer | string;
    server_message: string;
    htlc_address: string;
    htlc_address_p2wsh: string;
    htlc_address_p2tr: string;
  }>(
    "LoopIn",
    {
      amt: params.amt,
      max_swap_fee: params.max_swap_fee,
      max_miner_fee: params.max_miner_fee,
      htlc_conf_target: params.htlc_conf_target,
      last_hop: params.last_hop ? Buffer.from(params.last_hop, "hex") : undefined,
      label: params.label || `bitcorn-loop-in-${Date.now()}`,
      initiator: "bitcorn",
    },
    60_000
  );

  const hashHex =
    typeof res.id_bytes === "string"
      ? res.id_bytes
      : Buffer.from(res.id_bytes).toString("hex");

  return {
    swap_hash: hashHex,
    id: hashHex,
    server_message: res.server_message || "",
    htlc_address: res.htlc_address_p2tr || res.htlc_address_p2wsh || res.htlc_address || "",
  };
}
```

**Step 2: Verify build**

Run: `cd app/api && npm run build`
Expected: Compiles with no new errors.

**Step 3: Commit**

```bash
git add app/api/src/lightning/loop.ts
git commit -m "feat: add Loop In gRPC methods (getLoopInTerms, getLoopInQuote, executeLoopInSwap)"
```

---

## Task 3: Environment Config Extensions

**Files:**
- Modify: `app/api/src/config/env.ts`

**Step 1: Add swap-related env vars**

Add after the Loop Out config section (after line 87 `loopConfTarget`):

```typescript
    // --- Member swap / withdrawal limits ---
    // Minimum sats a member can withdraw via Loop Out (default: Loop minimum = 250,000)
    memberMinWithdrawalSat: Number(process.env.MEMBER_MIN_WITHDRAWAL_SAT ?? "250000"),
    // Maximum sats a member can withdraw in a single Loop Out (default: 2,000,000)
    memberMaxWithdrawalSat: Number(process.env.MEMBER_MAX_WITHDRAWAL_SAT ?? "2000000"),
    // Maximum total daily withdrawal for a member (default: 5,000,000)
    memberMaxDailyWithdrawalSat: Number(process.env.MEMBER_MAX_DAILY_WITHDRAWAL_SAT ?? "5000000"),
    // Quote expiry in seconds (default: 5 minutes)
    swapQuoteExpirySec: Number(process.env.SWAP_QUOTE_EXPIRY_SEC ?? "300"),
```

**Step 2: Verify build**

Run: `cd app/api && npm run build`

**Step 3: Commit**

```bash
git add app/api/src/config/env.ts
git commit -m "feat: add member withdrawal and swap quote env config"
```

---

## Task 4: Swap Service Layer

**Files:**
- Create: `app/api/src/swaps/loopProvider.ts`
- Create: `app/api/src/swaps/swapPolicy.ts`
- Create: `app/api/src/swaps/swapService.ts`
- Create: `app/api/src/swaps/swapPoller.ts`

This is the largest task. Each file is a focused module.

**Step 1: Create loopProvider.ts**

```typescript
// Loop provider — wraps loop.ts with status normalization and event recording.
// Does NOT replace loop.ts; existing auto-rebalance continues using it directly.

import crypto from "crypto";
import { db } from "../db";
import {
  getLoopOutTerms,
  getLoopOutQuote,
  executeLoopOutSwap,
  getLoopInTerms,
  getLoopInQuote,
  executeLoopInSwap,
  listLoopSwaps,
  isLoopAvailable,
  type SwapState,
  type SwapInfo,
  type LoopOutQuote,
  type LoopInQuote,
} from "../lightning/loop";
import { createLndChainAddress } from "../lightning/lnd";

// ─── Status normalization ────────────────────────────────────────────────

export type AppSwapStatus =
  | "quote_created"
  | "awaiting_confirmation"
  | "initiated"
  | "executing"
  | "confirming"
  | "completed"
  | "failed"
  | "expired"
  | "blocked_policy";

export function normalizeLoopState(loopState: SwapState): AppSwapStatus {
  switch (loopState) {
    case "INITIATED":
      return "initiated";
    case "PREIMAGE_REVEALED":
    case "HTLC_PUBLISHED":
      return "executing";
    case "INVOICE_SETTLED":
      return "confirming";
    case "SUCCESS":
      return "completed";
    case "FAILED":
      return "failed";
    default:
      return "executing"; // conservative default for unknown states
  }
}

// ─── Event recording ─────────────────────────────────────────────────────

export function recordSwapEvent(
  swapRequestId: string,
  eventType: string,
  eventData: Record<string, unknown>,
  swapExecutionId?: string
): void {
  db.prepare(`
    INSERT INTO swap_events (id, swap_request_id, swap_execution_id, event_type, event_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    swapRequestId,
    swapExecutionId ?? null,
    eventType,
    JSON.stringify(eventData),
    Date.now()
  );
}

// ─── Loop Out provider ───────────────────────────────────────────────────

export type LoopOutQuoteResult = {
  amount_sat: number;
  swap_fee_sat: number;
  prepay_sat: number;
  miner_fee_sat: number;
  total_fee_sat: number;
  conf_target: number;
};

export async function quoteLoopOut(amountSat: number, confTarget?: number): Promise<LoopOutQuoteResult> {
  const q = await getLoopOutQuote(amountSat, confTarget);
  return {
    amount_sat: amountSat,
    swap_fee_sat: q.swap_fee_sat,
    prepay_sat: q.prepay_amt_sat,
    miner_fee_sat: q.miner_fee,
    total_fee_sat: q.total_cost_sats,
    conf_target: q.conf_target,
  };
}

export async function initiateLoopOut(params: {
  amountSat: number;
  destinationAddress: string;
  maxSwapFee: number;
  maxMinerFee: number;
  maxPrepay: number;
  confTarget: number;
  channelIds?: string[];
}): Promise<{ swapHash: string; id: string; serverMessage: string }> {
  return executeLoopOutSwap({
    amt: params.amountSat,
    dest: params.destinationAddress,
    outgoing_chan_set: params.channelIds ?? [],
    max_swap_fee: params.maxSwapFee,
    max_miner_fee: params.maxMinerFee,
    max_prepay_amt: params.maxPrepay,
    sweep_conf_target: params.confTarget,
  }).then((r) => ({
    swapHash: r.swap_hash,
    id: r.id,
    serverMessage: r.server_message,
  }));
}

// ─── Loop In provider ────────────────────────────────────────────────────

export type LoopInQuoteResult = {
  amount_sat: number;
  swap_fee_sat: number;
  htlc_publish_fee_sat: number;
  total_fee_sat: number;
  conf_target: number;
};

export async function quoteLoopIn(amountSat: number, confTarget?: number): Promise<LoopInQuoteResult> {
  const q = await getLoopInQuote(amountSat, confTarget);
  return {
    amount_sat: amountSat,
    swap_fee_sat: q.swap_fee_sat,
    htlc_publish_fee_sat: q.htlc_publish_fee_sat,
    total_fee_sat: q.total_cost_sats,
    conf_target: q.conf_target,
  };
}

export async function initiateLoopIn(params: {
  amountSat: number;
  maxSwapFee: number;
  maxMinerFee: number;
  confTarget: number;
  lastHop?: string;
}): Promise<{ swapHash: string; id: string; serverMessage: string; htlcAddress: string }> {
  return executeLoopInSwap({
    amt: params.amountSat,
    max_swap_fee: params.maxSwapFee,
    max_miner_fee: params.maxMinerFee,
    htlc_conf_target: params.confTarget,
    last_hop: params.lastHop,
  }).then((r) => ({
    swapHash: r.swap_hash,
    id: r.id,
    serverMessage: r.server_message,
    htlcAddress: r.htlc_address,
  }));
}

// ─── Terms ───────────────────────────────────────────────────────────────

export { getLoopOutTerms, getLoopInTerms, isLoopAvailable, listLoopSwaps };

// ─── Fresh on-chain address (for member Loop Out destination) ────────────

export async function generateDestinationAddress(): Promise<string> {
  const { address } = await createLndChainAddress();
  return address;
}
```

**Step 2: Create swapPolicy.ts**

```typescript
// Policy enforcement for swap operations.
// Checks limits, balances, and fee caps before allowing swap initiation.

import { db } from "../db";
import { ENV } from "../config/env";
import { getLndChainBalance } from "../lightning/lnd";
import { getLoopOutTerms, getLoopInTerms } from "../lightning/loop";

export type PolicyResult = { ok: true } | { ok: false; reason: string; code: string };

// ─── Member Loop Out (withdrawal) ────────────────────────────────────────

export async function checkMemberLoopOutPolicy(params: {
  nodePubkey: string;
  amountSat: number;
  maxFeeSat?: number;
  quotedFeeSat: number;
}): Promise<PolicyResult> {
  const { amountSat, maxFeeSat, quotedFeeSat, nodePubkey } = params;

  // Amount bounds
  if (amountSat < ENV.memberMinWithdrawalSat) {
    return { ok: false, reason: `Minimum withdrawal: ${ENV.memberMinWithdrawalSat.toLocaleString()} sats`, code: "below_minimum" };
  }
  if (amountSat > ENV.memberMaxWithdrawalSat) {
    return { ok: false, reason: `Maximum withdrawal: ${ENV.memberMaxWithdrawalSat.toLocaleString()} sats`, code: "above_maximum" };
  }

  // Loop terms
  try {
    const terms = await getLoopOutTerms();
    if (amountSat < terms.min_swap_amount) {
      return { ok: false, reason: `Below Loop minimum: ${terms.min_swap_amount.toLocaleString()} sats`, code: "below_loop_minimum" };
    }
    if (amountSat > terms.max_swap_amount) {
      return { ok: false, reason: `Above Loop maximum: ${terms.max_swap_amount.toLocaleString()} sats`, code: "above_loop_maximum" };
    }
  } catch {
    return { ok: false, reason: "Loop service unavailable", code: "loop_unavailable" };
  }

  // Fee cap
  const feeLimit = maxFeeSat ?? Math.ceil(amountSat * ENV.loopMaxSwapFeePct / 100);
  if (quotedFeeSat > feeLimit) {
    return { ok: false, reason: `Quoted fee (${quotedFeeSat}) exceeds cap (${feeLimit})`, code: "fee_exceeds_cap" };
  }

  // Daily withdrawal limit
  const dayAgo = Date.now() - 86_400_000;
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_sat), 0) AS total
    FROM swap_requests
    WHERE node_pubkey = ? AND role = 'member' AND swap_type = 'loop_out'
      AND status NOT IN ('failed', 'expired', 'blocked_policy')
      AND created_at > ?
  `).get(nodePubkey, dayAgo) as { total: number };

  if (row.total + amountSat > ENV.memberMaxDailyWithdrawalSat) {
    return {
      ok: false,
      reason: `Daily withdrawal limit exceeded (${ENV.memberMaxDailyWithdrawalSat.toLocaleString()} sats/day)`,
      code: "daily_limit_exceeded",
    };
  }

  return { ok: true };
}

// ─── Treasury Loop Out ───────────────────────────────────────────────────

export async function checkTreasuryLoopOutPolicy(params: {
  amountSat: number;
  quotedFeeSat: number;
}): Promise<PolicyResult> {
  const { amountSat, quotedFeeSat } = params;

  try {
    const terms = await getLoopOutTerms();
    if (amountSat < terms.min_swap_amount || amountSat > terms.max_swap_amount) {
      return { ok: false, reason: `Amount outside Loop terms (${terms.min_swap_amount}–${terms.max_swap_amount})`, code: "outside_loop_terms" };
    }
  } catch {
    return { ok: false, reason: "Loop service unavailable", code: "loop_unavailable" };
  }

  const feeLimit = Math.ceil(amountSat * ENV.loopMaxSwapFeePct / 100);
  if (quotedFeeSat > feeLimit) {
    return { ok: false, reason: `Quoted fee exceeds policy cap`, code: "fee_exceeds_cap" };
  }

  return { ok: true };
}

// ─── Treasury Loop In ────────────────────────────────────────────────────

export async function checkTreasuryLoopInPolicy(params: {
  amountSat: number;
  quotedFeeSat: number;
}): Promise<PolicyResult> {
  const { amountSat, quotedFeeSat } = params;

  try {
    const terms = await getLoopInTerms();
    if (amountSat < terms.min_swap_amount || amountSat > terms.max_swap_amount) {
      return { ok: false, reason: `Amount outside Loop In terms (${terms.min_swap_amount}–${terms.max_swap_amount})`, code: "outside_loop_terms" };
    }
  } catch {
    return { ok: false, reason: "Loop service unavailable", code: "loop_unavailable" };
  }

  // Check on-chain balance covers HTLC publish
  try {
    const { chain_balance } = await getLndChainBalance();
    if (chain_balance < amountSat) {
      return { ok: false, reason: `Insufficient on-chain balance (${chain_balance} sats available)`, code: "insufficient_onchain" };
    }
  } catch {
    return { ok: false, reason: "Unable to check on-chain balance", code: "balance_check_failed" };
  }

  const feeLimit = Math.ceil(amountSat * ENV.loopMaxSwapFeePct / 100);
  if (quotedFeeSat > feeLimit) {
    return { ok: false, reason: `Quoted fee exceeds policy cap`, code: "fee_exceeds_cap" };
  }

  return { ok: true };
}
```

**Step 3: Create swapService.ts**

```typescript
// Swap service — orchestrates quote creation, swap initiation, status lookup.
// Delegates to loopProvider for Loop-specific logic.
// Records all state transitions to swap_events for auditability.

import crypto from "crypto";
import { db } from "../db";
import { ENV } from "../config/env";
import {
  quoteLoopOut,
  quoteLoopIn,
  initiateLoopOut,
  initiateLoopIn,
  recordSwapEvent,
  generateDestinationAddress,
  type AppSwapStatus,
  type LoopOutQuoteResult,
  type LoopInQuoteResult,
} from "./loopProvider";

// ─── Types ───────────────────────────────────────────────────────────────

export type SwapRequest = {
  id: string;
  created_at: number;
  updated_at: number;
  node_pubkey: string;
  role: string;
  swap_type: string;
  direction: string;
  status: string;
  amount_sat: number;
  max_fee_sat: number | null;
  quoted_fee_sat: number | null;
  actual_fee_sat: number | null;
  destination_address: string | null;
  channel_id: string | null;
  quote_expires_at: number | null;
  failure_reason: string | null;
  notes: string | null;
};

export type SwapExecution = {
  id: string;
  swap_request_id: string;
  provider: string;
  provider_swap_id: string | null;
  status: string;
  raw_provider_status: string | null;
  onchain_txid: string | null;
  sweep_txid: string | null;
  started_at: number;
  completed_at: number | null;
};

// ─── Quote creation ──────────────────────────────────────────────────────

export async function createLoopOutQuote(params: {
  nodePubkey: string;
  role: "member" | "treasury";
  amountSat: number;
  destinationAddress?: string;
  maxFeeSat?: number;
  channelId?: string;
}): Promise<{ swapRequest: SwapRequest; quote: LoopOutQuoteResult }> {
  const quote = await quoteLoopOut(params.amountSat);
  const now = Date.now();
  const id = crypto.randomUUID();
  const expiresAt = now + ENV.swapQuoteExpirySec * 1000;

  // For member withdrawals, generate a destination address if not provided
  const destAddr = params.destinationAddress || (params.role === "member" ? null : null);

  db.prepare(`
    INSERT INTO swap_requests
      (id, created_at, updated_at, node_pubkey, role, swap_type, direction,
       status, amount_sat, max_fee_sat, quoted_fee_sat, destination_address,
       channel_id, quote_expires_at)
    VALUES (?, ?, ?, ?, ?, 'loop_out', 'lightning_to_chain',
            'quote_created', ?, ?, ?, ?, ?, ?)
  `).run(
    id, now, now, params.nodePubkey, params.role,
    params.amountSat, params.maxFeeSat ?? null, quote.total_fee_sat,
    destAddr, params.channelId ?? null, expiresAt
  );

  recordSwapEvent(id, "quote_created", {
    amount_sat: params.amountSat,
    quote,
    expires_at: expiresAt,
  });

  return {
    swapRequest: getSwapRequest(id)!,
    quote,
  };
}

export async function createLoopInQuote(params: {
  nodePubkey: string;
  role: "treasury";
  amountSat: number;
  maxFeeSat?: number;
}): Promise<{ swapRequest: SwapRequest; quote: LoopInQuoteResult }> {
  const quote = await quoteLoopIn(params.amountSat);
  const now = Date.now();
  const id = crypto.randomUUID();
  const expiresAt = now + ENV.swapQuoteExpirySec * 1000;

  db.prepare(`
    INSERT INTO swap_requests
      (id, created_at, updated_at, node_pubkey, role, swap_type, direction,
       status, amount_sat, max_fee_sat, quoted_fee_sat, quote_expires_at)
    VALUES (?, ?, ?, ?, 'treasury', 'loop_in', 'chain_to_lightning',
            'quote_created', ?, ?, ?, ?)
  `).run(id, now, now, params.nodePubkey, params.amountSat,
    params.maxFeeSat ?? null, quote.total_fee_sat, expiresAt);

  recordSwapEvent(id, "quote_created", { amount_sat: params.amountSat, quote, expires_at: expiresAt });

  return { swapRequest: getSwapRequest(id)!, quote };
}

// ─── Swap initiation ─────────────────────────────────────────────────────

export async function initiateSwap(swapRequestId: string, destinationAddress?: string): Promise<SwapRequest> {
  const req = getSwapRequest(swapRequestId);
  if (!req) throw new Error("Swap request not found");
  if (req.status !== "quote_created" && req.status !== "awaiting_confirmation") {
    throw new Error(`Cannot initiate swap in status: ${req.status}`);
  }
  if (req.quote_expires_at && Date.now() > req.quote_expires_at) {
    updateSwapStatus(swapRequestId, "expired");
    throw new Error("Quote has expired");
  }

  const now = Date.now();
  const execId = crypto.randomUUID();

  // Update destination address if provided (member withdrawals)
  if (destinationAddress) {
    db.prepare("UPDATE swap_requests SET destination_address = ?, updated_at = ? WHERE id = ?")
      .run(destinationAddress, now, swapRequestId);
  }

  const updatedReq = getSwapRequest(swapRequestId)!;

  try {
    if (updatedReq.swap_type === "loop_out") {
      const dest = updatedReq.destination_address;
      if (!dest) throw new Error("Destination address required for Loop Out");

      const result = await initiateLoopOut({
        amountSat: updatedReq.amount_sat,
        destinationAddress: dest,
        maxSwapFee: updatedReq.quoted_fee_sat ?? Math.ceil(updatedReq.amount_sat * ENV.loopMaxSwapFeePct / 100),
        maxMinerFee: ENV.loopMaxMinerFeeSats,
        maxPrepay: updatedReq.quoted_fee_sat ?? 50_000,
        confTarget: ENV.loopConfTarget,
        channelIds: updatedReq.channel_id ? [updatedReq.channel_id] : undefined,
      });

      db.prepare(`
        INSERT INTO swap_executions
          (id, swap_request_id, provider, provider_swap_id, status, started_at)
        VALUES (?, ?, 'loop', ?, 'initiated', ?)
      `).run(execId, swapRequestId, result.swapHash, now);

      updateSwapStatus(swapRequestId, "initiated");
      recordSwapEvent(swapRequestId, "swap_initiated", { provider_swap_id: result.swapHash, server_message: result.serverMessage }, execId);

    } else if (updatedReq.swap_type === "loop_in") {
      const result = await initiateLoopIn({
        amountSat: updatedReq.amount_sat,
        maxSwapFee: updatedReq.quoted_fee_sat ?? Math.ceil(updatedReq.amount_sat * ENV.loopMaxSwapFeePct / 100),
        maxMinerFee: ENV.loopMaxMinerFeeSats,
        confTarget: ENV.loopConfTarget,
      });

      db.prepare(`
        INSERT INTO swap_executions
          (id, swap_request_id, provider, provider_swap_id, htlc_address, status, started_at)
        VALUES (?, ?, 'loop', ?, ?, 'initiated', ?)
      `).run(execId, swapRequestId, result.swapHash, result.htlcAddress, now);

      updateSwapStatus(swapRequestId, "initiated");
      recordSwapEvent(swapRequestId, "swap_initiated", {
        provider_swap_id: result.swapHash,
        htlc_address: result.htlcAddress,
        server_message: result.serverMessage,
      }, execId);

    } else {
      throw new Error(`Unsupported swap type: ${updatedReq.swap_type}`);
    }
  } catch (err: any) {
    updateSwapStatus(swapRequestId, "failed", err.message);
    recordSwapEvent(swapRequestId, "initiation_failed", { error: err.message });
    throw err;
  }

  return getSwapRequest(swapRequestId)!;
}

// ─── Status helpers ──────────────────────────────────────────────────────

export function getSwapRequest(id: string): SwapRequest | null {
  return db.prepare("SELECT * FROM swap_requests WHERE id = ?").get(id) as SwapRequest | null;
}

export function getSwapExecution(swapRequestId: string): SwapExecution | null {
  return db.prepare(
    "SELECT * FROM swap_executions WHERE swap_request_id = ? ORDER BY started_at DESC LIMIT 1"
  ).get(swapRequestId) as SwapExecution | null;
}

export function listSwapRequests(params: {
  nodePubkey?: string;
  role?: string;
  limit?: number;
}): SwapRequest[] {
  let sql = "SELECT * FROM swap_requests WHERE 1=1";
  const args: unknown[] = [];
  if (params.nodePubkey) { sql += " AND node_pubkey = ?"; args.push(params.nodePubkey); }
  if (params.role) { sql += " AND role = ?"; args.push(params.role); }
  sql += " ORDER BY created_at DESC";
  if (params.limit) { sql += " LIMIT ?"; args.push(params.limit); }
  return db.prepare(sql).all(...args) as SwapRequest[];
}

export function getSwapEvents(swapRequestId: string): Array<{
  id: string; event_type: string; event_json: string; created_at: number;
}> {
  return db.prepare(
    "SELECT * FROM swap_events WHERE swap_request_id = ? ORDER BY created_at ASC"
  ).all(swapRequestId) as any[];
}

function updateSwapStatus(id: string, status: AppSwapStatus, failureReason?: string): void {
  const now = Date.now();
  if (failureReason) {
    db.prepare("UPDATE swap_requests SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
      .run(status, failureReason, now, id);
  } else {
    db.prepare("UPDATE swap_requests SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);
  }
  recordSwapEvent(id, "status_changed", { new_status: status, failure_reason: failureReason ?? null });
}

// Exported for use by swapPoller
export { updateSwapStatus };
```

**Step 4: Create swapPoller.ts**

```typescript
// Swap poller — periodically matches in-flight swap_executions to Loop provider states.
// Runs on a 15s interval, matching the existing sync loop pattern.

import { db } from "../db";
import { listLoopSwaps, type SwapInfo } from "../lightning/loop";
import { normalizeLoopState, recordSwapEvent } from "./loopProvider";

/**
 * Poll Loop for status updates on in-flight swaps.
 * Called every 15s from index.ts alongside the LND sync loop.
 */
export async function pollSwapStatuses(): Promise<void> {
  // Find non-terminal executions
  const inflight = db.prepare(`
    SELECT se.*, sr.status AS request_status, sr.id AS req_id
    FROM swap_executions se
    JOIN swap_requests sr ON se.swap_request_id = sr.id
    WHERE se.status NOT IN ('completed', 'failed')
      AND se.provider_swap_id IS NOT NULL
  `).all() as Array<{
    id: string;
    swap_request_id: string;
    provider_swap_id: string;
    status: string;
    req_id: string;
    request_status: string;
  }>;

  if (inflight.length === 0) return;

  let swaps: SwapInfo[];
  try {
    swaps = await listLoopSwaps();
  } catch (err: any) {
    console.warn("[swap-poller] Failed to list Loop swaps:", err.message);
    return;
  }

  const swapMap = new Map(swaps.map((s) => [s.id, s]));
  const now = Date.now();

  for (const exec of inflight) {
    const loopSwap = swapMap.get(exec.provider_swap_id);
    if (!loopSwap) continue;

    const newAppStatus = normalizeLoopState(loopSwap.state);
    const oldStatus = exec.status;

    if (newAppStatus === oldStatus) continue;

    // Update execution
    db.prepare(`
      UPDATE swap_executions
      SET status = ?, raw_provider_status = ?, completed_at = ?
      WHERE id = ?
    `).run(
      newAppStatus,
      loopSwap.state,
      newAppStatus === "completed" || newAppStatus === "failed" ? now : null,
      exec.id
    );

    // Update request
    const actualFee = newAppStatus === "completed"
      ? loopSwap.cost_server + loopSwap.cost_onchain + loopSwap.cost_offchain
      : null;

    if (actualFee !== null) {
      db.prepare("UPDATE swap_requests SET status = ?, actual_fee_sat = ?, updated_at = ? WHERE id = ?")
        .run(newAppStatus, actualFee, now, exec.swap_request_id);
    } else if (newAppStatus === "failed") {
      db.prepare("UPDATE swap_requests SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
        .run("failed", `Loop state: ${loopSwap.state}`, now, exec.swap_request_id);
    } else {
      db.prepare("UPDATE swap_requests SET status = ?, updated_at = ? WHERE id = ?")
        .run(newAppStatus, now, exec.swap_request_id);
    }

    recordSwapEvent(exec.swap_request_id, "provider_update", {
      old_status: oldStatus,
      new_status: newAppStatus,
      loop_state: loopSwap.state,
      cost_server: loopSwap.cost_server,
      cost_onchain: loopSwap.cost_onchain,
      cost_offchain: loopSwap.cost_offchain,
    }, exec.id);

    console.log(`[swap-poller] ${exec.swap_request_id}: ${oldStatus} → ${newAppStatus} (loop: ${loopSwap.state})`);
  }
}

/** Start the swap poller on a 15s interval. */
export function startSwapPoller(): void {
  setInterval(() => {
    pollSwapStatuses().catch((err) =>
      console.warn("[swap-poller] tick error:", err.message)
    );
  }, 15_000);
  console.log("[swap-poller] started (15s interval)");
}
```

**Step 5: Verify build**

Run: `cd app/api && npm run build`

**Step 6: Commit**

```bash
git add app/api/src/swaps/
git commit -m "feat: swap service layer — loopProvider, swapPolicy, swapService, swapPoller"
```

---

## Task 5: API Route Handlers

**Files:**
- Create: `app/api/src/swaps/swapRoutes.ts`
- Modify: `app/api/src/index.ts`

**Step 1: Create swapRoutes.ts**

```typescript
// Swap API route handlers — member withdrawal + treasury swap operations.
// Follows the same pattern as liquidityRoutes.ts and other route handlers.

import type { IncomingMessage, ServerResponse } from "http";
import { getNodeInfo } from "../api/read";
import { assertTreasury } from "../utils/role";
import { assertActiveMember } from "../utils/membership";
import {
  createLoopOutQuote,
  createLoopInQuote,
  initiateSwap,
  getSwapRequest,
  getSwapExecution,
  getSwapEvents,
  listSwapRequests,
} from "./swapService";
import {
  checkMemberLoopOutPolicy,
  checkTreasuryLoopOutPolicy,
  checkTreasuryLoopInPolicy,
} from "./swapPolicy";
import { isLoopAvailable } from "./loopProvider";

type Res = ServerResponse;

function json(res: Res, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => resolve(body));
  });
}

// ─── Member endpoints ────────────────────────────────────────────────────

export async function handleMemberLoopOutQuote(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });
  if (node.node_role !== "treasury") assertActiveMember(node.membership_status);

  const body = JSON.parse(await parseBody(req));
  const amountSat = Number(body.amount_sat);
  const destinationAddress = body.destination_address as string | undefined;
  const maxFeeSat = body.max_fee_sat ? Number(body.max_fee_sat) : undefined;

  if (!amountSat || amountSat <= 0) return json(res, 400, { error: "invalid_amount" });

  const loopStatus = await isLoopAvailable();
  if (!loopStatus.available) return json(res, 503, { error: "loop_unavailable", detail: loopStatus.error });

  const { swapRequest, quote } = await createLoopOutQuote({
    nodePubkey: node.pubkey,
    role: node.node_role === "treasury" ? "treasury" : "member",
    amountSat,
    destinationAddress,
    maxFeeSat,
  });

  // Pre-check policy (non-blocking — quote still created)
  const policy = await checkMemberLoopOutPolicy({
    nodePubkey: node.pubkey,
    amountSat,
    maxFeeSat,
    quotedFeeSat: quote.total_fee_sat,
  });

  json(res, 200, { swap_request: swapRequest, quote, policy_check: policy });
}

export async function handleMemberLoopOut(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });
  if (node.node_role !== "treasury") assertActiveMember(node.membership_status);

  const body = JSON.parse(await parseBody(req));
  const swapRequestId = body.swap_request_id as string;
  const destinationAddress = body.destination_address as string;

  if (!swapRequestId) return json(res, 400, { error: "swap_request_id_required" });
  if (!destinationAddress) return json(res, 400, { error: "destination_address_required" });

  const existing = getSwapRequest(swapRequestId);
  if (!existing) return json(res, 404, { error: "swap_request_not_found" });
  if (existing.node_pubkey !== node.pubkey) return json(res, 403, { error: "not_your_swap" });

  // Enforce policy before execution
  const policy = await checkMemberLoopOutPolicy({
    nodePubkey: node.pubkey,
    amountSat: existing.amount_sat,
    quotedFeeSat: existing.quoted_fee_sat ?? 0,
  });
  if (!policy.ok) return json(res, 429, { error: "policy_violation", detail: policy.reason, code: policy.code });

  const result = await initiateSwap(swapRequestId, destinationAddress);
  json(res, 200, { swap_request: result, execution: getSwapExecution(swapRequestId) });
}

export async function handleGetSwap(req: IncomingMessage, res: Res, swapId: string): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });

  const swap = getSwapRequest(swapId);
  if (!swap) return json(res, 404, { error: "swap_not_found" });

  // Members can only see their own swaps; treasury can see all
  if (node.node_role !== "treasury" && swap.node_pubkey !== node.pubkey) {
    return json(res, 403, { error: "not_your_swap" });
  }

  const execution = getSwapExecution(swapId);
  const events = getSwapEvents(swapId);
  json(res, 200, { swap_request: swap, execution, events });
}

export async function handleSwapHistory(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });

  const url = new URL(req.url ?? "", "http://localhost");
  const limit = Number(url.searchParams.get("limit")) || 20;

  const swaps = listSwapRequests({
    nodePubkey: node.node_role === "treasury" ? undefined : node.pubkey,
    limit,
  });

  json(res, 200, { swaps });
}

// ─── Treasury (admin) endpoints ──────────────────────────────────────────

export async function handleAdminLoopOutQuote(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const body = JSON.parse(await parseBody(req));
  const amountSat = Number(body.amount_sat);
  const channelId = body.channel_id as string | undefined;
  if (!amountSat || amountSat <= 0) return json(res, 400, { error: "invalid_amount" });

  const { swapRequest, quote } = await createLoopOutQuote({
    nodePubkey: node!.pubkey,
    role: "treasury",
    amountSat,
    channelId,
  });

  const policy = await checkTreasuryLoopOutPolicy({ amountSat, quotedFeeSat: quote.total_fee_sat });
  json(res, 200, { swap_request: swapRequest, quote, policy_check: policy });
}

export async function handleAdminLoopOut(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const body = JSON.parse(await parseBody(req));
  const swapRequestId = body.swap_request_id as string;
  const destinationAddress = body.destination_address as string | undefined;

  if (!swapRequestId) return json(res, 400, { error: "swap_request_id_required" });

  const existing = getSwapRequest(swapRequestId);
  if (!existing) return json(res, 404, { error: "swap_request_not_found" });

  const policy = await checkTreasuryLoopOutPolicy({
    amountSat: existing.amount_sat,
    quotedFeeSat: existing.quoted_fee_sat ?? 0,
  });
  if (!policy.ok) return json(res, 429, { error: "policy_violation", detail: policy.reason, code: policy.code });

  const result = await initiateSwap(swapRequestId, destinationAddress);
  json(res, 200, { swap_request: result, execution: getSwapExecution(swapRequestId) });
}

export async function handleAdminLoopInQuote(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const body = JSON.parse(await parseBody(req));
  const amountSat = Number(body.amount_sat);
  if (!amountSat || amountSat <= 0) return json(res, 400, { error: "invalid_amount" });

  const { swapRequest, quote } = await createLoopInQuote({
    nodePubkey: node!.pubkey,
    role: "treasury",
    amountSat,
  });

  const policy = await checkTreasuryLoopInPolicy({ amountSat, quotedFeeSat: quote.total_fee_sat });
  json(res, 200, { swap_request: swapRequest, quote, policy_check: policy });
}

export async function handleAdminLoopIn(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const body = JSON.parse(await parseBody(req));
  const swapRequestId = body.swap_request_id as string;
  if (!swapRequestId) return json(res, 400, { error: "swap_request_id_required" });

  const existing = getSwapRequest(swapRequestId);
  if (!existing) return json(res, 404, { error: "swap_request_not_found" });

  const policy = await checkTreasuryLoopInPolicy({
    amountSat: existing.amount_sat,
    quotedFeeSat: existing.quoted_fee_sat ?? 0,
  });
  if (!policy.ok) return json(res, 429, { error: "policy_violation", detail: policy.reason, code: policy.code });

  const result = await initiateSwap(swapRequestId);
  json(res, 200, { swap_request: result, execution: getSwapExecution(swapRequestId) });
}

export async function handleAdminSwapList(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const url = new URL(req.url ?? "", "http://localhost");
  const limit = Number(url.searchParams.get("limit")) || 50;
  const swaps = listSwapRequests({ limit });
  json(res, 200, { swaps });
}

export async function handleAdminGetSwap(req: IncomingMessage, res: Res, swapId: string): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const swap = getSwapRequest(swapId);
  if (!swap) return json(res, 404, { error: "swap_not_found" });
  const execution = getSwapExecution(swapId);
  const events = getSwapEvents(swapId);
  json(res, 200, { swap_request: swap, execution, events });
}
```

**Step 2: Add swap routes to index.ts**

Add import at the top of `index.ts` (after the existing imports around line 78):

```typescript
import {
  handleMemberLoopOutQuote,
  handleMemberLoopOut,
  handleGetSwap,
  handleSwapHistory,
  handleAdminLoopOutQuote,
  handleAdminLoopOut,
  handleAdminLoopInQuote,
  handleAdminLoopIn,
  handleAdminSwapList,
  handleAdminGetSwap,
} from "./swaps/swapRoutes";
import { startSwapPoller } from "./swaps/swapPoller";
```

Add route handlers in the request handler (before the final 404, search for a good insertion point — after the member-liquidity endpoints):

```typescript
  // ═══════════════════════════════════════════════════════════════════════
  // SWAP ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════

  // Member swap endpoints
  if (req.method === "POST" && req.url === "/api/swaps/loop-out/quote") {
    try { await handleMemberLoopOutQuote(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") || e.message?.includes("authorized") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/swaps/loop-out") {
    try { await handleMemberLoopOut(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") || e.message?.includes("authorized") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/swaps/history") {
    try { await handleSwapHistory(req, res); } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/swaps/") && !req.url.includes("/admin/")) {
    const swapId = req.url.split("/api/swaps/")[1]?.split("?")[0];
    if (swapId && swapId !== "history") {
      try { await handleGetSwap(req, res, swapId); } catch (e: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  // Admin swap endpoints
  if (req.method === "POST" && req.url === "/api/admin/swaps/loop-out/quote") {
    try { await handleAdminLoopOutQuote(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/admin/swaps/loop-out") {
    try { await handleAdminLoopOut(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/admin/swaps/loop-in/quote") {
    try { await handleAdminLoopInQuote(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/admin/swaps/loop-in") {
    try { await handleAdminLoopIn(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/api/admin/swaps") {
    try { await handleAdminSwapList(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/admin/swaps/")) {
    const swapId = req.url.split("/api/admin/swaps/")[1]?.split("?")[0];
    if (swapId) {
      try { await handleAdminGetSwap(req, res, swapId); } catch (e: any) {
        res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }
```

Add swap poller start in the `server.listen` callback (alongside the other scheduler starts):

```typescript
  startSwapPoller();
```

**Step 3: Verify build**

Run: `cd app/api && npm run build`

**Step 4: Commit**

```bash
git add app/api/src/swaps/swapRoutes.ts app/api/src/index.ts
git commit -m "feat: add swap API routes — member withdrawal + treasury Loop In/Out"
```

---

## Task 6: Keysend Deprecation in Liquidity Layer

**Files:**
- Modify: `app/api/src/memberLiquidity/liquidityExecutor.ts` (add deprecation comment)
- Modify: `app/api/src/memberAdvisor/loopAvailability.ts` (wire Loop In)

**Step 1: Add deprecation comment to liquidityExecutor.ts**

Add at the top of the file (after imports):

```typescript
// ⚠️ DEPRECATED: Keysend push execution path.
// As of v1.7.0, the active liquidity execution path uses the swap subsystem
// (src/swaps/swapService.ts) instead of direct keysend push.
// This file is retained for reference but is no longer called from liquidityRoutes.ts.
// The approve handler now creates a liquidity_action + swap_request instead.
```

**Step 2: Wire Loop In availability in loopAvailability.ts**

Replace the Loop In stub section with real implementation. Find the section that says `// loopd supports LoopInTerms RPC but we haven't wrapped it` and replace:

```typescript
  // Loop In availability — real gRPC check
  let loopInAvailable = false;
  let loopInTerms: { minSats: number; maxSats: number } | null = null;
  try {
    const { getLoopInTerms } = await import("../lightning/loop");
    const terms = await getLoopInTerms();
    loopInAvailable = true;
    loopInTerms = { minSats: terms.min_swap_amount, maxSats: terms.max_swap_amount };
  } catch {
    // Loop In not available
  }
```

**Step 3: Verify build**

Run: `cd app/api && npm run build`

**Step 4: Commit**

```bash
git add app/api/src/memberLiquidity/liquidityExecutor.ts app/api/src/memberAdvisor/loopAvailability.ts
git commit -m "refactor: deprecate keysend executor, wire real Loop In availability"
```

---

## Task 7: Frontend API Client Types

**Files:**
- Modify: `app/web/src/api/client.ts`

**Step 1: Add swap types and API methods**

Add to the types section of `client.ts`:

```typescript
// ─── Swap types ───────────────────────────────────────────────────────────

export type SwapRequest = {
  id: string;
  created_at: number;
  updated_at: number;
  node_pubkey: string;
  role: string;
  swap_type: string;
  direction: string;
  status: string;
  amount_sat: number;
  max_fee_sat: number | null;
  quoted_fee_sat: number | null;
  actual_fee_sat: number | null;
  destination_address: string | null;
  channel_id: string | null;
  quote_expires_at: number | null;
  failure_reason: string | null;
  notes: string | null;
};

export type SwapExecution = {
  id: string;
  swap_request_id: string;
  provider: string;
  provider_swap_id: string | null;
  status: string;
  raw_provider_status: string | null;
  onchain_txid: string | null;
  sweep_txid: string | null;
  started_at: number;
  completed_at: number | null;
};

export type SwapEvent = {
  id: string;
  event_type: string;
  event_json: string;
  created_at: number;
};

export type SwapQuoteResponse = {
  swap_request: SwapRequest;
  quote: {
    amount_sat: number;
    swap_fee_sat: number;
    total_fee_sat: number;
    conf_target: number;
    prepay_sat?: number;
    miner_fee_sat?: number;
    htlc_publish_fee_sat?: number;
  };
  policy_check: { ok: true } | { ok: false; reason: string; code: string };
};

export type SwapDetailResponse = {
  swap_request: SwapRequest;
  execution: SwapExecution | null;
  events: SwapEvent[];
};
```

Add to the `api` object:

```typescript
  // Swaps — member
  getSwapLoopOutQuote: (body: { amount_sat: number; destination_address?: string; max_fee_sat?: number }) =>
    apiFetch<SwapQuoteResponse>("/api/swaps/loop-out/quote", { method: "POST", body: JSON.stringify(body) }),
  initiateSwapLoopOut: (body: { swap_request_id: string; destination_address: string }) =>
    apiFetch<{ swap_request: SwapRequest; execution: SwapExecution }>("/api/swaps/loop-out", { method: "POST", body: JSON.stringify(body) }),
  getSwap: (id: string) => apiFetch<SwapDetailResponse>(`/api/swaps/${id}`),
  getSwapHistory: (limit?: number) => {
    const q = limit ? `?limit=${limit}` : "";
    return apiFetch<{ swaps: SwapRequest[] }>(`/api/swaps/history${q}`);
  },
  // Swaps — admin
  adminLoopOutQuote: (body: { amount_sat: number; channel_id?: string }) =>
    apiFetch<SwapQuoteResponse>("/api/admin/swaps/loop-out/quote", { method: "POST", body: JSON.stringify(body) }),
  adminLoopOut: (body: { swap_request_id: string; destination_address?: string }) =>
    apiFetch<{ swap_request: SwapRequest; execution: SwapExecution }>("/api/admin/swaps/loop-out", { method: "POST", body: JSON.stringify(body) }),
  adminLoopInQuote: (body: { amount_sat: number }) =>
    apiFetch<SwapQuoteResponse>("/api/admin/swaps/loop-in/quote", { method: "POST", body: JSON.stringify(body) }),
  adminLoopIn: (body: { swap_request_id: string }) =>
    apiFetch<{ swap_request: SwapRequest; execution: SwapExecution }>("/api/admin/swaps/loop-in", { method: "POST", body: JSON.stringify(body) }),
  adminSwapList: (limit?: number) => {
    const q = limit ? `?limit=${limit}` : "";
    return apiFetch<{ swaps: SwapRequest[] }>(`/api/admin/swaps${q}`);
  },
  adminGetSwap: (id: string) => apiFetch<SwapDetailResponse>(`/api/admin/swaps/${id}`),
```

**Step 2: Verify build**

Run: `cd app/web && npx vite build`

**Step 3: Commit**

```bash
git add app/web/src/api/client.ts
git commit -m "feat: add swap types and API methods to frontend client"
```

---

## Task 8: Member "Withdraw to Bitcoin Wallet" Page

**Files:**
- Create: `app/web/src/pages/WithdrawBitcoin.tsx`
- Modify: `app/web/src/App.tsx` (add route + nav)

**Step 1: Create WithdrawBitcoin.tsx**

This page follows the existing patterns from Payments.tsx and DepositBitcoin.tsx:
- Amount input with presets
- Bitcoin address input
- Quote → confirm → status flow
- 15s polling for status updates
- Recent withdrawal history

(Full implementation — ~300 lines. Creates the complete page with quote panel, confirmation panel, status tracking panel, and history table.)

**Step 2: Add route and nav in App.tsx**

Add import alongside other page imports:
```typescript
import WithdrawBitcoin from "./pages/WithdrawBitcoin";
```

Add NavLink in MemberSidebar (after Deposit Bitcoin):
```typescript
<NavLink to="/withdraw" className={({isActive}) => `sidebar-item ${isActive ? "active" : ""}`}>
  <span className="icon">↗</span>Withdraw Bitcoin
</NavLink>
```

Add Route in MemberShell Routes:
```typescript
<Route path="/withdraw" element={<WithdrawBitcoin />} />
```

Also add to AppShell so treasury can test the flow.

**Step 3: Verify build**

Run: `cd app/web && npx vite build`

**Step 4: Commit**

```bash
git add app/web/src/pages/WithdrawBitcoin.tsx app/web/src/App.tsx
git commit -m "feat: member Withdraw to Bitcoin Wallet page"
```

---

## Task 9: Treasury Swap Operations Page

**Files:**
- Create: `app/web/src/pages/SwapOperations.tsx`
- Modify: `app/web/src/App.tsx` (add route + nav for treasury shell)

**Step 1: Create SwapOperations.tsx**

Treasury-only page with:
- Loop Out tab (restore inbound capacity)
- Loop In tab (add inbound capacity via on-chain)
- Amount input, optional channel selector, fee cap
- Quote → confirm → status flow
- All swaps history table

**Step 2: Add route and nav in App.tsx**

Add to TreasurySidebar and AppShell Routes.

**Step 3: Verify build and commit**

```bash
git add app/web/src/pages/SwapOperations.tsx app/web/src/App.tsx
git commit -m "feat: treasury Swap Operations page (Loop In + Loop Out)"
```

---

## Task 10: Version Bump and Final Verification

**Files:**
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

**Step 1: Bump version to 1.7.0** (major feature)

**Step 2: Full build verification**

```bash
cd app/api && npm run build
cd ../web && npx vite build
```

**Step 3: Commit and push**

```bash
git add -A
git commit -m "chore: bump version to 1.7.0"
git push -u origin feature/swap-subsystem
```

**Step 4: Create PR**

---

## TODOs After Initial Implementation

1. **Provider-specific Loop In fields**: The `LoopInRequest` proto supports `last_hop`, `route_hints`, and `external_htlc` — currently not exposed. Add as needed for routing optimization.
2. **Treasury Loop In destination address**: Loop In sends on-chain from the node's wallet to publish the HTLC. The `htlc_address` returned is for monitoring, not a deposit address. Consider surfacing this in the UI.
3. **Expired quote cleanup**: Add a periodic job to mark `quote_created` swaps as `expired` when `quote_expires_at` passes. Currently the expiry is checked at initiation time only.
4. **Member balance check**: The policy layer checks Loop terms but doesn't verify the member has enough Lightning balance to cover the swap. Add a `getNodeBalances()` check in `checkMemberLoopOutPolicy`.
5. **CLAUDE.md update**: Document new endpoints, tables, and the swap status model.
