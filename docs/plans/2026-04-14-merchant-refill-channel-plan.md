# Merchant Refill Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a merchant-side Loop In (Refill Channel) page with preflight route probing, policy enforcement, advisor integration, and Loop Out parity improvements.

**Architecture:** Extend the existing `src/swaps/` subsystem with member Loop In route handlers and policy, a route-probe helper in `src/lightning/lnd.ts`, and a new `RefillChannel.tsx` page mirroring `WithdrawBitcoin.tsx`. No new DB tables — reuses `swap_requests`, `swap_executions`, `swap_events`.

**Tech Stack:** TypeScript, React 18, ln-service, loopd gRPC (via loopProvider.ts), SQLite

**Design spec:** `docs/plans/2026-04-14-merchant-refill-channel-design.md`

---

## File Map

### New files
| File | Responsibility |
|------|----------------|
| `app/web/src/pages/RefillChannel.tsx` | Merchant Refill Channel page — form, quote, tracking, pending detection |

### Modified files
| File | Changes |
|------|---------|
| `app/api/src/config/env.ts` | Add 5 new env vars for Loop In policy + Loop server pubkeys |
| `app/api/src/types/ln-service.d.ts` | Add `start` parameter to `getRouteToDestination` |
| `app/api/src/lightning/lnd.ts` | Add `probeRouteToLoopServer()` function |
| `app/api/src/swaps/swapPolicy.ts` | Add `checkMemberLoopInPolicy()`, update stale comment |
| `app/api/src/swaps/swapService.ts` | Parameterize `createLoopInQuote()` to accept `role: "member"` |
| `app/api/src/swaps/swapRoutes.ts` | Add `handleMemberLoopInQuote` + `handleMemberLoopIn`, update stale comment |
| `app/api/src/index.ts` | Register 2 new routes for member Loop In |
| `app/web/src/api/client.ts` | Add `getSwapLoopInQuote` + `initiateSwapLoopIn` methods |
| `app/web/src/App.tsx` | Change `/refill` route from `WithdrawBitcoin` to `RefillChannel` |
| `app/web/src/pages/MemberDashboard.tsx` | Pre-fill `?amount=X` on both Refill and Cash Out buttons |
| `app/web/src/pages/WithdrawBitcoin.tsx` | Pending detection, context-forward layout, direction-specific status copy |

---

## Task 1: Backend env vars

**Files:**
- Modify: `app/api/src/config/env.ts`

- [ ] **Step 1: Add Loop In env vars to env.ts**

Add the following after the existing `swapTreasuryEgressReserveSat` line (around line 116):

```typescript
    // --- Member refill (Loop In) limits ---
    // Comma-separated list of Loop swap server pubkeys for route-probe preflight.
    // Default: Lightning Labs mainnet Loop server.
    loopServerPubkeys: (process.env.LOOP_SERVER_PUBKEYS || "021c97a90a411ff2b10dc2a8e32de2f29d2fa49d41bfbb52bd416e460db0747d0d")
        .split(",").map(s => s.trim()).filter(Boolean),
    // Minimum sats a member can refill via Loop In (default: 100,000)
    memberMinRefillSat: Number(process.env.MEMBER_MIN_REFILL_SAT ?? "100000"),
    // Maximum sats a member can refill in a single Loop In (default: 3,000,000)
    memberMaxRefillSat: Number(process.env.MEMBER_MAX_REFILL_SAT ?? "3000000"),
    // Maximum total daily refill for a member (default: 5,000,000)
    memberMaxDailyRefillSat: Number(process.env.MEMBER_MAX_DAILY_REFILL_SAT ?? "5000000"),
    // On-chain reserve buffer — subtracted from available balance to prevent draining to zero
    memberOnchainReserveSat: Number(process.env.MEMBER_ONCHAIN_RESERVE_SAT ?? "50000"),
```

- [ ] **Step 2: Verify API starts**

```bash
cd app/api && npm run build
```

Expected: clean compile, no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/src/config/env.ts
git commit -m "feat(refill): add Loop In env vars — server pubkeys + policy limits"
```

---

## Task 2: Route probe helper

**Files:**
- Modify: `app/api/src/types/ln-service.d.ts`
- Modify: `app/api/src/lightning/lnd.ts`

- [ ] **Step 1: Update ln-service type declaration**

In `app/api/src/types/ln-service.d.ts`, find the `getRouteToDestination` function declaration and add the `start` parameter:

```typescript
  export function getRouteToDestination(options: {
    lnd: any;
    destination: string;
    tokens: number;
    outgoing_channel?: string;
    incoming_peer?: string;
    max_fee?: number;
    payment?: string;
    total_mtokens?: string;
    start?: string; // source pubkey — probe route FROM this node (uses gossip graph)
  }): Promise<{ route: Route }>;
```

- [ ] **Step 2: Add probeRouteToLoopServer() to lnd.ts**

Add the following function at the bottom of `app/api/src/lightning/lnd.ts`:

```typescript
/**
 * Preflight probe: checks whether a Lightning payment can route from
 * any known Loop swap server to the local node for a given amount.
 *
 * Uses queryRoutes with source_pub_key (via ln-service's `start` param)
 * to simulate the route FROM the server TO us, using the local gossip graph.
 * The route necessarily passes through treasury's external channels.
 *
 * Never throws — returns a result object.
 */
export async function probeRouteToLoopServer(
  merchantPubkey: string,
  amountSat: number,
): Promise<{ routable: boolean; serverPubkey?: string; error?: string }> {
  const { lnd } = getLndClient();
  const servers = ENV.loopServerPubkeys;

  for (const serverPubkey of servers) {
    try {
      const result = await getRouteToDestination({
        lnd,
        destination: merchantPubkey,
        tokens: amountSat,
        start: serverPubkey,
      });
      if (result?.route) {
        return { routable: true, serverPubkey };
      }
    } catch {
      // No route from this server — try next
      continue;
    }
  }

  return {
    routable: false,
    error: `No route found from any Loop server (${servers.length} checked) to ${merchantPubkey.slice(0, 12)}... for ${amountSat} sats`,
  };
}
```

- [ ] **Step 3: Verify build**

```bash
cd app/api && npm run build
```

Expected: clean compile.

- [ ] **Step 4: Commit**

```bash
git add app/api/src/types/ln-service.d.ts app/api/src/lightning/lnd.ts
git commit -m "feat(refill): add probeRouteToLoopServer() — preflight route check"
```

---

## Task 3: Member Loop In policy

**Files:**
- Modify: `app/api/src/swaps/swapPolicy.ts`

- [ ] **Step 1: Add checkMemberLoopInPolicy function**

Add the following after the existing `checkTreasuryLoopInPolicy` function (around line 231) in `app/api/src/swaps/swapPolicy.ts`:

```typescript
// ─── Member Loop In (refill) ────────────────────────────────────────────
// Path: Loop server → [public network] → treasury (external channel) → merchant
// Preflight probes this route before allowing the on-chain HTLC commit.

export async function checkMemberLoopInPolicy(params: {
  nodePubkey: string;
  amountSat: number;
  quotedFeeSat?: number; // omit for pre-quote (phase 1); provide for post-quote (phase 2)
}): Promise<PolicyResult> {
  const { amountSat, quotedFeeSat, nodePubkey } = params;

  // ── 1. Amount bounds ──────────────────────────────────────────────────
  if (amountSat < ENV.memberMinRefillSat) {
    return { ok: false, reason: `Minimum refill: ${ENV.memberMinRefillSat.toLocaleString()} sats`, code: "below_minimum" };
  }
  if (amountSat > ENV.memberMaxRefillSat) {
    return { ok: false, reason: `Maximum refill: ${ENV.memberMaxRefillSat.toLocaleString()} sats`, code: "above_maximum" };
  }

  // ── 2. Provider terms ─────────────────────────────────────────────────
  try {
    const terms = await getLoopInTerms();
    if (amountSat < terms.min_swap_amount) {
      return { ok: false, reason: `Below Loop In minimum: ${terms.min_swap_amount.toLocaleString()} sats`, code: "below_loop_minimum" };
    }
    if (amountSat > terms.max_swap_amount) {
      return { ok: false, reason: `Above Loop In maximum: ${terms.max_swap_amount.toLocaleString()} sats`, code: "above_loop_maximum" };
    }
  } catch {
    return { ok: false, reason: "Loop service unavailable", code: "loop_unavailable" };
  }

  // ── 3. On-chain balance ───────────────────────────────────────────────
  try {
    const { chain_balance } = await getLndChainBalance();
    const reserve = ENV.memberOnchainReserveSat;
    const needed = amountSat + reserve;
    if (chain_balance < needed) {
      return {
        ok: false,
        reason: `Insufficient on-chain balance (${chain_balance.toLocaleString()} available, need ${needed.toLocaleString()} including ${reserve.toLocaleString()} reserve)`,
        code: "insufficient_onchain",
      };
    }
  } catch {
    return { ok: false, reason: "Unable to check on-chain balance", code: "balance_check_failed" };
  }

  // ── 4. Route probe (preflight) ────────────────────────────────────────
  const { probeRouteToLoopServer } = await import("../lightning/lnd");
  const probe = await probeRouteToLoopServer(nodePubkey, amountSat);
  if (!probe.routable) {
    return {
      ok: false,
      reason: "No route available from Loop server to your node. Treasury may lack inbound capacity on external channels. Try a smaller amount or check back shortly.",
      code: "route_unavailable",
    };
  }

  // ── 5. Daily refill cap ───────────────────────────────────────────────
  const dayAgo = Date.now() - 86_400_000;
  const dailyRow = db.prepare(`
    SELECT COALESCE(SUM(amount_sat), 0) AS total
    FROM swap_requests
    WHERE node_pubkey = ? AND role = 'member' AND swap_type = 'loop_in'
      AND status NOT IN ('failed', 'expired', 'blocked_policy')
      AND created_at > ?
  `).get(nodePubkey, dayAgo) as { total: number };

  if (dailyRow.total + amountSat > ENV.memberMaxDailyRefillSat) {
    return {
      ok: false,
      reason: `Daily refill limit exceeded (${ENV.memberMaxDailyRefillSat.toLocaleString()} sats/day)`,
      code: "daily_limit_exceeded",
    };
  }

  // ── 6. Fee cap (phase 2 only — requires quoted fee) ───────────────────
  if (quotedFeeSat !== undefined) {
    const feeLimit = Math.ceil(amountSat * ENV.loopMaxSwapFeePct / 100);
    if (quotedFeeSat > feeLimit) {
      return { ok: false, reason: `Quoted fee (${quotedFeeSat.toLocaleString()}) exceeds cap (${feeLimit.toLocaleString()})`, code: "fee_exceeds_cap" };
    }
  }

  console.log(
    `[swap-policy] member loop-in approved: ${amountSat} sats, ` +
    `daily_total=${dailyRow.total}, route_via=${probe.serverPubkey?.slice(0, 12)}`
  );

  return { ok: true };
}
```

- [ ] **Step 2: Add missing import for probeRouteToLoopServer**

The function uses a dynamic import (`await import("../lightning/lnd")`) to avoid circular dependency. Verify the existing imports at the top of `swapPolicy.ts` already include `db` from `"../db"`, `ENV` from `"../config/env"`, `getLndChainBalance` from `"../lightning/lnd"`, and `getLoopInTerms` from `"../lightning/loop"`. All are already present — no new imports needed.

- [ ] **Step 3: Update the stale comment at line 196-198**

Replace:
```typescript
// INACTIVE: Treasury Loop In removed from active architecture (v1.7.1).
// Merchant-side liquidity uses channel lifecycle management, not Loop In.
// Function retained for potential future use but not called from any active route.
```

With:
```typescript
// Treasury-initiated Loop In — removed from active architecture (v1.7.1).
// Treasury maintains inbound via Loop OUT on external channels.
// This function is retained for reference; member-side Loop In uses
// checkMemberLoopInPolicy() below.
```

- [ ] **Step 4: Verify build**

```bash
cd app/api && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add app/api/src/swaps/swapPolicy.ts
git commit -m "feat(refill): add checkMemberLoopInPolicy — preflight + bounds + daily cap"
```

---

## Task 4: Quote refactor + route handlers

**Files:**
- Modify: `app/api/src/swaps/swapService.ts`
- Modify: `app/api/src/swaps/swapRoutes.ts`

- [ ] **Step 1: Parameterize createLoopInQuote in swapService.ts**

Find `createLoopInQuote` (around line 101). Change the `role` type from `"treasury"` to `"member" | "treasury"`:

```typescript
export async function createLoopInQuote(params: {
  nodePubkey: string;
  role: "member" | "treasury";
  amountSat: number;
  maxFeeSat?: number;
}): Promise<{ swapRequest: SwapRequest; quote: LoopInQuoteResult }> {
```

Also update the SQL INSERT on the `role` value — currently hard-coded as `'treasury'`. Change to use `params.role`:

Find the line:
```typescript
    VALUES (?, ?, ?, ?, 'treasury', 'loop_in', 'chain_to_lightning',
```

Replace with:
```typescript
    VALUES (?, ?, ?, ?, ?, 'loop_in', 'chain_to_lightning',
```

And update the `.run()` call to include `params.role` as the 5th parameter:
```typescript
  `).run(id, now, now, params.nodePubkey, params.role, params.amountSat,
    params.maxFeeSat ?? null, quote.total_fee_sat, expiresAt);
```

- [ ] **Step 2: Update the stale comment in swapService.ts**

Find (around line 99):
```typescript
// INACTIVE: Treasury Loop In quote creation — not called from active routes.
// Retained for potential future use. See merchant channel lifecycle doc.
```

Replace with:
```typescript
// Loop In quote creation — used by both member refill and (future) treasury operations.
```

- [ ] **Step 3: Add member Loop In handlers to swapRoutes.ts**

Add the following imports at the top of `app/api/src/swaps/swapRoutes.ts` (alongside existing imports):

```typescript
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
  checkMemberLoopInPolicy,
  checkTreasuryLoopOutPolicy,
} from "./swapPolicy";
```

Then add the two new handlers after `handleMemberLoopOut` (around line 102), before the treasury section:

```typescript
// ─── Member Loop In (refill) ────────────────────────────────────────────

export async function handleMemberLoopInQuote(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });
  if (node.node_role !== "treasury") assertActiveMember(node.membership_status);

  const body = JSON.parse(await parseBody(req));
  const amountSat = Number(body.amount_sat);
  if (!amountSat || amountSat <= 0) return json(res, 400, { error: "invalid_amount" });

  const loopStatus = await isLoopAvailable();
  if (!loopStatus.available) return json(res, 503, { error: "loop_unavailable", detail: loopStatus.error });

  // Phase 1: pre-quote policy check (includes route probe)
  const preCheck = await checkMemberLoopInPolicy({
    nodePubkey: node.pubkey,
    amountSat,
  });
  if (!preCheck.ok) {
    const status = preCheck.code === "route_unavailable" || preCheck.code === "loop_unavailable" ? 503 : 429;
    return json(res, status, { error: "policy_violation", detail: preCheck.reason, code: preCheck.code });
  }

  // Create quote (calls loopd GetLoopInQuote)
  const { swapRequest, quote } = await createLoopInQuote({
    nodePubkey: node.pubkey,
    role: node.node_role === "treasury" ? "treasury" : "member",
    amountSat,
  });

  // Phase 2: post-quote policy check (fee cap — advisory)
  const postCheck = await checkMemberLoopInPolicy({
    nodePubkey: node.pubkey,
    amountSat,
    quotedFeeSat: quote.total_fee_sat,
  });

  json(res, 200, { swap_request: swapRequest, quote, policy_check: postCheck });
}

export async function handleMemberLoopIn(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });
  if (node.node_role !== "treasury") assertActiveMember(node.membership_status);

  const body = JSON.parse(await parseBody(req));
  const swapRequestId = body.swap_request_id as string;
  if (!swapRequestId) return json(res, 400, { error: "swap_request_id_required" });

  const existing = getSwapRequest(swapRequestId);
  if (!existing) return json(res, 404, { error: "swap_request_not_found" });
  if (existing.node_pubkey !== node.pubkey) return json(res, 403, { error: "not_your_swap" });

  // Full policy enforcement (with stored fee)
  const policy = await checkMemberLoopInPolicy({
    nodePubkey: node.pubkey,
    amountSat: existing.amount_sat,
    quotedFeeSat: existing.quoted_fee_sat ?? 0,
  });
  if (!policy.ok) return json(res, 429, { error: "policy_violation", detail: policy.reason, code: policy.code });

  const result = await initiateSwap(swapRequestId);
  json(res, 200, { swap_request: result, execution: getSwapExecution(swapRequestId) });
}
```

- [ ] **Step 4: Update stale comment in swapRoutes.ts**

Find (around line 182):
```typescript
// Treasury Loop In handlers removed from active architecture (v1.7.1).
// Merchant-side liquidity uses channel lifecycle management, not Loop In.
// Low-level gRPC support retained in loop.ts / loopProvider.ts for potential future use.
```

Replace with:
```typescript
// Treasury-initiated Loop In handlers removed from active architecture (v1.7.1).
// Treasury maintains inbound via Loop OUT. Member-side Loop In (merchant refill)
// is handled above by handleMemberLoopInQuote / handleMemberLoopIn.
```

- [ ] **Step 5: Verify build**

```bash
cd app/api && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add app/api/src/swaps/swapService.ts app/api/src/swaps/swapRoutes.ts
git commit -m "feat(refill): member Loop In route handlers + quote refactor"
```

---

## Task 5: Route registration in index.ts

**Files:**
- Modify: `app/api/src/index.ts`

- [ ] **Step 1: Add import for new handlers**

Find the existing import from `"./swaps/swapRoutes"` (around line 89) and add the new handlers:

```typescript
} from "./swaps/swapRoutes";
```

Add `handleMemberLoopInQuote` and `handleMemberLoopIn` to the import list.

- [ ] **Step 2: Register Loop In routes**

Find the existing Loop Out member routes (around line 2299). Add the Loop In routes **before** the `/api/swaps/history` route (more specific path must come first):

```typescript
  // ─── Member Loop In (refill) ──────────────────────────────────────────
  if (req.method === "POST" && req.url === "/api/swaps/loop-in/quote") {
    try { await handleMemberLoopInQuote(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/swaps/loop-in") {
    try { await handleMemberLoopIn(req, res); } catch (e: any) {
      res.writeHead(e.message?.includes("privileges") ? 403 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
```

Place these **after** the existing Loop Out routes and **before** the `/api/swaps/history` route.

- [ ] **Step 3: Verify build**

```bash
cd app/api && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add app/api/src/index.ts
git commit -m "feat(refill): register POST /api/swaps/loop-in/quote + /api/swaps/loop-in routes"
```

---

## Task 6: Frontend API client

**Files:**
- Modify: `app/web/src/api/client.ts`

- [ ] **Step 1: Add Loop In API methods**

Find the existing `initiateSwapLoopOut` method (around line 164). Add the Loop In methods right after:

```typescript
  // Loop In (member refill)
  getSwapLoopInQuote: (body: { amount_sat: number }) =>
    apiFetch<SwapQuoteResponse>("/api/swaps/loop-in/quote", { method: "POST", body: JSON.stringify(body) }),
  initiateSwapLoopIn: (body: { swap_request_id: string }) =>
    apiFetch<{ swap_request: SwapRequest; execution: SwapExecution }>("/api/swaps/loop-in", { method: "POST", body: JSON.stringify(body) }),
```

- [ ] **Step 2: Verify web build**

```bash
cd app/web && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add app/web/src/api/client.ts
git commit -m "feat(refill): add getSwapLoopInQuote + initiateSwapLoopIn API client methods"
```

---

## Task 7: RefillChannel.tsx page

**Files:**
- Create: `app/web/src/pages/RefillChannel.tsx`

This is the largest task. The page mirrors `WithdrawBitcoin.tsx` structure with these differences:
- No destination address (loopd uses node's own on-chain wallet)
- On-chain balance card instead of Lightning balance card
- Channel state bar at top with projected-state strip
- `?amount=X` URL param support for advisor pre-fill
- Pending detection via swap history on mount
- Loop In–specific status copy in tracker

- [ ] **Step 1: Create RefillChannel.tsx**

Create `app/web/src/pages/RefillChannel.tsx`. The page is modeled after `WithdrawBitcoin.tsx` — reference that file for styling patterns, panel structure, and the amber design system. Key structural elements:

```typescript
import { useState, useEffect, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api, fmtSats } from "../api/client";
import type { SwapRequest, SwapQuoteResponse } from "../api/client";

type Stage = "loading" | "form" | "quoting" | "quoted" | "initiating" | "tracking";

const AMOUNT_PRESETS = [250_000, 500_000, 1_000_000, 2_000_000];
```

**State variables:**
```typescript
const [searchParams] = useSearchParams();
const navigate = useNavigate();
const advisorAmount = Number(searchParams.get("amount")) || 0;

const [stage, setStage] = useState<Stage>("loading");
const [amount, setAmount] = useState(advisorAmount || 250_000);
const [error, setError] = useState<string | null>(null);
const [warning, setWarning] = useState<string | null>(null);

// Channel state
const [channelLocal, setChannelLocal] = useState<number | null>(null);
const [channelCapacity, setChannelCapacity] = useState<number | null>(null);
const [channelLocalPct, setChannelLocalPct] = useState<number | null>(null);

// On-chain balance
const [onchainBalance, setOnchainBalance] = useState<number | null>(null);
const [maxRefill, setMaxRefill] = useState<number | null>(null);

// Quote
const [quoteResp, setQuoteResp] = useState<SwapQuoteResponse | null>(null);
const [countdown, setCountdown] = useState("");

// Tracking
const [trackingId, setTrackingId] = useState<string | null>(null);
const [trackingSwap, setTrackingSwap] = useState<SwapRequest | null>(null);

// History
const [history, setHistory] = useState<SwapRequest[]>([]);
const [historyLoading, setHistoryLoading] = useState(true);
```

**Mount effects:**

1. Fetch member stats (channel state) + node balances (on-chain) in parallel
2. Check for in-flight Loop In swap (pending detection)
3. Load refill history

```typescript
useEffect(() => {
  Promise.all([
    api.getMemberStats().catch(() => null),
    api.getNodeBalances().catch(() => null),
  ]).then(([stats, balances]) => {
    if (stats?.treasury_channel) {
      const local = stats.treasury_channel.local_sats;
      const cap = stats.treasury_channel.capacity_sats;
      setChannelLocal(local);
      setChannelCapacity(cap);
      setChannelLocalPct(cap > 0 ? Math.round((local / cap) * 100) : 0);
    }
    if (balances) {
      const chain = balances.chain_balance ?? 0;
      setOnchainBalance(chain);
      const reserve = 50_000;
      const feeCushion = 10_000;
      setMaxRefill(Math.max(0, Math.min(chain - reserve - feeCushion, 3_000_000)));
    }
  });

  // Pending detection: check for in-flight loop_in swap
  api.getSwapHistory(5).then((r) => {
    const inflight = r.swaps.find(
      (s) => s.swap_type === "loop_in" && !["completed", "failed", "expired"].includes(s.status)
    );
    if (inflight) {
      setTrackingId(inflight.id);
      setTrackingSwap(inflight);
      setStage("tracking");
    } else {
      setStage("form");
    }
  }).catch(() => setStage("form"));

  loadHistory();
}, []);
```

**handleGetQuote:**
```typescript
async function handleGetQuote() {
  setError(null);
  setWarning(null);
  if (amount < 100_000) { setError("Minimum refill is 100,000 sats"); return; }
  setStage("quoting");
  try {
    const resp = await api.getSwapLoopInQuote({ amount_sat: amount });
    setQuoteResp(resp);
    if (!resp.policy_check.ok) {
      setWarning(resp.policy_check.reason);
    }
    setStage("quoted");
  } catch (e: any) {
    const msg = e.message ?? "Failed to get quote";
    if (msg.includes("route_unavailable")) {
      setWarning("Treasury has no inbound capacity for this amount right now. Try a smaller amount or check back shortly.");
    } else if (msg.includes("insufficient_onchain")) {
      setError("Insufficient on-chain balance for this refill amount.");
    } else {
      setError(msg);
    }
    setStage("form");
  }
}
```

**handleConfirm:**
```typescript
async function handleConfirm() {
  if (!quoteResp) return;
  setError(null);
  setStage("initiating");
  try {
    const resp = await api.initiateSwapLoopIn({
      swap_request_id: quoteResp.swap_request.id,
    });
    setTrackingId(resp.swap_request.id);
    setTrackingSwap(resp.swap_request);
    setStage("tracking");
  } catch (e: any) {
    setError(e.message ?? "Failed to initiate refill");
    setStage("quoted");
  }
}
```

**Tracking poll** (same pattern as WithdrawBitcoin):
```typescript
useEffect(() => {
  if (stage === "tracking" && trackingId) {
    const poll = () => {
      api.getSwap(trackingId).then((detail) => {
        setTrackingSwap(detail.swap_request);
        if (isTerminal(detail.swap_request.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          loadHistory();
        }
      }).catch(() => {});
    };
    poll();
    pollRef.current = setInterval(poll, 15_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }
}, [stage, trackingId]);
```

**Render structure** (context-forward layout):

1. **Header** — "Refill Channel" + subtitle
2. **Channel state bar** — `channelLocalPct` with color (red < 30, amber 30–60, green 60+) + advisor tagline if `advisorAmount > 0`
3. **On-chain balance card** (amber-tinted) — balance + max refill
4. **Amount input** — presets + free text with commas + sats label + dynamic disabled state
5. **Projected-state strip** — computes `projectedPct = ((channelLocal + amount) / channelCapacity) * 100`
6. **Get Quote / Quote panel / Tracking panel** — stage-driven visibility
7. **Error/warning banners** — route_unavailable = `.alert.warning`, insufficient_onchain = `.alert.critical` with deep-link buttons
8. **Recent refills table** — history filtered to `swap_type === "loop_in"`

For **Loop In-specific status copy** in the tracking panel:

```typescript
function statusText(status: string, failureReason: string | null): string {
  switch (status) {
    case "initiated": return "Publishing on-chain HTLC...";
    case "executing": return "Waiting for Lightning payment from Loop server...";
    case "confirming": return "Almost there — settling...";
    case "completed": return "Refill complete";
    case "failed": return `Refill failed${failureReason ? `: ${failureReason}` : ""}`;
    default: return status;
  }
}
```

For **insufficient on-chain deep-links** in the error state:

```typescript
{error?.includes("on-chain") && (
  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
    <button className="btn btn-outline" onClick={() => navigate("/deposit")}>
      Deposit Bitcoin
    </button>
    <button className="btn btn-outline" onClick={() => {
      api.getCoinbaseOnrampUrl().then(r => window.open(r.url, "_blank", "noopener,noreferrer")).catch(() => {});
    }}>
      Fund Node via Coinbase
    </button>
  </div>
)}
```

The full component should be approximately 400–500 lines, following the exact same panel/card/button styling patterns as `WithdrawBitcoin.tsx`. Reference that file directly for CSS class usage (`.panel`, `.panel-header`, `.panel-body`, `.stat-card`, `.btn`, `.btn-primary`, `.alert`, etc.).

- [ ] **Step 2: Verify web build**

```bash
cd app/web && npm run build
```

- [ ] **Step 3: Commit**

```bash
git add app/web/src/pages/RefillChannel.tsx
git commit -m "feat(refill): add RefillChannel.tsx — context-forward layout with preflight + tracking"
```

---

## Task 8: App.tsx route + dashboard integration

**Files:**
- Modify: `app/web/src/App.tsx`
- Modify: `app/web/src/pages/MemberDashboard.tsx`

- [ ] **Step 1: Import RefillChannel and change route in App.tsx**

Add the import at the top of `App.tsx` alongside other page imports:

```typescript
import RefillChannel from "./pages/RefillChannel";
```

Find the `/refill` route (around line 413):
```typescript
<Route path="/refill" element={<WithdrawBitcoin />} />
```

Replace with:
```typescript
<Route path="/refill" element={<RefillChannel />} />
```

- [ ] **Step 2: Add advisor pre-fill to dashboard buttons in MemberDashboard.tsx**

Find the Refill/Cash Out button (around line 585). The current code is:

```typescript
onClick={() => navigate(isFarmer ? "/cashout" : "/refill")}
```

Replace with advisor-aware navigation. This requires reading the advisor's recommendation from the existing liquidity status fetch. Find where `api.getLiquidityStatus()` is called and extract the recommendation:

```typescript
const advisorRec = liquidityStatus?.recommendation;
const refillUrl = advisorRec?.action === "loop_in" && advisorRec?.suggestedAmountSats
  ? `/refill?amount=${advisorRec.suggestedAmountSats}` : "/refill";
const cashOutUrl = advisorRec?.action === "loop_out" && advisorRec?.suggestedAmountSats
  ? `/cashout?amount=${advisorRec.suggestedAmountSats}` : "/cashout";
```

Update the button:
```typescript
onClick={() => navigate(isFarmer ? cashOutUrl : refillUrl)}
```

- [ ] **Step 3: Verify web build**

```bash
cd app/web && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add app/web/src/App.tsx app/web/src/pages/MemberDashboard.tsx
git commit -m "feat(refill): wire /refill route to RefillChannel + advisor pre-fill on dashboard"
```

---

## Task 9: WithdrawBitcoin parity improvements

**Files:**
- Modify: `app/web/src/pages/WithdrawBitcoin.tsx`

Four parallel changes to the existing Cash Out page:

- [ ] **Step 1: Add pending detection**

Add a `"loading"` entry state to the Stage type:

```typescript
type Stage = "loading" | "form" | "quoting" | "quoted" | "initiating" | "tracking";
```

Initialize stage to `"loading"`:

```typescript
const [stage, setStage] = useState<Stage>("loading");
```

Add channel state variables alongside existing state:

```typescript
const [channelCapacity, setChannelCapacity] = useState<number | null>(null);
const [channelLocalPct, setChannelLocalPct] = useState<number | null>(null);
```

In the existing `useEffect` that fetches member stats, also set `channelCapacity` and `channelLocalPct`.

Add pending detection in the mount effect:

```typescript
// Check for in-flight loop_out swap (pending detection)
api.getSwapHistory(5).then((r) => {
  const inflight = r.swaps.find(
    (s) => s.swap_type === "loop_out" && !["completed", "failed", "expired"].includes(s.status)
  );
  if (inflight) {
    setTrackingId(inflight.id);
    setTrackingSwap(inflight);
    setStage("tracking");
  } else {
    setStage("form");
  }
}).catch(() => setStage("form"));
```

Add a loading state to the render (show shimmer or spinner while checking):

```typescript
if (stage === "loading") {
  return <div className="loading-shimmer" style={{ height: 200, borderRadius: 8 }} />;
}
```

- [ ] **Step 2: Add context-forward layout elements**

Add a channel state bar above the existing Available Balance card in the form stage:

```typescript
{channelLocalPct != null && (
  <div style={{
    background: "var(--bg-2)", border: "1px solid var(--border)", borderRadius: 8,
    padding: "10px 14px", marginBottom: 10,
  }}>
    <div style={{ fontSize: "0.625rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 4 }}>
      Current channel
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 8, background: "var(--bg)", borderRadius: 4, overflow: "hidden", border: "1px solid var(--border)" }}>
        <div style={{ width: `${Math.min(channelLocalPct, 100)}%`, height: "100%", background: channelLocalPct > 60 ? "var(--green)" : channelLocalPct > 30 ? "var(--amber)" : "var(--red)" }} />
      </div>
      <span style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: channelLocalPct > 60 ? "var(--green)" : channelLocalPct > 30 ? "var(--amber)" : "var(--red)" }}>
        {channelLocalPct}% local
      </span>
    </div>
  </div>
)}
```

Add a projected-state strip below the amount input:

```typescript
{channelLocal != null && channelCapacity != null && channelCapacity > 0 && (
  <div style={{ background: "var(--bg-2)", borderLeft: "2px solid var(--amber)", padding: 8, fontSize: "0.65rem", color: "var(--text-2)", marginBottom: 10 }}>
    After withdrawal: <strong style={{ color: "var(--amber)" }}>
      {channelLocalPct}% → {Math.round(((channelLocal - amount) / channelCapacity) * 100)}% local
    </strong>
  </div>
)}
```

- [ ] **Step 3: Update status copy to be direction-specific**

Replace the existing `statusText` function:

```typescript
function statusText(status: string, failureReason: string | null): string {
  switch (status) {
    case "initiated": return "Paying Lightning invoice to Loop server...";
    case "executing": return "Loop server publishing on-chain HTLC...";
    case "confirming": return "Waiting for on-chain confirmation...";
    case "completed": return "Withdrawal complete";
    case "failed": return `Withdrawal failed${failureReason ? `: ${failureReason}` : ""}`;
    default: return status;
  }
}
```

- [ ] **Step 4: Add `?amount=X` URL param support**

Add at the top of the component:

```typescript
const [searchParams] = useSearchParams();
const advisorAmount = Number(searchParams.get("amount")) || 0;
```

Add the import:
```typescript
import { useSearchParams } from "react-router-dom";
```

Initialize the amount state with the advisor amount:
```typescript
const [amount, setAmount] = useState(advisorAmount || 250_000);
```

- [ ] **Step 5: Verify web build**

```bash
cd app/web && npm run build
```

- [ ] **Step 6: Commit**

```bash
git add app/web/src/pages/WithdrawBitcoin.tsx
git commit -m "feat(refill): WithdrawBitcoin parity — pending detection, context-forward, status copy"
```

---

## Task 10: Manual verification

- [ ] **Step 1: Start dev server**

```bash
cd app/web && npm run dev
```

- [ ] **Step 2: Verify Refill page loads**

Navigate to `http://localhost:5173/refill` as a merchant node. Verify:
- Page renders with "Refill Channel" header
- Channel state bar shows current local %
- On-chain balance card shows sats
- Amount presets are visible
- No console errors

- [ ] **Step 3: Verify WithdrawBitcoin still works**

Navigate to `/cashout`. Verify:
- Page renders with new channel state bar
- Projected-state strip appears below amount input
- Existing functionality (Get Quote, etc.) still works

- [ ] **Step 4: Verify route change**

Navigate to `/refill` — should show RefillChannel, not WithdrawBitcoin.
Navigate to `/cashout` — should show WithdrawBitcoin.

- [ ] **Step 5: Verify API build**

```bash
cd app/api && npm run build
```

No errors expected.

- [ ] **Step 6: Verify admin Loop In 410 unchanged**

```bash
curl -s -X POST http://localhost:3101/api/admin/swaps/loop-in/quote | head -c 200
```

Expected: `{"error":"treasury_loop_in_deprecated",...}`

- [ ] **Step 7: Commit any final adjustments**

```bash
git add -A
git commit -m "chore(refill): final adjustments from manual verification"
```

(Only if there are changes to commit.)

- [ ] **Step 8: Push feature branch**

```bash
git push -u origin feature/merchant-refill-channel
```
