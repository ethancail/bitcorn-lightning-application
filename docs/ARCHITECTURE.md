# Architecture

## Mission

Bitcorn Lightning is a **Lightning Treasury Capital Allocation Engine** — not a wallet, not a UI product, not a generic routing node.

**Core objective:** Maximize risk-adjusted net sats by deploying capital into channels, rebalancing intelligently, enforcing strict capital guardrails, and tracking true profitability:

```
Net Sats = inbound + forwarding fees − outbound fees − rebalance costs
```

Economic truth > vanity metrics. Do not optimize for channel count, node size, or gossip presence.

### Architectural Roles

- **Treasury node** — capital allocator, channel provisioner, expansion authority, profitability engine, guardrail enforcer. Operates the routing hub and earns forwarding fees. Does **not** orchestrate steady-state rebalancing — that lives on member nodes.
- **Member nodes** — own their channel-side rebalancing decisions via the role-aware Member Liquidity Advisor (farmers run Loop Out, merchants run Loop In, both locally). Outbound payments are routed through forced treasury hops.

### Non-Negotiables

- Guardrails cannot be bypassed by automation
- Capital reserve floors must always be respected
- Deploy ratio limits must always be enforced
- Rebalance costs must always be accounted for
- Automation must be auditable and deterministic
- Safety > growth

## Hub-and-Spoke Topology

- **Treasury Node** (hub): Provides liquidity; has access to all treasury endpoints
- **Member Nodes** (spokes): Pay invoices via treasury channel
- **Node role** is computed on each sync cycle and stored in SQLite (`node_role` column)
  - `treasury`: pubkey matches `TREASURY_PUBKEY` env var
  - `member`: has active treasury channel
  - `external`: no treasury channel

`TREASURY_PUBKEY` is hard-coded in `docker-compose.yml` so all member installs get correct role detection without configuration.

## Sync-Driven State

A sync loop runs every 15s (`src/lightning/sync.ts`), pulling LND state into SQLite. The database is the source of truth for metrics, guardrails, and membership. Live LND calls are only used for critical operations (payments, channel opens, apply fee policy).

The sync loop:
1. Fetches LND wallet info, peers, channels
2. Upserts current channels/peers and **deletes stale rows** (closed channels, disconnected peers) — keeps SQLite in sync with LND
3. Computes `membership_status` and `node_role`
4. Writes node info + history
5. Syncs confirmed inbound invoices
6. Paginates LND forwarding history
7. Auto-cleans stale `requested`/`submitted` expansion executions older than 1h
8. Auto-settles inbound network payments by matching against `payments_inbound`

## Three-Layer Pattern

1. `src/lightning/` — LND gRPC integration via `ln-service`
2. `src/api/` — Business logic (treasury metrics, fees, liquidity health, rebalance)
3. `src/utils/` — Guards: membership, rate limits, capital guardrails, liquidity scoring

## Port Assignments

| Port | Purpose |
|------|---------|
| 3101 | User/Admin API (JWT, Umbrel-aware) |
| 3109 | Node-to-Node API — **reserved, no implementation** |
| 3200 | Web UI |

Do not reuse ports 3001 or 3009. Do not expose port 3109 via Umbrel app-proxy. **Port 3109 is reserved in `ports.ts` but has no implementation — the stub files (`hmac.ts`, `node-api.ts`) were removed 2026-05; the longer-term fate of the reservation itself is an open decision.** No N2N infrastructure exists; member liquidity coordination does not use 3109.

## Database

SQLite at `data/db/bitcorn.sqlite` (mounted at `/data` inside the API container; on Umbrel host: `/home/umbrel/umbrel/app-data/bitcorn-lightning-node/data/db/bitcorn.sqlite`). Migrations run automatically on API startup. Migrations must be idempotent. Never mutate schema manually.

`sqlite3` is not installed in the API Docker image — to query the DB directly, use `sudo sqlite3` on the Umbrel host (the `data/db/` directory is owned by root).

See `docs/DATABASE.md` for the full migration and table list.

## Capital Guardrails

Before any channel open, `src/utils/capital-guardrails.ts` checks:
- Minimum on-chain reserve
- Max deploy ratio
- Max pending opens
- Per-peer capacity cap
- Peer cooldown period
- Daily expansion limit
- Daily total deploy limit

Returns 429 on violation. Policy stored in `treasury_capital_policy` (single row). Read/write via `/api/treasury/capital-policy`.

**Subscription-receipt segregation (Path B / V8 fallback).** The on-chain subscription rail receives 50,000 sats / 30 days payments to per-member deposit addresses. Because `bitcoind` direct RPC is not available, the deposit addresses are LND-internal — created via `createChainAddress` and tagged with a per-member label of the form `bitcorn:subscription:<member_pubkey_short>` stored in `subscription.derivation_path`. Receipts therefore co-mingle with the LND hot-wallet balance physically, but are logically segregated by the address set.

The deploy-ratio guardrail must not see those receipts as deployable capital (subscription revenue is not channel-open reserve). `getDeployableChainBalance()` in `capital-guardrails.ts` reads `getLndChainBalance()` and subtracts the sum of unspent UTXOs whose address is in `subscription.deposit_address`. Only the deploy-ratio numerator uses this helper; display, audit, and other read paths keep using the unfiltered balance. An admin "sweep" action (planned, not in v1) is the explicit moment a subscription receipt becomes deployable: once swept to a non-subscription address, it disappears from the helper's exclusion set.

**Subscription scope is lane-bound.** Only channels whose lane purpose is `merchant_lane` or `farmer_lane` are in subscription scope. `external_peer` (curated list including ACINQ; also tag-matched as `external` / `external-peer`) and `unclassified` peers are exempt entirely — no `subscription` row, no Tier 1/2/3 enforcement, no admin override surface. The lane-purpose check lives in `app/api/src/subscription/lanePurpose.ts` and is invoked at backfill, at per-tick member discovery in the detector, and as defense-in-depth at Tier 3 close-execute time. The Tier 3 scheduler refuses to issue cooperative-close (even in dry-run mode) against any peer whose lane purpose is not `merchant_lane` or `farmer_lane`, so the treasury's external routing channel (e.g., ACINQ) cannot be closed by the subscription enforcement path even if a stale `close_due` row somehow exists.

**Three-tier graduated enforcement.** Tier 1 (hosted-services lapse) attaches at the Cloudflare Worker via Ed25519-signed entitlement tokens issued by the treasury at `POST /api/subscription/token`. Members authenticate to /token with an LND-signed challenge (member proves control of their LND pubkey by signing a time-bounded string); on success the treasury returns a JWT scoped to `full` (tier `current`) or `prepay` (tier `prepay`). Worker-side validation (`cloudflare-worker/src/lib/jwt.ts`) verifies signature against `SUBSCRIPTION_PUBLIC_KEY` (a Cloudflare secret operators copy from the treasury's `/api/admin/subscription/public-key` endpoint), `exp`, `sub`, and `scope` per endpoint. Public endpoints (`/recommended-peers`, `/treasury-info`) bypass auth — members need them before having any token. HMAC-gated treasury writes (`/valuation/manual`, `/valuation/refresh`) keep their existing HMAC contract — token auth and HMAC are orthogonal mechanisms per spec §6.6. Tier 2 (routing-privileges lapse) attaches at the existing `payInvoice` chokepoint and the `/api/network/invoice` route — `prepay`, `routing_lapsed`, and `close_due` get HTTP 402 with a body containing the deposit address and price; `worker_lapsed` is deliberately routing-allowed (Tier 1 penalty alone). Tier 3 (cooperative-close scheduler) runs every 5 minutes by default; ships in dry-run mode in Stage 3 (structured-logs "would_close" events without calling `CloseChannel`) and promotes to live in Stage 6 after a ≥60-day observation window. Both Tier 2 and Tier 3 are env-flagged (`SUBSCRIPTION_TIER2_ENABLED` default true; `SUBSCRIPTION_TIER3_LIVE` default false).

**Entitlement-token lifecycle.** Every node (treasury and members) runs a 12-hour token-refresh scheduler that POSTs to `/api/subscription/token` and caches the JWT in `subscription_local_token`. The 12h cadence overlaps the 24h token validity halfway — a temporary treasury-unreachable window during a refresh doesn't invalidate the node's cached token. On the treasury, the /token endpoint's self-mint carve-out issues a full-scope token for the treasury's own pubkey unconditionally (treasury isn't a subscriber but still needs to authenticate its outgoing Worker calls for things like the autobuy scheduler reading `/valuation/current`). On member nodes, the treasury API URL is resolved in precedence order: (1) operator-set `TREASURY_API_URL` env on the member, (2) Worker discovery via the `api_url` field of `/treasury-info` (treasury operator publishes once via `wrangler secret put TREASURY_API_URL`), (3) failure with a `transport_error` if neither is configured. The Worker-discovery path is the production distribution mechanism — it sidesteps the Tailscale ACL asymmetry because the Worker is the common rendezvous point all nodes can reach, and a single operator action populates the URL for every member without needing SSH into customer-owned Umbrels. Token validation has no per-request callback to the treasury — the 24h lifetime is the implicit revocation window, so a tier change mid-lifetime takes up to 24h to propagate. This is by design per spec §6 ("Short lifetime gives revocation without a denylist or per-request callback").

## Liquidity Management

Steady-state rebalancing in Bitcorn is **member-driven and role-aware**, not treasury-coordinated. Each member self-services their channel based on their declared role: farmers run Loop Out (clearing accumulated local balance), grain merchants run Loop In (refilling depleted local balance). The treasury reserves treasury-side rebalancing for provisioning, external-inbound maintenance, and edge cases — not steady-state operation.

Channels are **provisioned asymmetrically** by role: merchants get high outbound capacity, farmers get high inbound capacity. Rebalancing operations restore this provisioned asymmetry rather than flattening the channel toward 50/50.

Imbalance ratio: `local / (local + remote)`. Classifications: `healthy`, `outbound_starved`, `critical`.

### Member-Side Liquidity Advisor (steady-state)

`src/memberAdvisor/` — runs locally on member nodes every 15 minutes; **skips treasury nodes**. This is the active rebalancing intelligence for steady-state operation; the treasury does not coordinate it.

Classifies treasury channel into 5 states by member-local %:
- `healthy` (30–70%)
- `send_heavy` (>70%)
- `send_saturated` (>85%)
- `receive_heavy` (<30%)
- `receive_exhausted` (<15%)

Urgency escalates on consecutive non-healthy runs.

**Role-aware recommendations**: `channel_role` stored in `member_liquidity_advisor_config` (migration 032), defaults to `'unknown'` — never silently auto-classified.
- **Merchant**: low outbound → Loop In; undersized (< 2M) or 3+ exhaustion runs → channel upgrade
- **Farmer**: high local → Loop Out; undersized (< 1M) or 3+ filling runs → channel upgrade
- **Unknown**: prompts user to set role via Settings

**Close/reopen is never recommended** — Loop In/Out are the normal maintenance path. Each member node ships its own `loopd` (Lightning Terminal sidecar) since v1.8.4, so members can execute Loop In/Out locally without treasury involvement.

### Member Loop In (merchant refill)

Since v1.8.4 every node — treasury, merchant, farmer — ships its own loopd as a litd sidecar (see `bitcorn-lightning-node/docker-compose.yml`). This enables *member-side* Loop In: a merchant uses their own on-chain BTC to restore local Lightning balance on the merchant↔treasury channel.

**Physical flow in the leaf topology:**

```
1. Merchant loopd → Loop server: "swap X sats in"
2. Loop server → returns on-chain HTLC address
3. Merchant on-chain wallet → HTLC address (on-chain tx)
4. Loop server → generates Lightning invoice for merchant
5. Loop server pays invoice via public Lightning routes:
     Loop server → [routes] → TREASURY (external channel)
                                → treasury↔merchant channel
                                  → MERCHANT (local balance ↑)
```

**Dependencies for success:**
- **Treasury inbound on external channels** — the Loop server's invoice payment must reach treasury. If treasury has no remote liquidity on ACINQ/etc., Loop In fails. Treasury-side Loop Out (described below) maintains this inbound as a steady-state plumbing concern.
- **Treasury-local on merchant channel** — treasury must have sats to push across treasury↔merchant. Automatic after merchant has been spending (every merchant payment moves sats to treasury's side of that channel).

**Feedback loop:** Merchant spending naturally accumulates treasury-local on the merchant channel. That's exactly the pool a later Loop In draws from to restore merchant-local. The only external dependency is treasury's inbound on public channels.

**Distinction from treasury-initiated Loop In:** Treasury running Loop In for its own inbound is a DIFFERENT flow that was removed in v1.7.1 (treasury uses Loop Out on external channels instead). `/api/admin/swaps/loop-in` correctly returns 410. Member-side Loop In is a separate flow with its own endpoints.

**When channel lifecycle is the fallback:** If a merchant channel is structurally broken (low ROI, operational issues) or the merchant lacks on-chain BTC entirely, channel rotation/replacement is the backstop. See `docs/plans/2026-03-24-merchant-channel-lifecycle.md`.

### Member Loop Out (farmer cash-out)

Farmers accumulate sats on their local side as they receive payments for commodities. The Member Liquidity Advisor recommends Loop Out once member-local exceeds the threshold; the farmer's own loopd executes the swap, restoring the channel toward its provisioned inbound-heavy shape. Same per-node loopd architecture as merchant Loop In above; Loop Out's mechanics (250k min, ACINQ in-flight cap, prepay-is-not-a-fee) are documented in `docs/LOOP_SETUP.md` and apply identically here.

### Treasury Push (provisioning + edge-case)

`src/memberLiquidity/` — operator-approved keysend push from treasury to member. Used for **initial channel provisioning** (before the member has accumulated transaction flow that would naturally fill their side) and **edge-case maintenance** (e.g., bootstrapping a merchant who can't yet run Loop In). It is **not** part of steady-state rebalancing.

- **Detection**: historically driven by the cluster engine's `liquidityDetector.detectLiquidityOpportunities()`; that function was removed alongside the cluster engine (2026-05). The treasury-push recommendation surface (`/api/member-liquidity/recommendations` etc.) is retained but currently operates on empty inputs — see the latent-finding note below.
- **Estimate**: `liquidityAdvisor` computes the keysend push estimate (60s TTL, ~0 routing fee).
- **Execution**: `liquidityExecutor.executePush()` calls `keysendPush()` to the member after **explicit operator approval** via the Member Liquidity page. No automatic execution.
- **Single action type**: `treasury_push_topup`.
- **Schema**: migration 026 (4 tables: recommendations, estimates, outcomes, config).
- **Future direction**: invoice-based push is preferred per spec but requires N2N infrastructure (port 3109) that doesn't exist.
- **Latent finding (flagged for future investigation):** `liquidityAdvisor` + `liquidityExecutor` still `SELECT` from `rebalance_clusters` / `rebalance_cluster_channels` (migrations 023–025, retained per the 2026-05 dormant-subsystem removal decision option a). The cluster engine was the only writer; with it removed, the tables are read but always empty. The treasury-push approve flow appears functional but has no data path feeding it. Triggers for investigation: this surface needing to function operationally, or the next dormant-subsystem audit.

### Treasury Loop Out (external-inbound maintenance + edge cases)

Treasury-side Loop Out is **not** the steady-state rebalancing tool for member channels. Two retained uses:

1. **Maintaining external inbound** — Loop server payments returning to treasury during member Loop In flows must arrive over external channels (ACINQ et al.). Treasury Loop Out on those external channels keeps the remote liquidity available so member Loop In can succeed.
2. **Edge-case treasury rebalancing** — one-off operator-driven recovery if a treasury-side channel is misshapen.

Mechanical details (apply to both treasury-side and member-side Loop Out):

- Min swap: 250k sats; need ≥556k channel capacity (ACINQ caps `max_value_in_flight_msat` at 45% of channel capacity)
- Verified mainnet via Loop v0.31.8-beta
- Prepay (~30k) is a **temporary hold returned in the on-chain payment**, not a fee
- Net fee = swap_fee + miner_fee (~1–2k typical)

See `docs/LOOP_SETUP.md` for setup, configuration, and gotchas. The optional automated scheduler (`REBALANCE_SCHEDULER_ENABLED=true`) targets critical treasury channels (>85% local) and is an operator opt-in for the external-inbound-maintenance case; off by default.

### Cluster Rebalance Engine v1 (removed 2026-05)

`src/rebalance/` housed the original three-lever rebalancing architecture (fee steering + circular rebalance + topology monitor) operating on per-peer clusters every 15 min. It was superseded by the member-driven role-based model (Member Liquidity Advisor above) and removed in 2026-05 — see `decisions/2026-05-28-dormant-subsystems-disposition.md` (D2 + D2b) in the bitcorn-research repo. The eight modules (`clusterState`, `feeSteering`, `pairSelector`, `cycleEnumerator`, `cycleScorer`, `rebalanceExecutor`, `topologyMonitor`, `rebalanceScheduler`) and the `GET /api/member-liquidity/clusters` endpoint that read from them are gone. The `CLUSTER_REBALANCE_ENABLED` env var is no longer read.

The associated tables (migrations 023–025) and `seeds/001_initial_clusters.sql` are **retained**: retained `memberLiquidity` treasury-push code still `SELECT`s from `rebalance_clusters` / `rebalance_cluster_channels` (see latent-finding note in the Treasury Push section above). A drop migration was deliberately not part of the removal PR.

### Keysend Status

Keysend push as a *rebalancing tool* was disabled at v1.3.5 — it permanently transfers sats in a hub-and-spoke topology rather than rebalancing the channel. The corresponding module (`lightning/rebalance-keysend.ts`) was removed in 2026-05. Keysend remains the execution mechanism for treasury push (see above) and for the keysend-feature pre-flight check on member onboarding via the retained `keysendPush()` primitive in `lightning/lnd.ts`. The `member_keysend_status` table tracks peers that reject keysend so treasury push attempts can skip them with a 24h backoff. The `MEMBER_KEYSEND_DISABLED` alert (warning severity) surfaces this on the treasury dashboard.

## Lane Model

Channel purpose (stable) is separate from channel state (dynamic):

- **Purpose**: `merchant_lane` / `farmer_lane` / `external_peer` / `unclassified` — determined only by contact tags, never by balance heuristics
- **State**: computed from balance, interpreted through purpose lens

Treasury Channels page renders four sections (Merchant Lanes / Farmer Lanes / External Routing Peers / Unclassified) with consistent 6-column layout. Closing channels filtered out of lane tables (shown only in CLOSING section).

## Routing & Payments

- **Member payments forced through treasury channel**: `payInvoice()` auto-detects treasury channel via `TREASURY_PUBKEY` and sets `outgoing_channel`. Prevents members with direct peer channels from bypassing treasury (treasury earns nothing if member-to-member direct route is picked by LND pathfinding).
- **Network payments are invoice-based** (BOLT11). Two modes: Request Payment (create invoice + QR) and Pay Invoice (paste, decode, confirm, pay).
- **Settlement sync**: 15s sync loop matches pending receives in `network_payments` against `payments_inbound`. Auto-settles invoices.
- **Dual recording**: outbound network payments recorded in both `network_payments` and `payments_outbound` for rate limiting compatibility.

## Configuration

See `app/api/src/config/env.ts` — that file is authoritative for all env vars and defaults. `docs/LOOP_SETUP.md` documents Loop-specific vars. `CLAUDE.md` lists only the small handful that change behavior in ways not obvious from reading the code.

## Current Capabilities

The full per-version changelog lives in `git log`. Snapshot of capabilities currently shipped:

**Core treasury engine**
- Channel expansion engine with capital guardrails
- Loop Out (treasury-side, edge-case + external-inbound maintenance — see Liquidity Management above)
- Treasury push (operator-approved provisioning + edge cases)
- Treasury metrics API, rebalance cost ledger (records all rebalance costs regardless of source), forwarding fee tracking
- Auto-cleans stale `requested`/`submitted` expansion executions after 1h

**Merchant/farmer lane model** — purpose stable from tags, state dynamic from balance.

**Role-aware liquidity advisors** — both treasury-side (push top-ups) and member-side (Loop In/Out recommendations).

**Member UI**
- `MemberShell` fetches role and renders role-aware sidebar (Cash Out for farmer, Refill Channel for merchant)
- Farmer dashboard: grain-bin gauge fills as earnings accumulate
- Merchant dashboard: outbound capacity remaining
- Withdrawal page: prominent Available Balance card, accurate fee display (net fee separated from prepay hold), Max button with fee cushion

**Treasury UI**
- Dashboard: Node Balances → Fund Node → Bitcoin Price → Alerts → Treasury Revenue (forwarding fees / rebalance costs / net revenue)
- Treasury Channels page with lane sections
- Treasury Peers page: connect by URI, onboarding guide, live peers table
- Treasury Settings page (max-width 720px): Routing Fee Policy + Capital Guardrails + Appearance
- Swap Operations page: Loop Out / Loop In tabs with visual channel picker
- Member Liquidity page: cluster overview, top-up approvals, history
- Network Topology graph (SVG hub-and-spoke, zoom/pan, role-colored)

**Charts & commodities**
- Bitcoin Power Law Trend (log scale, percentile bands, 2042 projection)
- Price ticker strip: BTC + gold + corn + soybeans + wheat (cached 24h in CF KV)
- BTC Moving Averages (50/100/200-day)
- Corn-Bitcoin ratio (bushels per BTC, USDA monthly interpolated to daily)
- Corn Moving Averages

**Other**
- Coinbase Onramp via Cloudflare Worker session token (see `docs/COINBASE_INTEGRATION.md`)
- Mobile-responsive navigation (hamburger under 768px)
- Contacts: CRUD address book with tag editor, sync-from-peers
- Network payments (invoice-based), forced treasury routing for member payments

## Future Direction

Channel-level ROI scoring, peer profitability ranking, yield-driven capital reallocation, fully autonomous LSP behavior.
