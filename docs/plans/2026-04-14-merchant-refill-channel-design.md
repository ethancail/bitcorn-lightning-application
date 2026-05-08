# Merchant Refill Channel — Design Spec

> **Shipped — see `RefillChannel.tsx` for the current implementation. The route swap from `WithdrawBitcoin.tsx` to `RefillChannel.tsx` for `/refill` is still pending per `docs/IMPLEMENTATION.md`.**

**Date:** 2026-04-14
**Status:** Approved — ready for implementation planning
**Scope:** Full v1 (preflight, advisor integration, deep-link, projected state, daily cap, pending detection)
**Approach:** Extend existing swap subsystem (Approach 1)

---

## 1. Problem

Merchants send payments to farmers through the treasury hop. As they send, their local Lightning balance drains. When it's depleted, they can no longer send.

The "Refill Channel" sidebar button currently routes `/refill` to `WithdrawBitcoin.tsx` (a Loop Out / Cash Out page) — the opposite of what merchants need. There is no member-side Loop In UX.

**Solution:** Build a dedicated Refill Channel page that uses the merchant's own loopd (shipped per-node since v1.8.4) to execute a Loop In: convert the merchant's on-chain BTC into local Lightning balance on the merchant↔treasury channel.

## 2. Constraints

### Leaf-node topology

Merchants are leaf nodes with a single channel to treasury. The Loop In Lightning payment must route:

```
Loop server → [public network] → treasury (external channel) → merchant
```

Two dependencies for success:
- **Treasury external inbound** — treasury must have remote liquidity on external channels (e.g., ACINQ). If all-local, the Loop server's payment can't reach treasury. Treasury maintains this via Loop Out on external channels.
- **Treasury-local on merchant channel** — treasury must have sats to push across to merchant. Automatic after merchant has been spending (every merchant payment moves sats to treasury's side).

### Loop In commit order (why preflight matters)

Loop Out is fail-cheap: Lightning pay happens first; if it fails, no on-chain tx is published.

Loop In is fail-expensive: on-chain HTLC publish happens first; if the Lightning leg fails, the merchant's funds are locked until timelock refund (~24h) and miner fees are lost.

**The preflight probe catches routing failures before the on-chain commit.**

## 3. Locked Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Scope | Full v1 | Preflight, advisor integration, deep-links, projected state, daily cap, pending detection |
| Preflight shape | Probe before quote | Merchant enters amount → backend probes route → if routable, show quote; if not, show warning. No quote created on failure. |
| Loop server pubkey source | Env-var array (`LOOP_SERVER_PUBKEYS`) | Defaults to Lightning Labs mainnet pubkey. Accepts comma-separated list for future swap providers (Boltz, etc.). Worker endpoint deferred. |
| Page layout | Context-forward | Channel state bar at top, on-chain balance card, amount input with dynamic cap, projected-state strip, history table |
| Policy limits | Min 100k / Max 3M / Daily 5M / 0.5% fee cap / 20k miner cap / 50k on-chain reserve | Mirrors Cash Out shape with refill-specific defaults |
| Dashboard pre-fill | Amount only (`/refill?amount=X`) | Advisor's `suggestedAmountSats` appended when available |
| Insufficient on-chain | Dynamic input cap + deep-link error buttons | "Deposit Bitcoin" → `/deposit`, "Fund Node via Coinbase" → Onramp URL |
| Pending detection | Mount-time swap lookup | `GET /api/swaps/history?type=loop_in&limit=5`, filter non-terminal client-side, skip to tracking |
| Architecture approach | Extend swap subsystem | New handlers/policy in existing `src/swaps/`; reuse `swap_requests` table, `swapPoller`, `initiateSwap()` |
| Loop Out parity | Yes — 4 parallel improvements | Pending detection, context-forward layout, direction-specific status copy, dashboard pre-fill |

## 4. Architecture Overview

```
                 ┌──────────────────────┐
                 │   MemberDashboard    │
                 │  "Refill Channel →"  │  reads advisor.suggestedAmountSats
                 └──────────┬───────────┘
                            │  navigate(/refill?amount=X)
                            ▼
                 ┌──────────────────────┐
                 │  RefillChannel.tsx   │  Stage: loading → form → quoting → quoted →
                 │   (new page)        │         initiating → tracking
                 └──────────┬───────────┘
                            │
          ┌─────────────────┴──────────────────┐
          │                                    │
          ▼                                    ▼
┌──────────────────────┐       ┌──────────────────────────┐
│ POST /api/swaps/     │       │ POST /api/swaps/         │
│     loop-in/quote    │       │     loop-in              │
│                      │       │                          │
│ 1. Preflight probe   │       │ 1. Re-check policy       │
│ 2. Policy check      │       │ 2. initiateSwap()        │
│ 3. createLoopInQuote │       │    (existing — branches   │
│ 4. Return quote      │       │    on loop_in already)    │
└──────────────────────┘       └──────────────────────────┘
```

### Touch points

- **New code:** `RefillChannel.tsx`, `handleMemberLoopInQuote` + `handleMemberLoopIn` in `swapRoutes.ts`, `checkMemberLoopInPolicy` in `swapPolicy.ts`, `probeRouteToLoopServer()` in `lnd.ts`, env vars in `env.ts`, route registrations in `index.ts` + `App.tsx`, API client methods in `client.ts`
- **Modified code:** `createLoopInQuote()` — accept `role: "member" | "treasury"` (was hard-coded to treasury). `WithdrawBitcoin.tsx` — pending detection + context-forward + status copy. `MemberDashboard.tsx` — pre-fill URLs for both Refill and Cash Out buttons.
- **Unchanged code:** `initiateSwap()`, `swapPoller`, `loopProvider.ts::initiateLoopIn`, all DB tables

## 5. Backend Components

### 5.1 `probeRouteToLoopServer()` — `src/lightning/lnd.ts`

New function. Iterates `LOOP_SERVER_PUBKEYS`, calls `queryRoutes` with `source_pub_key = serverPubkey` and `destination = merchantPubkey`. Returns `{routable: true, serverPubkey}` on first match, or `{routable: false, error: "no_route_to_loop_server"}` if all fail.

### 5.2 `checkMemberLoopInPolicy()` — `src/swaps/swapPolicy.ts`

New function. Returns `PolicyResult = {ok: true} | {ok: false, reason, code}`.

Runs in **two phases** because some checks require the quoted fee (which we only have after calling loopd):

**Phase 1 — pre-quote checks** (run BEFORE creating the quote; if any fail, no quote is created):
1. **Amount bounds** — `>= memberMinRefillSat` (100k), `<= memberMaxRefillSat` (3M)
2. **Provider terms** — amount within `getLoopInTerms()` min/max
3. **On-chain balance** — `getLndChainBalance() >= amount + estimatedFee + memberOnchainReserveSat` (50k). Uses a conservative fee estimate since exact fee is unknown pre-quote.
4. **Route probe** — `probeRouteToLoopServer()` returns routable
5. **Daily cap** — today's non-failed loop_in total + amount `<= memberMaxDailyRefillSat` (5M)

**Phase 2 — post-quote checks** (run AFTER the quote as advisory info in the response, and as hard enforcement at confirm time):
6. **Fee cap** — `quotedFee <= amount * loopMaxSwapFeePct / 100` AND `minerFee <= loopMaxMinerFeeSats`

Implementation: single function with an optional `quotedFeeSat` parameter. When omitted (pre-quote), skips step 6. When provided (post-quote / confirm), runs all steps.

Error codes: `below_minimum`, `above_maximum`, `below_loop_minimum`, `insufficient_onchain`, `route_unavailable`, `loop_unavailable`, `fee_exceeds_cap`, `daily_limit_exceeded`.

### 5.3 `createLoopInQuote()` refactor — `src/swaps/swapService.ts`

Change signature from `role: "treasury"` to `role: "member" | "treasury"`. The INSERT already stores role dynamically. No schema work.

### 5.4 Route handlers — `src/swaps/swapRoutes.ts`

**`handleMemberLoopInQuote(req, res)`:**
1. `assertActiveMember(node.membership_status)`
2. Parse `{amount_sat}` from body
3. Run `checkMemberLoopInPolicy` **phase 1** (no `quotedFeeSat`) — if fails with `route_unavailable` → 503; other failures → 429. No quote created on failure.
4. `createLoopInQuote({role: "member", ...})` — calls loopd `GetLoopInQuote`
5. Run `checkMemberLoopInPolicy` **phase 2** (with `quotedFeeSat`) — advisory, included in response as `policy_check` (matches Loop Out pattern)
6. Return `{swap_request, quote, policy_check}`

**`handleMemberLoopIn(req, res)`:**
1. `assertActiveMember`
2. Parse `{swap_request_id}`
3. Fetch existing; verify ownership + status `quote_created` + not expired
4. Re-run `checkMemberLoopInPolicy` **full** (with stored `quoted_fee_sat`) — hard enforcement gate
5. `initiateSwap(swap_request_id)` — existing code branches on `swap_type === "loop_in"`
6. Return `{swap_request, execution}`

### 5.5 Route registration — `src/index.ts`

Two new blocks placed next to existing Loop Out member routes:
- `POST /api/swaps/loop-in/quote` → `handleMemberLoopInQuote`
- `POST /api/swaps/loop-in` → `handleMemberLoopIn`

The existing `POST /api/admin/swaps/loop-in` 410 block stays unchanged.

### 5.6 Env vars — `src/config/env.ts`

| Variable | Type | Default |
|---|---|---|
| `loopServerPubkeys` | `string[]` | `["021c97a90a411ff2b10dc2a8e32de2f29d2fa49d41bfbb52bd416e460db0747d0d"]` |
| `memberMinRefillSat` | `number` | `100_000` |
| `memberMaxRefillSat` | `number` | `3_000_000` |
| `memberMaxDailyRefillSat` | `number` | `5_000_000` |
| `memberOnchainReserveSat` | `number` | `50_000` |

Reuses: `loopMaxSwapFeePct`, `loopMaxMinerFeeSats`, `swapQuoteExpirySec`.

## 6. Frontend Components

### 6.1 New: `app/web/src/pages/RefillChannel.tsx`

**State machine:**
```
"loading"    → check in-flight loop_in → found? → "tracking" : "form"
"form"       → Get Quote → "quoting"
"quoting"    → 503 route_unavailable → "form" + warning banner
               429 policy_violation → "form" + error
               200 → "quoted"
"quoted"     → Confirm → "initiating"
"initiating" → success → "tracking"
               failure → "quoted" + error
"tracking"   → poll every 15s → terminal → reset
```

**Layout (context-forward, top to bottom):**

1. **Header** — "Refill Channel" + subtitle "Add outbound capacity from your on-chain wallet"
2. **Channel state bar** — current member-local %, colored by health (red < 30%, amber 30-60%, green 60%+). If URL has `?amount=X`, show tagline: "Advisor recommended X sats."
3. **On-chain balance card** (amber-tinted) — left: balance in sats, right: max refill
4. **Amount input** — preset buttons (250k/500k/1M/2M/Max) with dynamic disabled state for amounts above max. Free-text with commas + sats suffix. 100k min validation.
5. **Projected-state strip** — "After refill: 12% → 52% local" (updates live as amount changes)
6. **Get Quote button** — full-width primary
7. **Quote panel** (shown in "quoted" stage) — swap fee + miner fee = net fee. No prepay (Loop In doesn't have one). Projected state re-displayed. Countdown timer. "Confirm Refill" button.
8. **Tracking panel** (shown in "tracking" stage):
   - `initiated` → "Publishing on-chain HTLC..."
   - `executing` → "Waiting for Lightning payment from Loop server..."
   - `confirming` → "Almost there — settling..."
   - `completed` → "Refill complete. X sats added to your channel."
   - `failed` → "Refill failed: {reason}" + "Start New Refill" button + reassurance about automatic refund
9. **Recent refills table** — `GET /api/swaps/history?type=loop_in&limit=10`

**Empty/error states:**
- Route unavailable: warning banner, keeps form editable
- Insufficient on-chain: critical alert + "Deposit Bitcoin" and "Fund Node via Coinbase" CTA buttons
- Daily cap exceeded: inline error with limit shown
- Loop unavailable: warning banner "Loop service temporarily unavailable"

### 6.2 API client — `app/web/src/api/client.ts`

Two new methods:
```ts
getSwapLoopInQuote: (body: {amount_sat: number}) =>
  apiFetch<SwapQuoteResponse>("/api/swaps/loop-in/quote", {method: "POST", body: JSON.stringify(body)})

initiateSwapLoopIn: (body: {swap_request_id: string}) =>
  apiFetch<{swap_request: SwapRequest; execution: SwapExecution}>("/api/swaps/loop-in", {method: "POST", body: JSON.stringify(body)})
```

### 6.3 Route change — `App.tsx`

```diff
- <Route path="/refill" element={<WithdrawBitcoin />} />
+ <Route path="/refill" element={<RefillChannel />} />
```

### 6.4 Dashboard integration — `MemberDashboard.tsx`

Both Refill and Cash Out buttons append `?amount=X` when advisor has a recommendation:
```tsx
const refillUrl = advisor?.action === "loop_in" && advisor?.suggestedAmountSats
  ? `/refill?amount=${advisor.suggestedAmountSats}` : "/refill";
const cashOutUrl = advisor?.action === "loop_out" && advisor?.suggestedAmountSats
  ? `/cashout?amount=${advisor.suggestedAmountSats}` : "/cashout";
```

### 6.5 Loop Out parity — `WithdrawBitcoin.tsx`

Four parallel changes:
1. **Pending detection** — same `"loading"` entry state, checks for in-flight `loop_out` swaps
2. **Context-forward layout** — channel state bar (current local %) + projected-state strip ("After withdrawal: 82% → 42% local")
3. **Direction-specific status copy** — `initiated` → "Paying Lightning invoice...", `executing` → "Loop server publishing on-chain HTLC...", `confirming` → "Waiting for on-chain confirmation...", `completed` → "Withdrawal complete — X sats sent to {address}"
4. **Dashboard Cash Out pre-fill** — same URL param pattern as Refill

## 7. Data Flow

### Happy path (500k refill)

1. Merchant opens `/refill` → page mounts → checks for in-flight loop_in → none → form stage
2. Merchant picks 500k → "Get Quote"
3. Backend: `checkMemberLoopInPolicy` → bounds ✓, provider terms ✓, on-chain balance ✓, route probe ✓, fee cap ✓, daily cap ✓
4. Backend: `createLoopInQuote(role: "member")` → loopd `GetLoopInQuote` → returns fees
5. Frontend: quote panel shown with fees + projected state + countdown
6. Merchant clicks "Confirm Refill"
7. Backend: re-check policy → `initiateSwap()` → loopd `LoopIn` RPC → publishes on-chain HTLC
8. Frontend: tracking stage, polls every 15s
9. Status transitions: `initiated` → `executing` → `confirming` → `completed`
10. Merchant's channel local balance increased by ~500k minus fees

### Preflight failure (no treasury inbound)

1. Merchant picks 500k → "Get Quote"
2. Backend: `probeRouteToLoopServer()` → no route found → policy returns `{ok: false, code: "route_unavailable"}`
3. Backend: returns 503 (no quote created)
4. Frontend: warning banner, form stays editable. No on-chain cost.

### Pending detection (navigate back)

1. Merchant navigates to `/refill` → loading state
2. Fetch swap history → filter non-terminal loop_in swaps → found one in `executing`
3. Skip form, jump to tracking with that swap

## 8. Error Handling

### Pre-commit errors (form, quote, confirm stages)

No on-chain tx published. Merchant's funds haven't moved.

| Error code | HTTP | User sees |
|---|---|---|
| `route_unavailable` | 503 | Warning: "Treasury has no inbound capacity for X sats. Try smaller or check back." |
| `loop_unavailable` | 503 | Warning: "Loop service temporarily unavailable." |
| `insufficient_onchain` | 429 | Alert + deep-link CTAs to Deposit / Coinbase Onramp |
| `below_minimum` / `above_maximum` | 429 | Inline error with bound value |
| `below_loop_minimum` | 429 | Inline error: "Below Loop minimum of X sats" |
| `fee_exceeds_cap` | 429 | Error: "Swap fees unusually high. Try when fees drop." |
| `daily_limit_exceeded` | 429 | Error: "Daily refill limit reached (X of 5M). Try tomorrow." |
| `quote_expired` | 400 | Error: "Quote expired." + "Get New Quote" button |
| `swap_initiation_failed` | 500 | Error: "Failed to start refill: {message}." + "Try Again" button |

### Post-commit errors (tracking stage)

On-chain HTLC published. Funds locked but always recoverable via timelock.

| Condition | User sees |
|---|---|
| Stuck > 30 min | Amber badge: "Taking longer than expected. Funds are safe — automatic refund if swap doesn't complete." |
| Status `failed` | Red badge + reason + "Start New Refill" button + refund reassurance |
| Status `expired` | Same as failed, emphasis on automatic refund |
| Poll network error | Silent retry; after 3 failures: "Connection lost. Checking status..." |

## 9. Testing Strategy

### Critical path (must pass before merge)

1. Refill page loads at `/refill` for merchants
2. WithdrawBitcoin still works at `/cashout` for farmers (regression check)
3. Preflight blocks when treasury has no inbound (503 `route_unavailable`)
4. Full happy path: quote → confirm → track → completed
5. Pending detection survives page reload
6. Quote expiry blocks confirmation
7. Insufficient on-chain: dynamic cap + 429 fallback
8. Daily cap enforcement

### Important (should pass)

9. Advisor pre-fill from dashboard button
10. Cash Out pending detection (Loop Out parity)
11. Cash Out context-forward layout parity
12. Insufficient on-chain deep-link buttons work
13. Mobile layout at 375px
14. Admin Loop In 410 unchanged

### Edge cases (if time permits)

15. Swap failure mid-flight — red badge + reassurance
16. Loop daemon down — 503 `loop_unavailable`
17. Two concurrent refills — pending detection picks first non-terminal
18. Amount at exact boundaries (100k min, 3M max)

### Environments

- **Ideal:** Testnet Umbrel node with treasury + merchant, external channel, loopd running
- **Acceptable:** Mainnet with small amount (250k minimum)
- **Frontend-only:** `cd app/web && npm run dev` with mocked API responses
