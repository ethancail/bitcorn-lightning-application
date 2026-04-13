# Implementation Notes

Where things live. For architecture and data flow, see `ARCHITECTURE.md`.

## API — Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | All HTTP routes (raw `http.createServer`, if/else chain — NOT Express) |
| `src/lightning/sync.ts` | Main sync orchestrator (15s loop) |
| `src/lightning/persist-channels.ts` | Channel + peer sync to SQLite (upsert current, DELETE stale) |
| `src/lightning/lnd.ts` | LND client, TLS + macaroon setup |
| `src/lightning/pay.ts` | Pay invoice — auto-detects treasury channel via `TREASURY_PUBKEY` and forces `outgoing_channel` |
| `src/lightning/loop.ts` | loopd gRPC client (Lightning Terminal subserver) |
| `src/lightning/rebalance-loop.ts` | Loop Out rebalance execution + auto-select + monitoring |
| `src/lightning/rebalance-scheduler.ts` | Scheduled Loop Out rebalance loop |
| `src/lightning/rebalance-circular.ts` | Circular rebalance execution (legacy, unused in hub-and-spoke) |
| `src/lightning/network-payments.ts` | Network payment business logic (create invoice, pay, history, settlement sync) |
| `src/rebalance/rebalanceScheduler.ts` | Cluster rebalance engine orchestrator (15-min interval) |
| `src/rebalance/clusterState.ts` | Reads cluster definitions + live LND balances + forwarding volumes → `ClusterState[]` |
| `src/rebalance/feeSteering.ts` | Per-cluster fee adjustment (below_band → raise, above_band → lower) |
| `src/rebalance/cycleEnumerator.ts` | Candidate enumeration: amount bucketing, channel selection, route probing |
| `src/rebalance/cycleScorer.ts` | Benefit/cost scoring, picks best candidate or no_action |
| `src/rebalance/rebalanceExecutor.ts` | Executes circular payment, records outcome, updates pair history |
| `src/rebalance/topologyMonitor.ts` | Detects structural issues, emits recommendations, takes inventory snapshots |
| `src/api/treasury.ts` | Aggregate treasury metrics |
| `src/api/treasury-liquidity-health.ts` | Per-channel liquidity assessment |
| `src/api/treasury-channel-metrics.ts` | Per-channel profitability and payback |
| `src/api/treasury-expansion.ts` | Channel expansion recommendations & execution |
| `src/utils/capital-guardrails.ts` | Pre-expansion policy enforcement |
| `src/config/env.ts` | All environment variables with defaults — authoritative |
| `src/memberLiquidity/liquidityDetector.ts` | Treasury-side: detects member channel imbalances from cluster data |
| `src/memberLiquidity/liquidityAdvisor.ts` | Treasury-side: computes keysend push estimates |
| `src/memberLiquidity/liquidityExecutor.ts` | Treasury-side: executes keysend push to member |
| `src/memberLiquidity/liquidityRoutes.ts` | Treasury-side: route handlers for `/api/member-liquidity/*` |
| `src/memberAdvisor/channelClassifier.ts` | Member-side: classifies treasury channel state (5 states × 3 urgencies) |
| `src/memberAdvisor/loopAvailability.ts` | Member-side: checks Loop daemon availability and terms |
| `src/memberAdvisor/recommendationEngine.ts` | Member-side: role-aware recommendations (merchant/farmer/unknown) |
| `src/memberAdvisor/liquidityAdvisorRoutes.ts` | Member-side: route handlers for `/api/liquidity/*` |
| `src/memberAdvisor/advisorScheduler.ts` | Member-side: 15-min scheduler (skips treasury nodes) |
| `src/api/coinbase-onramp.ts` | Calls Cloudflare Worker to obtain a Coinbase session token |
| `cloudflare-worker/src/index.ts` | Cloudflare Worker (Coinbase Onramp + commodity prices + corn history) |

### Routing

`src/index.ts` uses `http.createServer` with an if/else chain. More specific paths (`/api/contacts/sync-peers`) must come **before** general ones (`/api/contacts`). CORS must include every HTTP method used — forgetting PATCH/DELETE causes preflight failures.

## Frontend

**Stack:** React 18 + TypeScript + Vite, react-router-dom v6, amber-on-black design system.

**Design system** lives entirely in `app/web/src/styles.css`. Key CSS custom properties: `--bg`, `--amber`, `--green`, `--red`, `--mono`, `--sans`.

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
| `app/web/src/config/api.ts` | `API_BASE` constant |
| `app/web/src/styles.css` | Full design system |
| `app/web/src/components/NodeBalancePanel.tsx` | Shared balance panel (Total/Bitcoin/Lightning), rendered at top of both dashboards |
| `app/web/src/components/FundNodePanel.tsx` | Coinbase Onramp panel — on-chain balance + "Fund Node via Coinbase →" |
| `app/web/src/components/BitcoinPriceGraph.tsx` | BTC/USD price graph (recharts AreaChart, Coinbase public API) |
| `app/web/src/components/PowerLawChart.tsx` | Bitcoin Power Law chart (log Y, percentile bands, 2042 projection); fills gap days with live Coinbase price |
| `app/web/src/components/MovingAveragesChart.tsx` | BTC 50/100/200-day MAs (1M/1Y/5Y/10Y); exports `computeMA` |
| `app/web/src/components/CornBitcoinChart.tsx` | Bushels-per-BTC ratio; exports `interpolateCornPrices` |
| `app/web/src/components/CornMovingAveragesChart.tsx` | Corn 50/100/200-day MAs; reuses `computeMA` + `interpolateCornPrices` |
| `app/web/src/components/CommodityPricesPanel.tsx` | Price ticker strip (BTC + gold + corn + soy + wheat) |
| `app/web/src/components/NetworkGraph.tsx` | SVG hub-and-spoke topology with zoom/pan (40–300%), role-colored |
| `app/web/src/data/power-law-data.json` | ~10,000 daily entries, 2015-01-01 to 2042-05-31; bundled by Vite |
| `app/web/src/pages/Wizard.tsx` | 5-screen treasury setup wizard |
| `app/web/src/pages/Dashboard.tsx` | Treasury dashboard (revenue-focused) |
| `app/web/src/pages/MemberDashboard.tsx` | Member view: `ConnectToHub` form or role-aware earnings panel |
| `app/web/src/pages/WithdrawBitcoin.tsx` | Member Loop Out withdrawal — routes `/withdraw`, `/cashout` (farmer). **Note:** `/refill` (merchant) currently also points here by accident and needs to route to a Loop In page once built. |
| `app/web/src/pages/SwapOperations.tsx` | Treasury Loop Out / Loop In tabs, visual channel picker |
| `app/web/src/pages/Peers.tsx` | Treasury: connect by URI, onboarding guide, live peers table |
| `app/web/src/pages/MemberLiquidity.tsx` | Treasury: cluster overview, top-up approvals, member channel health table |
| `app/web/src/pages/Payments.tsx` | Invoice-based payments (Request Payment + Pay Invoice) with QR |
| `app/web/src/pages/Charts.tsx` | PowerLawChart + PriceTickerStrip + MovingAverages + CornBitcoin + CornMAs |
| `app/web/src/pages/Contacts.tsx` | CRUD address book with tag editor and sync-from-peers |

### Patterns

**API client:** All calls go through `api.*` methods in `client.ts`. Add new endpoints as `api.methodName: () => apiFetch<ReturnType>("/api/path")`. Types live in the same file.

**Contact name resolution:** `resolveContactName(pubkey, contacts)` in `client.ts` maps pubkeys to contact names with fallback to truncated pubkey. Used across ChannelsPage, ChannelRoiTable, PeerScoresPanel, RotationPanel, DynamicFeesPanel, and payment history. Reuses `truncPubkey` under the hood — do not duplicate the truncation logic.

**Formatting helpers need null guards:** `fmtSats`, `truncPubkey`, `resolveContactName` receive data from API responses and SQLite — all may be undefined/null. Always handle falsy inputs gracefully.

**3-column stat grids:** `dashboard-grid` defaults to `1fr 1fr`. Override inline with `style={{ gridTemplateColumns: "1fr 1fr 1fr" }}` when 3 cards are needed.

**`ConnectToHub`** (inside `MemberDashboard.tsx`): shown when `treasury_channel` is null and no pending treasury channel opening. Polls `/api/channels/pending` every 15s — if a pending open to the treasury exists, shows "Channel Opening Submitted" instead of the form. Capacity presets (1M/5M/10M), formatted text input with commas + sats label, 100k minimum. Three peering states: green "Connected to hub" (direct LND peer check), amber "Hub address available — will auto-connect", or manual input.

### Layout Constraints

**Scroll:** `.app-shell` in `styles.css` uses `height: 100vh` (not `min-height`). This is intentional — it constrains the CSS grid to the viewport so that `overflow-y: auto` on `.main-content` triggers correctly. Changing to `min-height` breaks scrolling. `.main-content` uses `padding-bottom: 64px`.

**Mobile (< 768px):** Sidebar hidden, hamburger in topbar slides sidebar in from the left (200ms ease) over a dark backdrop. Close via: X button, backdrop click, or any nav link. Both shells manage a `menuOpen` boolean, passed as `open`/`onClose` to their sidebar and `onMenuToggle` to `Topbar`. `.dashboard-grid` collapses to single column, `.data-table` gets `min-width: 600px` (horizontal scroll), `.main-content` padding reduced. Desktop (768px+) is unchanged — CSS-only via `@media`.

### Fund Node Panel

Rendered below `NodeBalancePanel` on both dashboards. Calls `api.getNodeBalances()` on mount (one-shot, no poll). Button calls `api.getCoinbaseOnrampUrl()` → `window.open(url, '_blank', 'noopener,noreferrer')`. Maps `coinbase_not_configured` API error to operator-readable message. Falls back to `0 sats` on fetch error (no infinite shimmer).

### Pending Channel Detection

Member dashboard polls `/api/channels/pending` every 15s. Detects pending opens to the treasury so "Channel Opening Submitted" state survives page reloads.

## Role-Based Access Control

Role is derived from identity + treasury channel state — **not** bearer tokens.

- **Public**: health, node info, channels, pending channels, member stats, channel open, contacts, sync-peers, exchange rate, network invoice/decode/payments/sync-settlements, liquidity status/history/config, coinbase onramp URL, commodity prices, peers
- **Member** (active treasury channel): `POST /api/pay`, `POST /api/network/pay`
- **Treasury only**: all `/api/treasury/*` endpoints (metrics, fee policy, liquidity health, expansion, capital policy, rebalance Loop Out, peers), all `/api/member-liquidity/*` endpoints

See `docs/API.md` for the complete endpoint list and request/response shapes.

## Types and Config

- **LND types:** `app/api/src/types/ln-service.d.ts`
- **Node type:** `app/api/src/types/node.ts` (`NodeInfo`, `NodeRole`)
- **Frontend dependencies:** `react`, `react-dom`, `react-router-dom`, `recharts`, `date-fns`, `qrcode`
