# Implementation Notes

Where things live. For architecture and data flow, see `ARCHITECTURE.md`.

## API — Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | All HTTP routes (raw `http.createServer`, if/else chain — NOT Express) |
| `src/lightning/sync.ts` | Main sync orchestrator (15s loop). `membership_status`'s "active" follows the hub rule (`getHubChannel`) over the channels just persisted, not the first treasury channel lnd lists (drive-mode P3) |
| `src/lightning/persist-channels.ts` | Channel + peer sync to SQLite (upsert current, DELETE stale); stores reserves, commit fee, commitment type, in-flight HTLC totals |
| `src/lightning/hubChannel.ts` | The hub channel, one definition for every site: largest active channel to the treasury, lowest short channel ID (numeric) between equals; `getHubChannelForDisplay()` falls back to the largest inactive for stats only |
| `src/lightning/capacity.ts` | One capacity computation: room to send / room to receive from lnd's reserves; for a channel this node opened, room to send also subtracts lnd's fee headroom (derived from lnd v0.20.1-beta, never above what lnd sends); in-flight HTLCs reported, not subtracted |
| `src/lightning/payFeeLimit.ts` | Member payment fee limit (10 sats + 1%, exact in msat; members only) |
| `src/price/btcUsdCache.ts` | In-memory BTC/USD cache: 60 s background refresh, 2 s timeout, fresh/stale/none states |
| `src/lightning/lnd.ts` | LND client, TLS + macaroon setup |
| `src/lightning/pay.ts` | Pay invoice — pins `outgoing_channel` to the hub channel (`hubChannel.ts`) and, for members, sends `max_fee_mtokens` (`payFeeLimit.ts`) |
| `src/lightning/loop.ts` | loopd gRPC client (standalone loopd sidecar, port 11010) |
| `src/lightning/rebalance-loop.ts` | Loop Out rebalance execution + auto-select + monitoring |
| `src/lightning/rebalance-scheduler.ts` | Scheduled Loop Out rebalance loop |
| `src/lightning/network-payments.ts` | Network payment business logic (create invoice, pay, history with `fee_state`, settlement sync); the pay pre-check against room to send; the read-only route query that explains a fee refusal |
| `src/swaps/effectiveLimits.ts` | Pure: the stricter of env limits and loopd's terms, per direction (used by the advisor and `swapLimits.ts`) |
| `src/swaps/swapLimits.ts` | `GET /api/swaps/limits`: effective limits, daily remaining, Withdraw's `available_now_sats` and `always_stays` (what a withdrawal never takes, with its parts), Top Up's on-chain rule (`loopInOnchainRule`) |
| `src/swaps/swapReceipt.ts` | Pure: a completed swap's fee receipt (`receipt` on `GET /api/swaps/:id`) from the poller's stored loopd costs; no migration |
| `src/swaps/swapOptions.ts` | Drive-mode P3: `GET /api/swaps/options` — Withdraw's / Top Up's option cards, exactly one recommended; R25's quote-based Withdraw maximum. Read-only (raw loopd quotes, cached ~60 s; no row, no probe) |
| `src/transfers/transferSettings.ts` | Drive-mode P3: the member's strategy and rails (migrations 074–079); NULL = the code default (`TRANSFER_DEFAULTS`); R16(2) floors and the US-Central day boundary as constants; validation |
| `src/transfers/transferSettingsRoutes.ts` | Drive-mode P3: `GET` / `PATCH /api/transfers/settings` (PATCH exempt from action-confirmation, R40(4)) |
| `src/transfers/minimumConnection.ts` | Drive-mode P3: the one minimum-connection formula, `ceil((F + S_min + K + Q + H + C) / (1 − 2r))`, both roles and strategies (R40(2)) |
| `src/transfers/memberMinimums.ts` | Drive-mode P3: the formula's live inputs for the settings page (role, hub channel, rate, Loop's minimum, the member's fee limit) |
| `src/transfers/feeSamples.ts` | Drive-mode P3: the read-only 6-block fee sampler (≤ every 10 min off the sync tick, 8 days kept) and `calmReading` (calm = estimate ≤ the 7-day median; `unknown` until 7 days of samples) |
| `src/api/nodeBalances.ts` | `GET /api/node/balances`' Lightning side: active-only `lightning_sats` plus `lightning_inactive_sats` (drive-mode P3) |
| `src/api/member-costs.ts` | `GET /api/member/costs`: payment and swap fees over the last 30 days, read-only |
| `src/subscription/pendingPayment.ts` | Drive-mode R45: `GET /api/subscription/pay-from-node/pending` — the newest active pay-from-node send marker (migration 073) or null; reads this node's database only, never fetches the treasury, never clears a marker |
| `src/api/treasury.ts` | Aggregate treasury metrics |
| `src/api/treasury-liquidity-health.ts` | Per-channel liquidity assessment |
| `src/api/treasury-channel-metrics.ts` | Per-channel profitability and payback |
| `src/api/treasury-expansion.ts` | Channel expansion recommendations & execution |
| `src/utils/capital-guardrails.ts` | Pre-expansion policy enforcement |
| `src/config/env.ts` | All environment variables with defaults — authoritative |
| `src/memberAdvisor/channelClassifier.ts` | Member-side: classifies treasury channel state (5 states × 3 urgencies) |
| `src/memberAdvisor/loopAvailability.ts` | Member-side: checks Loop daemon availability and terms |
| `src/memberAdvisor/recommendationEngine.ts` | Member-side: role-aware recommendations (merchant/farmer/unknown). The "recommended minimum" is the one formula's live size (`advisorMinimum.ts`), not 032's stored 2,000,000 / 1,000,000 columns, which are no longer read (drive-mode P3) |
| `src/memberAdvisor/loopAlert.ts` | Member-side, pure: the Loop-unavailable alert per direction (`loopAlert` on `/api/liquidity/status`), four cases, rendered API-side so the unavailability reason stays internal |
| `src/memberAdvisor/liquidityAdvisorRoutes.ts` | Member-side: route handlers for `/api/liquidity/*` |
| `src/memberAdvisor/advisorScheduler.ts` | Member-side: 15-min scheduler (skips treasury nodes) |
| `src/api/coinbase-onramp.ts` | Calls Cloudflare Worker to obtain a Coinbase session token |
| `src/stablecoin/handlers.ts` | Stablecoin rail: member-facing `/api/stablecoin/*` route handlers (spec §8) |
| `src/stablecoin/siwe.ts` | SIWE (EIP-4361) message build + verification for wallet registration (EOA + ERC-1271 smart wallet) |
| `src/stablecoin/nonceStore.ts` | SQLite helpers for `siwe_challenge_nonce` (single-use challenge nonces) |
| `src/stablecoin/staleness.ts` | Rail-specific staleness thresholds for the UI banner |
| `src/base/sync.ts` | BASE sync loop (60s): `Settled`-event ingestion via Worker, balance + governance-state caching (spec §7) |
| `src/base/store.ts` | SQLite helpers for the BASE sync subsystem (cursor, events, caches) |
| `src/base/workerClient.ts` | Typed client for the Worker's `/base/*` endpoints |
| `src/base/staleness.ts` | Pure staleness-signal derivation from sync-loop timestamps |
| `cloudflare-worker/src/index.ts` | Cloudflare Worker thin router (Onramp, prices, valuation, treasury-info, `/base/*` — full endpoint list in its header comment) |
| `cloudflare-worker/src/handlers/base.ts` | Worker BASE proxy: public `/base/contract-info` + allowlisted payment-scope reads |
| `cloudflare-worker/src/lib/baseRpc.ts` | Forwards allowlisted JSON-RPC calls to the upstream BASE RPC (secret URL) |

### Routing

`src/index.ts` uses `http.createServer` with an if/else chain. More specific paths (`/api/contacts/sync-peers`) must come **before** general ones (`/api/contacts`). CORS must include every HTTP method used — forgetting PATCH/DELETE causes preflight failures.

## Frontend

**Stack:** React 18 + TypeScript + Vite, react-router-dom v6.

**Design system** lives entirely in `app/web/src/styles.css`, dark and light themes. Key CSS custom properties: `--bg`, `--text`, `--amber`, `--green`, `--red`, `--mono`, `--sans`. What each colour may mean (red for errors only, blue for information, amber a mark and never a word) is in `docs/UI_CONVENTIONS.md` § Colors.

Key classes:
- Panels: `.panel`, `.panel-header`, `.panel-title`, `.panel-body`
- Stats: `.stat-card`, `.stat-value`, `.stat-label`, `.stat-sub`, `.dashboard-grid`
- Tables: `.data-table`, `.td-mono`, `.td-num`
- Badges: `.badge-green/.red/.amber/.blue/.muted`
- Buttons: `.btn`, `.btn-primary/.outline/.ghost`
- Forms: `.form-input`
- States: `.loading-shimmer`, `.empty-state`, `.alert.critical/.warning/.info/.healthy`
- Flow: `.wizard-*`, `.fade-in`
- Mobile (inside `@media max-width: 767px`): `.hamburger-btn`, `.sidebar-overlay`, `.sidebar-close-btn`, `.sidebar-mobile-header`, `.sidebar.open`

### Dual-Role Routing (`App.tsx`)

`useAppStatus()` fetches `/api/node` → branches on `node_role`:
- `"treasury"` + `localStorage.bitcorn_setup_done === "1"` → `AppShell` (treasury dashboard)
- `"treasury"` without localStorage flag → wizard (`/setup`)
- any other role (`"member"`, `"external"`, `"unsynced"`, errors) → `MemberShell`

All non-treasury nodes get the same `MemberShell`. `MemberDashboard` handles the no-channel state contextually via a `ConnectToHub` form — no routing-level gate based on membership status.

### Web — Key Files

| File | Purpose |
|------|---------|
| `app/web/src/App.tsx` | Root router, both shells (AppShell + MemberShell), mobile hamburger state, all page stubs |
| `app/web/src/api/client.ts` | `apiFetch<T>` helper, namespaced `api.*` object, all types |
| `app/web/src/api/rate.ts` | `rateNote()`: the BTC/USD rate's state as one line of text ("Price as of …" when stale; one sentence when there is no rate) |
| `app/web/src/config/api.ts` | `API_BASE` constant |
| `app/web/src/styles.css` | Full design system |
| `app/web/src/components/BitcoinPriceGraph.tsx` | BTC/USD price graph (recharts AreaChart, Coinbase public API). On all three dashboards it sits immediately beneath the headline numbers (CHART). It measures its plot and fits the time labels to the width (X5); the plot is `--d-chart-h` (480px) tall, `--d-chart-h-ph` (240px) on a phone (X5a, K4) |
| `app/web/src/components/AlertRow.tsx` | X3: a treasury alert as one compact row — icon, the server's heading (SH1), the detail in a closed `<details>`, an optional action. Used by the treasury dashboard and `ValuationInputAlertBanner` |
| `app/web/src/components/pendingPayment.ts` | Drive-mode R45: `pendingPaymentView()` — whether "payment sent, waiting for confirmation" shows (hidden once a **verified** status shows the credit: the marker's txid, or a later `paid_through`; never on an unverified one) — and `pendingPaymentCopy()`, its words (sats only; "may have sent" with no txid) |
| `app/web/src/components/usePendingPayment.ts` | Drive-mode R45: polls the pending route while enabled (the Settings panel every 15 s while applicable; the dashboard banner every 60 s while a tier banner shows); fail-silent, keeps the last answer |
| `app/web/src/components/subscriptionBannerSlot.ts` | J9/J9a: the member dashboard's slot for the subscription banner — `top` for `routing_lapsed`/`close_due`, `info` otherwise |
| `app/web/src/components/loopFailureCopy.ts` | `loopFailureSentence()`: the member-facing sentence for a swap's `failure_reason` per direction — loopd's codes, Bitcorn's own, and a generic one; each money claim cited against loopd v0.33.0's source in the header. Withdraw and Top Up show it; the raw code stays in Technical details |
| `app/web/src/components/PowerLawChart.tsx` | Bitcoin Power Law chart (log Y, percentile bands, 2042 projection); fills gap days with live Coinbase price |
| `app/web/src/components/MovingAveragesChart.tsx` | BTC 50/100/200-day MAs (1M/1Y/5Y/10Y); exports `computeMA` |
| `app/web/src/components/CornBitcoinChart.tsx` | Bushels-per-BTC ratio; exports `interpolateCornPrices` |
| `app/web/src/components/CornMovingAveragesChart.tsx` | Corn 50/100/200-day MAs; reuses `computeMA` + `interpolateCornPrices` |
| `app/web/src/components/CommodityPricesPanel.tsx` | Price ticker strip (BTC + gold + corn + soy + wheat) |
| `app/web/src/data/power-law-data.json` | ~10,000 daily entries, 2015-01-01 to 2042-05-31; bundled by Vite |
| `app/web/src/pages/Wizard.tsx` | 5-screen treasury setup wizard |
| `app/web/src/pages/AutomaticTransfers.tsx` | Drive-mode P3: member route `/automatic-transfers` (nav after Withdraw / Top Up) — the strategy, ONE minimum connection size (R19(6); Manual only's as advice; Keep room open's "unavailable" sentence), the three rails and the US-Central day boundary. No "Turn on", no badge: "Automatic transfers aren't switched on yet." Fetches for itself (no shell read) |
| `app/web/src/components/OptionCards.tsx` | Drive-mode P3: Withdraw's / Top Up's option cards from `GET /api/swaps/options`; a card only pre-fills the amount (the quote and confirmation are unchanged); over the fee limit, "Allow it this once" (UI only) |
| `app/web/src/pages/Dashboard.tsx` | Treasury dashboard: headline (24-hour net, total capital, capital deployed), the price chart, alert rows, then Treasury Revenue, Balances + Fund Node, subscription and rail-fee tiles |
| `app/web/src/pages/MemberDashboard.tsx` | Member view: notice slots, a headline per declared role, the price chart, the alerts slot (`.dash-notices-alerts`: connection down, Loop unavailable, no price — one sentence and one action each), then the channel tile (`ConnectToHub` form when there's no channel; the gauge reads P1's room figures), a Your node tile (dollars first with sats underneath, Fund Node, the farmer's "Received, lifetime") and "Costs, last 30 days". No figure appears twice with every `<details>` closed (D2.1) |
| `app/web/src/pages/WithdrawBitcoin.tsx` | Member Loop Out withdrawal — routes `/withdraw`, `/cashout` (farmer). `/refill` (merchant) routes to `RefillChannel.tsx`, the member Loop In page (`docs/plans/2026-04-14-merchant-refill-channel-design.md`), which reaches `swaps/loopProvider.ts` through `swapService.ts`. |
| `app/web/src/pages/SwapOperations.tsx` | Treasury Loop Out tab, visual channel picker. (Treasury Loop In tab removed — those routes answer 410.) |
| `app/web/src/pages/Peers.tsx` | Treasury: connect by URI, onboarding guide, live peers table |
| `app/web/src/pages/Payments.tsx` | Invoice-based payments (Request Payment + Pay Invoice) with QR |
| `app/web/src/pages/Charts.tsx` | PowerLawChart + PriceTickerStrip + MovingAverages + CornBitcoin + CornMAs |
| `app/web/src/pages/Contacts.tsx` | CRUD address book with tag editor and sync-from-peers. Accepts `?pubkey=` to open the add form with the Node ID prefilled — the landing point for the admin roster's unidentified marker |
| `app/web/src/pages/Stablecoin.tsx` | Stablecoin Settlements page — member-side rail surface (spec §9.1) |
| `app/web/src/stablecoin/RailScope.tsx` | Scoped WagmiProvider wrapper — keeps wagmi off the rest of the UI |
| `app/web/src/stablecoin/wagmi.ts` | Wagmi v2 config: Coinbase Smart Wallet / MetaMask / WalletConnect; default chain from `VITE_BASE_CHAIN_ID` |
| `app/web/src/stablecoin/contract.ts` | SettlementRouter + USDC bindings; BaseScan URL helpers (router address resolved at runtime) |
| `app/web/src/stablecoin/client.ts` | Rail HTTP client extensions (`/api/stablecoin/*`) |
| `app/web/src/stablecoin/pendingStore.ts` | Pending-settlement localStorage adapter (frontend-only Pending state) |
| `app/web/src/stablecoin/revertClassifier.ts` | Maps `settle()` revert reasons to readable errors on the receipt-poll path |
| `app/web/src/stablecoin/components/` | Rail UI: wallet registration, settlement form + history, stale/error banners |

### Patterns

**API client:** All calls go through `api.*` methods in `client.ts`. Add new endpoints as `api.methodName: () => apiFetch<ReturnType>("/api/path")`. Types live in the same file.

**Contact name resolution:** `resolveContactName(pubkey, contacts)` in `client.ts` maps pubkeys to contact names with fallback to truncated pubkey. Used across ChannelsPage, ChannelRoiTable, PeerScoresPanel, RotationPanel, DynamicFeesPanel, and payment history. Reuses `truncPubkey` under the hood — do not duplicate the truncation logic.

**Formatting helpers need null guards:** `fmtSats`, `truncPubkey`, `resolveContactName` receive data from API responses and SQLite — all may be undefined/null. Always handle falsy inputs gracefully.

**3-column stat grids:** `dashboard-grid` defaults to `1fr 1fr`. Override inline with `style={{ gridTemplateColumns: "1fr 1fr 1fr" }}` when 3 cards are needed.

**`ConnectToHub`** (`components/firstRun/ConnectToHub.tsx` markup, `useConnectToHub.ts` behaviour, `connectToHubDescriptor.ts` literals; rendered by `MemberDashboard.tsx`): shown when `treasury_channel` is null and no pending treasury channel opening. Polls `/api/channels/pending` every 15s — if a pending open to the treasury exists, shows "Channel Opening Submitted" instead of the form. Capacity presets (1M/5M/10M), formatted text input with commas + sats label, 100k minimum. Three peering states: green "Connected to hub" (direct LND peer check), amber "Hub address available — will auto-connect", or manual input.

### Layout Constraints

**Scroll:** `.app-shell` in `styles.css` uses `height: 100vh` (then `100dvh`), not `min-height`. This is intentional — it constrains the CSS grid to the viewport so that `overflow-y: auto` on `.main-content` and `.sidebar` triggers correctly. Changing to `min-height` breaks scrolling. The grid is two rows, `56px minmax(0, 1fr)` (`shellGrid.test.ts`); `minmax(0, …)` stops the sidebar's content height from pushing the shell past short windows.

**Top bar (4B/J10, by grid overlap):** the translucent `.topbar` keeps row 1; `.sidebar` and `.main-content` span both rows (`grid-row: 1 / -1`), so content scrolls *beneath* the bar. Their padding adds `--topbar-h` (56px, must equal row 1), and `.main-content`'s `scroll-padding-top` keeps focus moves and `scrollIntoView` below the bar. Translucency (`--chrome-bg`, `--chrome-blur`) is the bar's and the desktop sidebar's only, with solid fallbacks for `prefers-reduced-transparency` and for browsers without `backdrop-filter` (`shellChrome.test.ts`). `.main-content` uses `padding-bottom: 64px`; page content caps at `--d-maxw`, centred.

**Density:** sizes that vary with density read `--d-*` tokens from the DENSITY block near the end of `styles.css` (round 1's variant b; `densityTokens.test.ts`). A token lands with the PR that first reads it.

**Dashboards (PR 6):** all three are one `.dash` flex column, in this order: notice slots, `.dash-header`, the `.headline` numbers (H2 — the user's own money, first and largest), `.headline-status` (stale/unavailable lines; the member's channel-staleness notice), `<BitcoinPriceGraph />` immediately beneath (CHART), then `.dash-grid` (`--d-cols` columns, one on a phone). A headline number is a nowrap `.hl-num` with its unit as an atomic inline after it, so it never splits and "sats" drops below instead; on a phone the numbers stack, and nothing shrinks to fit (X1). On a phone, flex `order` puts `.dash-notices-info` (name prompt, `prepay`/`worker_lapsed`) after the headline and chart, while `.dash-notices-top` (`routing_lapsed`, `close_due`, cert expiry) stays first (J9/J9a). The header class is `.dash-header`, not the app-wide `.page-header`. The treasury's alerts are `AlertRow`s below the chart (SH7). The member headline follows the declared role (SH9): farmer "In your connection" (the local balance) / "Room to receive" (`room_to_receive_sats`), merchant "Available to send" (`room_to_send_sats`) / "Total", unknown "Your balance"/"Room to receive" (both raw); with no channel, "—" and "No channel yet" (drive-mode P2, R11(2), R27(1)). The member dashboard's alerts slot, `.dash-notices-alerts`, sits directly below the chart on desktop and phone alike, so nothing above the chart changes when an alert fires (D2.2, pinned by `MemberDashboard.topRegion.test.tsx` against a pre-P2 snapshot). Pinned by `dashLayout.test.ts`, `Dashboard.headline.test.tsx` and `MemberDashboard.headline.test.tsx`.

**Mobile (< 768px):** Sidebar hidden, hamburger in topbar slides sidebar in from the left (200ms ease) over a dark backdrop. Close via: X button, backdrop click, or any nav link. Both shells manage a `menuOpen` boolean, passed as `open`/`onClose` to their sidebar and `onMenuToggle` to `Topbar`. Both sidebars render one shared `Sidebar` component (items, the links after Buy Bitcoin, Settings' badge); member-only hooks stay in `MemberSidebar` (`App.navInventory.test.tsx`). The phone drawer is solid, not translucent. `.dashboard-grid` collapses to single column, `.data-table` gets `min-width: 600px` (horizontal scroll), `.main-content` padding reduced. Desktop (768px+) is unchanged — CSS-only via `@media`.

### Fund Node Panel

No longer rendered: the dashboards carry their own Fund Node button (the treasury's Balances tile, the member's Your node tile). The component calls `api.getNodeBalances()` on mount (one-shot, no poll). Button calls `api.getCoinbaseOnrampUrl()` → `window.open(url, '_blank', 'noopener,noreferrer')`. Maps `coinbase_not_configured` API error to operator-readable message. Falls back to `0 sats` on fetch error (no infinite shimmer).

### Pending Channel Detection

Member dashboard polls `/api/channels/pending` every 15s. Detects pending opens to the treasury so "Channel Opening Submitted" state survives page reloads.

## Role-Based Access Control

Role is derived from identity + treasury channel state — **not** bearer tokens.

- **Public**: health, node info, channels, pending channels, member stats, channel open, contacts, sync-peers, exchange rate, network invoice/decode/payments/sync-settlements, liquidity status/history/config, coinbase onramp URL, commodity prices, peers
- **Member** (active treasury channel): `POST /api/pay`, `POST /api/network/pay`
- **Treasury only**: all `/api/treasury/*` endpoints (metrics, fee policy, liquidity health, expansion, capital policy, rebalance Loop Out, peers)

See `docs/API.md` for the complete endpoint list and request/response shapes.

## Types and Config

- **LND types:** `app/api/src/types/ln-service.d.ts`
- **Node type:** `app/api/src/types/node.ts` (`NodeInfo`, `NodeRole`)
- **Frontend dependencies:** `react`, `react-dom`, `react-router-dom`, `recharts`, `date-fns`, `qrcode`
