# Keysend Push Rebalance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace circular rebalancing with keysend push rebalancing for hub-and-spoke topology where circular routes are impossible.

**Architecture:** Standalone `rebalance-keysend.ts` module wraps `payViaPaymentDetails` (ln-service keysend). Treasury pushes sats directly to member nodes on critical channels (>85% local). Reuses existing execution tracking, loss cap, and scheduler infrastructure. Two new treasury-only API endpoints.

**Tech Stack:** TypeScript, ln-service (`payViaPaymentDetails`), better-sqlite3, raw HTTP server (no Express).

---

### Task 1: Add `payViaPaymentDetails` type to ln-service declarations

**Files:**
- Modify: `app/api/src/types/ln-service.d.ts` (after line 223, before `getNode`)

**Step 1: Add the type declaration**

Insert after the `payViaRoutes` declaration (line 223) and before `getNode` (line 225):

```typescript
  export function payViaPaymentDetails(options: {
    lnd: any;
    destination: string;
    tokens: number;
    id?: string;
    max_fee?: number;
    outgoing_channel?: string;
    features?: { type: number; is_required?: boolean }[];
    messages?: { type: string; value: string }[];
  }): Promise<{
    fee: number;
    fee_mtokens: string;
    id: string;
    is_confirmed: boolean;
    tokens: number;
    secret: string;
  }>;
```

**Step 2: Verify API builds**

Run: `cd app/api && npm run build`
Expected: Success (no errors)

**Step 3: Commit**

```bash
git add app/api/src/types/ln-service.d.ts
git commit -m "feat: add payViaPaymentDetails type declaration for keysend"
```

---

### Task 2: Add `keysendPush()` wrapper to lnd.ts

**Files:**
- Modify: `app/api/src/lightning/lnd.ts` (add import + new function after `createLndChainAddress`)

**Step 1: Add `payViaPaymentDetails` to the import block**

In `app/api/src/lightning/lnd.ts` line 1-19, add `payViaPaymentDetails` to the import from "ln-service". The last import is currently `createChainAddress` — add it after:

```typescript
import {
  authenticatedLndGrpc,
  getWalletInfo,
  getIdentity,
  getPeers,
  getChannels,
  getInvoices,
  getForwards,
  getChainBalance,
  addPeer,
  openChannel,
  closeChannel,
  getPendingChannels,
  createInvoice,
  getRouteToDestination,
  payViaRoutes,
  createChainAddress,
  payViaPaymentDetails
} from "ln-service";
```

Also add `import crypto from "crypto";` after the existing `import fs from "fs";` (line 20).

**Step 2: Add the `keysendPush` function**

Append after `createLndChainAddress` (after line 273):

```typescript
/**
 * Keysend push: sends sats directly to a peer via their pubkey using
 * payViaPaymentDetails. No invoice needed — the payment preimage is
 * generated locally and included via the keysend TLV (type 5482373484).
 *
 * @param destination - Peer's public key
 * @param tokens - Amount in sats to push
 * @param maxFee - Maximum routing fee in sats (usually 0 for direct peer)
 * @param outgoingChannel - Optional: force payment through this channel
 */
export async function keysendPush(options: {
  destination: string;
  tokens: number;
  max_fee?: number;
  outgoing_channel?: string;
}): Promise<{
  fee: number;
  id: string;
  is_confirmed: boolean;
  tokens: number;
  secret: string;
}> {
  const { lnd } = getLndClient();
  const preimage = crypto.randomBytes(32);
  const id = crypto.createHash("sha256").update(preimage).digest("hex");

  return payViaPaymentDetails({
    lnd,
    destination: options.destination,
    tokens: options.tokens,
    id,
    max_fee: options.max_fee ?? 0,
    outgoing_channel: options.outgoing_channel,
    features: [{ type: 9, is_required: true }],
    messages: [{
      type: "5482373484",
      value: preimage.toString("hex"),
    }],
  });
}
```

**Step 3: Verify API builds**

Run: `cd app/api && npm run build`
Expected: Success

**Step 4: Commit**

```bash
git add app/api/src/lightning/lnd.ts
git commit -m "feat: add keysendPush() wrapper for direct peer payments"
```

---

### Task 3: Create `rebalance-keysend.ts` — core execution logic

**Files:**
- Create: `app/api/src/lightning/rebalance-keysend.ts`

**Step 1: Write the module**

Create `app/api/src/lightning/rebalance-keysend.ts`:

```typescript
/**
 * Keysend push rebalance: treasury pushes sats directly to a member node
 * on the existing channel. No invoice, no routing through third parties.
 *
 * Only effective for "critical" channels (>85% local on treasury side).
 * Pushing to outbound_starved channels worsens the imbalance.
 */

import { getLndChannels } from "./lnd";
import { keysendPush } from "./lnd";
import { getLiquidityHealth, type ChannelLiquidityHealth } from "../api/treasury-liquidity-health";
import { assertDailyLossCapNotExceeded, DailyLossCapError } from "../utils/loss-cap";
import { createRebalanceExecution, updateRebalanceExecution } from "../api/treasury-rebalance-executions";
import { insertRebalanceCost } from "../api/treasury-rebalance-costs";

/** Safety bounds */
const MIN_PUSH_SATS = 10_000;
const MAX_PUSH_SATS = 100_000;
const MAX_LOCAL_RATIO = 0.50; // never push more than 50% of local balance

export type KeysendRebalanceResult = {
  channel_id: string;
  peer_pubkey: string;
  amount_sats: number;
  fee_paid_sats: number;
  payment_hash: string;
  status: "succeeded" | "failed";
  warning?: string;
  error?: string;
};

export class KeysendRebalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeysendRebalanceError";
  }
}

/**
 * Execute a keysend push to a specific channel.
 *
 * @param channel_id - The channel to push sats through
 * @param amount_sats - Amount to push
 * @param max_fee_sats - Maximum fee (default 0 — direct peer, no routing)
 */
export async function executeKeysendRebalance(params: {
  channel_id: string;
  amount_sats: number;
  max_fee_sats?: number;
}): Promise<KeysendRebalanceResult> {
  const { channel_id, amount_sats, max_fee_sats = 0 } = params;

  if (!Number.isFinite(amount_sats) || amount_sats <= 0) {
    throw new KeysendRebalanceError("amount_sats must be a positive number");
  }
  if (amount_sats < MIN_PUSH_SATS) {
    throw new KeysendRebalanceError(`amount_sats must be at least ${MIN_PUSH_SATS} sats`);
  }
  if (amount_sats > MAX_PUSH_SATS) {
    throw new KeysendRebalanceError(`amount_sats must not exceed ${MAX_PUSH_SATS} sats`);
  }

  // Find the channel in LND
  const { channels } = await getLndChannels();
  const channel = channels.find((c) => c.id === channel_id);
  if (!channel) {
    throw new KeysendRebalanceError(`Channel not found: ${channel_id}`);
  }
  if (!channel.is_active) {
    throw new KeysendRebalanceError(`Channel is not active: ${channel_id}`);
  }

  // Safety: never push more than 50% of local balance
  const maxSafe = Math.floor(channel.local_balance * MAX_LOCAL_RATIO);
  if (amount_sats > maxSafe) {
    throw new KeysendRebalanceError(
      `amount_sats (${amount_sats}) exceeds 50% of local balance (${channel.local_balance}). Max safe: ${maxSafe}`
    );
  }

  // Check health classification for warning
  const health = getLiquidityHealth();
  const channelHealth = health.find((h) => h.channel_id === channel_id);
  const warning =
    channelHealth && channelHealth.health_classification !== "critical"
      ? `Channel is ${channelHealth.health_classification}, not critical. Keysend push is most effective on critical channels (>85% local).`
      : undefined;

  // Daily loss cap
  assertDailyLossCapNotExceeded(max_fee_sats);

  // Create execution record
  const execId = createRebalanceExecution({
    type: "keysend",
    tokens: amount_sats,
    outgoing_channel: channel_id,
    incoming_channel: channel_id, // same channel — direct push
    max_fee_sats,
  });

  try {
    updateRebalanceExecution(execId, "submitted");

    const result = await keysendPush({
      destination: channel.partner_public_key,
      tokens: amount_sats,
      max_fee: max_fee_sats,
      outgoing_channel: channel_id,
    });

    const feePaid = result.fee ?? 0;
    updateRebalanceExecution(execId, "succeeded", result.id, feePaid, null);

    if (feePaid > 0) {
      insertRebalanceCost("keysend" as any, amount_sats, feePaid, channel_id);
    }

    return {
      channel_id,
      peer_pubkey: channel.partner_public_key,
      amount_sats,
      fee_paid_sats: feePaid,
      payment_hash: result.id,
      status: "succeeded",
      warning,
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    updateRebalanceExecution(execId, "failed", null, null, msg);

    return {
      channel_id,
      peer_pubkey: channel.partner_public_key,
      amount_sats,
      fee_paid_sats: 0,
      payment_hash: "",
      status: "failed",
      error: msg,
      warning,
    };
  }
}

/**
 * Auto-rebalance all critical channels via keysend push.
 * Targets channels with >85% local ratio. Pushes enough to bring each
 * toward 50% local ratio, bounded by MIN/MAX push limits.
 */
export async function autoKeysendRebalance(): Promise<{
  ok: boolean;
  results: KeysendRebalanceResult[];
}> {
  const health = getLiquidityHealth();

  const criticalChannels = health
    .filter((h) => h.is_active && h.health_classification === "critical")
    .sort((a, b) => b.imbalance_ratio - a.imbalance_ratio); // worst first

  if (criticalChannels.length === 0) {
    return { ok: true, results: [] };
  }

  // Check daily loss cap once before processing
  assertDailyLossCapNotExceeded(0);

  const results: KeysendRebalanceResult[] = [];

  for (const ch of criticalChannels) {
    // Calculate amount to bring toward 50% local ratio
    const targetLocal = Math.floor(ch.capacity_sats * 0.5);
    const excess = ch.local_sats - targetLocal;
    const pushAmount = Math.min(MAX_PUSH_SATS, Math.max(MIN_PUSH_SATS, excess));

    // Safety: skip if calculated amount is below minimum
    if (pushAmount < MIN_PUSH_SATS) continue;

    // Safety: skip if push would exceed 50% of local
    const maxSafe = Math.floor(ch.local_sats * MAX_LOCAL_RATIO);
    if (pushAmount > maxSafe) continue;

    try {
      const result = await executeKeysendRebalance({
        channel_id: ch.channel_id,
        amount_sats: pushAmount,
        max_fee_sats: 0,
      });
      results.push(result);
    } catch (err: any) {
      // DailyLossCapError halts the entire auto run
      if (err instanceof DailyLossCapError) {
        break;
      }
      // Other errors: record and continue to next channel
      results.push({
        channel_id: ch.channel_id,
        peer_pubkey: ch.peer_pubkey,
        amount_sats: pushAmount,
        fee_paid_sats: 0,
        payment_hash: "",
        status: "failed",
        error: err?.message ?? String(err),
      });
    }
  }

  return { ok: true, results };
}
```

**Step 2: Verify API builds**

Run: `cd app/api && npm run build`
Expected: Success

**Step 3: Commit**

```bash
git add app/api/src/lightning/rebalance-keysend.ts
git commit -m "feat: add keysend push rebalance execution and auto-select"
```

---

### Task 4: Update the rebalance cost type

The `RebalanceCostType` in `app/api/src/api/treasury-rebalance-costs.ts` line 3 currently only allows `"circular" | "loop_out" | "loop_in" | "manual"`. Add `"keysend"`.

**Files:**
- Modify: `app/api/src/api/treasury-rebalance-costs.ts:3`

**Step 1: Add "keysend" to the type union**

Change line 3 from:
```typescript
export type RebalanceCostType = "circular" | "loop_out" | "loop_in" | "manual";
```
to:
```typescript
export type RebalanceCostType = "circular" | "keysend" | "loop_out" | "loop_in" | "manual";
```

**Step 2: Update rebalance-keysend.ts**

In `app/api/src/lightning/rebalance-keysend.ts`, remove the `as any` cast on the `insertRebalanceCost` call (it was a workaround). Change:
```typescript
insertRebalanceCost("keysend" as any, amount_sats, feePaid, channel_id);
```
to:
```typescript
insertRebalanceCost("keysend", amount_sats, feePaid, channel_id);
```

**Step 3: Verify API builds**

Run: `cd app/api && npm run build`
Expected: Success

**Step 4: Commit**

```bash
git add app/api/src/api/treasury-rebalance-costs.ts app/api/src/lightning/rebalance-keysend.ts
git commit -m "feat: add 'keysend' to RebalanceCostType union"
```

---

### Task 5: Update the scheduler to use keysend instead of circular

**Files:**
- Modify: `app/api/src/lightning/rebalance-scheduler.ts`

The scheduler currently:
1. Filters channels for `outbound_starved` OR `critical` (lines 53-56)
2. Picks donor/receiver pairs and calls `executeCircularRebalance` (line 147)

Replace with keysend auto-rebalance. The scheduler becomes much simpler — no donor selection needed.

**Step 1: Replace the scheduler logic**

Replace the entire file content of `app/api/src/lightning/rebalance-scheduler.ts` with:

```typescript
/**
 * Automated keysend push rebalance scheduler: on the treasury node, periodically
 * finds critical channels (>85% local) and pushes sats to members via keysend.
 * Respects cooldown and never overlaps runs.
 */

import { ENV } from "../config/env";
import { getNodeInfo } from "../api/read";
import { assertTreasury } from "../utils/role";
import { assertDailyLossCapNotExceeded, DailyLossCapError } from "../utils/loss-cap";
import { autoKeysendRebalance } from "./rebalance-keysend";
import { db } from "../db";

let running = false;

function hasRecentSucceededRebalance(minutes: number): boolean {
  const since = Date.now() - minutes * 60_000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM treasury_rebalance_executions
       WHERE status = 'succeeded' AND created_at >= ?`
    )
    .get(since) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

export function startRebalanceScheduler(): void {
  if (!ENV.rebalanceSchedulerEnabled) return;

  setInterval(async () => {
    if (running) return;

    try {
      running = true;

      const node = getNodeInfo();
      if (node?.node_role !== "treasury") return;
      assertTreasury(node.node_role);

      if (hasRecentSucceededRebalance(ENV.rebalanceCooldownMinutes)) return;

      // Daily loss cap: check once per tick before any LND I/O
      try {
        assertDailyLossCapNotExceeded(0);
      } catch (err) {
        if (err instanceof DailyLossCapError) {
          console.warn("[rebalance-scheduler] daily loss cap reached — skipping:", err.message);
          return;
        }
        throw err;
      }

      if (ENV.rebalanceSchedulerDryRun) {
        // In dry-run mode, import health and log what would happen
        const { getLiquidityHealth } = await import("../api/treasury-liquidity-health");
        const health = getLiquidityHealth();
        const critical = health.filter((h) => h.is_active && h.health_classification === "critical");
        if (critical.length > 0) {
          console.log("[rebalance-scheduler][dry-run] would keysend push to critical channels:", critical.map((c) => ({
            channel_id: c.channel_id,
            imbalance_ratio: c.imbalance_ratio,
            local_sats: c.local_sats,
            capacity_sats: c.capacity_sats,
          })));
        }
        return;
      }

      const { results } = await autoKeysendRebalance();

      if (results.length > 0 && ENV.debug) {
        console.log("[rebalance-scheduler] keysend results:", results.map((r) => ({
          channel_id: r.channel_id,
          status: r.status,
          amount_sats: r.amount_sats,
          fee_paid_sats: r.fee_paid_sats,
        })));
      }
    } catch (e) {
      if (ENV.debug) console.error("[rebalance-scheduler] error:", e);
    } finally {
      running = false;
    }
  }, ENV.rebalanceSchedulerIntervalMs);
}
```

**Step 2: Verify API builds**

Run: `cd app/api && npm run build`
Expected: Success

**Step 3: Commit**

```bash
git add app/api/src/lightning/rebalance-scheduler.ts
git commit -m "feat: replace circular rebalance with keysend push in scheduler"
```

---

### Task 6: Add API endpoints to index.ts

**Files:**
- Modify: `app/api/src/index.ts`

Add two new endpoints after the existing `POST /api/treasury/rebalance/circular` block (which ends at line 898). The circular endpoint stays for backwards compatibility — it just won't work in practice.

**Step 1: Add imports**

At the top of `app/api/src/index.ts`, alongside the existing rebalance imports, add:

```typescript
import { executeKeysendRebalance, autoKeysendRebalance, KeysendRebalanceError } from "./lightning/rebalance-keysend";
```

**Step 2: Add `POST /api/treasury/rebalance/keysend` endpoint**

Insert after the `POST /api/treasury/rebalance/circular` block (after line 898):

```typescript
  // ── Keysend push rebalance (manual) ─────────────────────────────────
  if (req.method === "POST" && req.url === "/api/treasury/rebalance/keysend") {
    try {
      const node = getNodeInfo();
      if (!node) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Node info unavailable" }));
        return;
      }
      assertTreasury(node.node_role);

      let body = "";
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body || "{}");
          const channel_id = parsed.channel_id;
          const amount_sats = Number(parsed.amount_sats);
          const max_fee_sats = parsed.max_fee_sats != null ? Number(parsed.max_fee_sats) : 0;

          if (!channel_id || typeof channel_id !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "channel_id is required" }));
            return;
          }

          const result = await executeKeysendRebalance({
            channel_id: channel_id.trim(),
            amount_sats,
            max_fee_sats,
          });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err: any) {
          const msg = String(err?.message ?? err);
          if (err instanceof KeysendRebalanceError) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: msg }));
          } else if (err instanceof DailyLossCapError) {
            res.writeHead(429, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: msg }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: msg || "keysend_rebalance_failed" }));
          }
        }
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  // ── Keysend push rebalance (auto — all critical channels) ───────────
  if (req.method === "POST" && req.url === "/api/treasury/rebalance/keysend/auto") {
    try {
      const node = getNodeInfo();
      if (!node) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Node info unavailable" }));
        return;
      }
      assertTreasury(node.node_role);

      try {
        assertDailyLossCapNotExceeded(0);
      } catch (err: any) {
        if (err instanceof DailyLossCapError) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err.message) }));
          return;
        }
        throw err;
      }

      const response = await autoKeysendRebalance();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const code = msg.includes("Treasury privileges required") ? 403 : 500;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }
```

**Important:** The `/api/treasury/rebalance/keysend/auto` route MUST come after `/api/treasury/rebalance/keysend` in the file, but since we use exact `===` matching on `req.url`, order doesn't matter for these specific routes. However, if prefix matching were used, the more specific path would need to come first.

**Step 3: Verify API builds**

Run: `cd app/api && npm run build`
Expected: Success

**Step 4: Commit**

```bash
git add app/api/src/index.ts
git commit -m "feat: add keysend rebalance API endpoints (manual + auto)"
```

---

### Task 7: Add `KEYSEND_REBALANCE_AVAILABLE` alert

**Files:**
- Modify: `app/api/src/api/treasury-alerts.ts`

**Step 1: Add the alert**

In `app/api/src/api/treasury-alerts.ts`, add the keysend alert after the scheduler simulation mode block (line 150) and before the `return alerts;` (line 152). Add the import for `getLiquidityHealth` at the top.

Add import at line 2 (after `import { db } from "../db";`):

```typescript
import { getLiquidityHealth } from "./treasury-liquidity-health";
```

Add the alert block before `return alerts;`:

```typescript
  // --- Keysend rebalance available ---
  const health = getLiquidityHealth();
  const criticalChannels = health.filter((h) => h.is_active && h.health_classification === "critical");
  if (criticalChannels.length > 0) {
    alerts.push({
      type: "KEYSEND_REBALANCE_AVAILABLE",
      severity: "info",
      message: `${criticalChannels.length} channel(s) have >85% local balance — keysend push rebalance available`,
      data: {
        count: criticalChannels.length,
        channels: criticalChannels.map((c) => ({
          channel_id: c.channel_id,
          imbalance_ratio: c.imbalance_ratio,
          local_sats: c.local_sats,
          capacity_sats: c.capacity_sats,
        })),
      },
      at: now,
    });
  }
```

**Step 2: Verify API builds**

Run: `cd app/api && npm run build`
Expected: Success

**Step 3: Commit**

```bash
git add app/api/src/api/treasury-alerts.ts
git commit -m "feat: add KEYSEND_REBALANCE_AVAILABLE alert for critical channels"
```

---

### Task 8: Update CLAUDE.md + version bump

**Files:**
- Modify: `CLAUDE.md`
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

**Step 1: Update CLAUDE.md**

1. In **Current Capabilities** section, add after "Contacts page": `, keysend push rebalance (direct-push channel balancing for hub-and-spoke topology)`

2. In **Key Files** table, add row:
   ```
   | `src/lightning/rebalance-keysend.ts` | Keysend push rebalance execution + auto-select |
   ```

3. In **Liquidity Management** section, add after the existing paragraph:
   ```
   Keysend push rebalance: treasury pushes sats directly to member nodes on critical channels (>85% local). Uses `payViaPaymentDetails` (no invoice, no routing). Safety bounds: 10k-100k sats per push, max 50% of local balance. Scheduler uses keysend instead of circular for hub-and-spoke topology.
   ```

4. In **Role-Based Access Control** → **Treasury only** line, the keysend endpoints are already covered by "All `/api/treasury/*` endpoints".

**Step 2: Bump version to 1.3.1**

In `bitcorn-lightning-node/umbrel-app.yml`, change:
```
version: "1.3.0"
```
to:
```
version: "1.3.1"
```

In `bitcorn-lightning-node/docker-compose.yml`, change both image tags from `1.3.0` to `1.3.1`.

Update `releaseNotes` in `umbrel-app.yml`:
```
releaseNotes: >
  Keysend push rebalance: replaces circular rebalancing with direct keysend
  push for hub-and-spoke topology. Treasury pushes sats to member nodes on
  critical channels (>85% local) to restore receive capacity. New API
  endpoints, scheduler integration, and KEYSEND_REBALANCE_AVAILABLE alert.
```

**Step 3: Verify both projects build**

Run: `cd app/api && npm run build`
Run: `cd app/web && npm run build`
Expected: Both succeed

**Step 4: Commit**

```bash
git add CLAUDE.md bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml
git commit -m "chore: update docs, bump version to 1.3.1 for keysend rebalance"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | `payViaPaymentDetails` type declaration | `ln-service.d.ts` |
| 2 | `keysendPush()` wrapper in lnd.ts | `lnd.ts` |
| 3 | Core `rebalance-keysend.ts` module | NEW file |
| 4 | Add "keysend" to RebalanceCostType | `treasury-rebalance-costs.ts` |
| 5 | Replace circular with keysend in scheduler | `rebalance-scheduler.ts` |
| 6 | Two new API endpoints in index.ts | `index.ts` |
| 7 | KEYSEND_REBALANCE_AVAILABLE alert | `treasury-alerts.ts` |
| 8 | CLAUDE.md + version bump to 1.3.1 | `CLAUDE.md`, `umbrel-app.yml`, `docker-compose.yml` |

## Branch

```bash
git checkout develop
git pull
git checkout -b feature/keysend-rebalance
```

All work on `feature/keysend-rebalance`. Merge path: `feature/keysend-rebalance` → `develop` → test → `main`.
