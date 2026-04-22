# UI Conventions & Polish Brief

Brief for any agent or developer picking up frontend polish work in this repo. Written 2026-04-22 — verify against current code if the date is >1 month old.

## Mission

Make the UI **seamless, readable, engaging** without breaking real-money flows, role gating, or the Umbrel app lifecycle. Polish existing pages; don't redesign the whole product.

---

## Do NOT touch without explicit approval

The recently-shipped work below has been validated end-to-end and should stay intact:

- **`app/web/src/pages/AutoBuy.tsx`** + everything under `app/web/src/components/autoBuy/` — v1.12.0 just shipped semicircle gauge + Zone Definitions + Distribution Stats. The SVG gauge math in `ValuationTab.tsx`'s `SemicircleGauge` is subtle; do not rewrite without reason.
- **`app/web/src/pages/ValuationInput.tsx`** — operator-critical path; the Model Inputs section at the bottom is intentional (v1.11.4 moved it here from the public Auto-Buy page).
- **`bitcorn-lightning-node/docker-compose.yml`** + **`bitcorn-lightning-node/exports.sh`** — v1.11.3 fixed the Umbrel app lifecycle by routing operator `.env` through `exports.sh` instead of compose's `env_file`. Do not revert, do not remove `exports.sh`.
- **Auto-Buy real-money paths** — anything in `app/api/src/autoBuy/*` and the routes for `/api/autobuy/*`. Scheduler, Coinbase client, credential vault, caps. These are exercised by production operators and place market orders with real money.
- **`cloudflare-worker/src/valuation/*`** — just landed the NaN-guard + stats fixes in v1.11.4/v1.12.0. Zone classifier, engine, persist types are stable; don't change shape without a spec.

If you find a genuine bug in any of these, fix it and flag in your PR description. But no speculative rewrites.

---

## Design tokens (actual CSS vars in `src/styles.css`)

Use these — don't hardcode hex values.

### Colors

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0a0a0c` | `#faf7f2` | Page background |
| `--panel` | darker slate | warm cream | Panel background |
| `--border` | `#2a2a38` | `#cdc3b3` | Dividers, borders |
| `--text` | `#e8e8f0` | `#1c1408` | Primary text |
| `--text-dim` | ~70% opacity text | ~70% opacity text | Secondary labels |
| `--green` | `#22c55e` | `#15803d` | Positive (gains, success, local balance) |
| `--red` | `#ef4444` | `#dc2626` | Negative (loss, failure, remote balance) |
| `--amber` | `#f59e0b` | `#d97706` | Warning (caution, consecutive failures) |
| `--yellow` | `#eab308` | `#a16207` | Info-warning (rarely used) |
| `--blue` | `#60a5fa` | `#2563eb` | Info, links, scheduled state |

Glow variants (`--green-glow`, `--red-glow`, etc.) are 10%-opacity backgrounds for colored badges/alerts. Always pair `--green-glow` background with `--green` text.

### Typography

- `--mono`: `'IBM Plex Mono', monospace` — numbers, pubkeys, addresses, code
- `--sans`: `'IBM Plex Sans', sans-serif` — everything else
- Operators can override via Settings (Inter, Source, system). Any custom font-family in JSX breaks this — use `var(--mono)` or `var(--sans)`.

### Layout

- `--radius: 6px` — all corner rounding
- Text scale: `--text-scale` CSS var (set via Settings) — inherit it, don't hardcode sizes in rem/px

---

## Layout primitives (use these, don't reinvent)

### `.panel` + `.panel-header` + `.panel-title` + `.panel-body`

The standard containing element. Always use a panel instead of raw `<div>` for sectioning.

```tsx
<div className="panel">
  <div className="panel-header">Section Title</div>
  <div className="panel-body">
    {/* content */}
  </div>
</div>
```

### `.stat-grid` + `.stat-grid-2|3|4` + `.stat-card`

For 2/3/4-column stat displays.

```tsx
<div className="stat-grid stat-grid-3">
  <div className="stat-card">
    <div className="stat-label">Label</div>
    <div className="stat-value positive">123.45</div>
    <div className="stat-sub">optional subtext</div>
  </div>
  {/* … */}
</div>
```

`.stat-value` supports `.positive`, `.negative`, `.amber` modifiers for color.

### `.alert` (critical / warning / info / healthy)

```tsx
<div className="alert warning">
  <span className="alert-icon">⚠</span>
  <div className="alert-body">
    <div className="alert-type">Short headline</div>
    <div className="alert-msg">Longer explanation with what to do next.</div>
  </div>
</div>
```

### `.badge-green` / `-red` / `-amber` / `-blue` / `-muted`

Pill tags for statuses. Used in history tables, peer tags, etc.

```tsx
<span className="badge badge-green">CONFIRMED</span>
```

### `.channel-card` + balance bar primitives

For channel listings — use if you're touching channel UIs (Channels page, RefillChannel, WithdrawBitcoin).

### `.tag-pill`

For contact tags, input labels. Smaller than badges.

### `.loading-shimmer`

Placeholder while async data loads. Set a height via inline style:
```tsx
<div className="loading-shimmer" style={{ height: 320, borderRadius: 6 }} />
```

---

## Component library (existing reusables — don't duplicate)

| Component | Purpose | Where used |
|---|---|---|
| `FundNodePanel` | Coinbase Onramp CTA + deposit address | Dashboards |
| `NodeBalancePanel` | On-chain + channel balance summary | Dashboards |
| `CommodityPricesPanel` | BTC/gold/corn/soy/wheat ticker strip | Charts page |
| `PowerLawChart` | BTC log-price with rainbow bands | Charts |
| `MovingAveragesChart` | 50/100/200-day MA overlays | Charts |
| `CornBitcoinChart` | Corn-bushels-per-BTC over time | Charts |
| `CornMovingAveragesChart` | Corn MA overlays | Charts |
| `BitcoinPriceGraph` | Standalone BTC price, 1M default | Dashboards |
| `NetworkGraph` | Interactive Lightning topology | Liquidity page |
| `ValuationInputAlertBanner` | "Valuation inputs stale" banner | Dashboard |

Under `components/autoBuy/`: `CoinbaseCard`, `HistoryTable`, `InputsTab`, `StrategyTab`, `ValuationTab`. Do not import these outside the Auto-Buy page — they carry page-specific assumptions.

If you need something similar to an existing component, **import it and pass props**. Don't fork. If props don't cover your case, add a prop before copying the file.

---

## Role gating

Two shells in `App.tsx`:

- **`AppShell`** (treasury) — wraps treasury dashboard, full rebalance/Swap controls, Valuation Inputs, etc.
- **`MemberShell`** (member/spoke) — wraps member dashboard, Refill Channel, Cash Out, etc.

Both have independent `<Routes>` + `navItems` arrays. Changes to one shell must consider whether the same change applies to the other.

**Shared routes** (appear in both shells): `/dashboard`, `/charts`, `/contacts`, `/channels`, `/payments`, `/deposit`, `/settings`, `/auto-buy`.

**Treasury-only**: `/peers`, `/liquidity`, `/swaps`, `/valuation-input`.

**Member-only**: `/refill` (merchants), `/cashout` (farmers).

**Current role detection**: `api.getNode()` returns `{ node_role: "treasury" | "node" }`. Don't invent new role values.

---

## Quirks & landmines (non-negotiable)

### Clipboard

`navigator.clipboard.writeText()` silently fails on plain HTTP (Tailscale IPs). Every copy-to-clipboard action must include a `document.execCommand('copy')` fallback with a temporary textarea. Pattern in `Payments.tsx`, `CoinbaseCard.tsx`.

### Async decodePaymentRequest

From `ln-service`: `decodePaymentRequest({ lnd, request })` — **async** and requires `lnd` parameter. The type declaration is wrong; don't trust it. Without `await`, `.tokens` reads as `undefined`.

### `fmtSats` / `truncPubkey` / `resolveContactName`

These formatting helpers in `api/client.ts` can receive `undefined` from API responses. Always call them defensively; they handle nullish inputs gracefully. Don't duplicate the logic inline.

### `resolveContactName(pubkey, contacts)`

Use this everywhere a pubkey is displayed. Resolves to a friendly contact name if one exists, else a truncated pubkey. Requires fetching `api.getContacts()` in the parent component and passing down.

### Number inputs — scroll behavior disabled globally

Browsers change `type=number` input values on mouse-wheel scroll. We've disabled this globally via a wheel-event handler in `App.tsx`. Don't add a second `onWheel` override per-input.

### Dark + light theme

Both themes are supported. Never hardcode a color for one theme — always use CSS vars. Test changes in both via Settings → theme toggle.

---

## Page inventory (status as of 2026-04-22)

### ✅ Polished / recently shipped — leave alone unless fixing a bug

| Page | Why polished |
|---|---|
| `AutoBuy.tsx` + `components/autoBuy/*` | v1.12.0 gauge + panels, just landed |
| `ValuationInput.tsx` | v1.11.4 added Model Inputs section |
| `RefillChannel.tsx` | v1.10.0 Merchant Refill flow, treated as finished |
| `WithdrawBitcoin.tsx` | v1.9.52-53 Max button + Available card redesign |
| `Payments.tsx` | v1.9.38 decluttered, v1.9.39 input formatting |

### 🟡 Mid-aged / OK — improve if clearly beneficial, don't redesign

| Page | Last touched | Notes |
|---|---|---|
| `Dashboard.tsx` | v1.9.46 revamp | Treasury. Revenue-focused, could be more scannable. |
| `MemberDashboard.tsx` | v1.9.0 earnings revamp | Member. Lots of conditional panels based on channel state. |
| `Charts.tsx` | Stable | Chart strip + power law. Clean already. |
| `SwapOperations.tsx` | v1.9.37-38 revamp | Treasury. Channel picker is dense. |
| `MemberLiquidity.tsx` | v1.6.2 | Treasury. Cluster overview + approve/reject modal. |

### 🔴 Rough — high polish impact

| Page | Notes |
|---|---|
| **Settings (`SettingsPage` in App.tsx)** | v1.9.40-43 made it compact, which packed everything in — now feels dense. Clear winner for polish. |
| `Contacts.tsx` (638 lines) | Table-heavy; inline editing needs visual separation from display rows. |
| `Peers.tsx` | Treasury-only; "recommended peers" cards could be more informative. |
| `Wizard.tsx` | Onboarding; first-run experience, matters for new members. Feels dated. |
| `DepositBitcoin.tsx` | Simple but QR + address layout is cramped. |
| **Channels page (defined in App.tsx as `ChannelsPage`)** | Lane tables got column-alignment fixes in v1.9.31-32 but still a lot of information density. |
| **Liquidity page (`LiquidityPage`)** | v1.9.35 reduced it to just the network graph, which is great, but the graph itself could use tooltips/legend polish. |

---

## Suggested attack order (highest impact first)

1. **Settings** — operators see it on every install, high frequency, currently dense.
2. **Wizard / onboarding** — first impression, gates new member adoption.
3. **Dashboard (treasury + member)** — daily-use pages, subtle polish compounds.
4. **Channels page** — lane tables are the operator's main read of node state.
5. **Contacts** — frequent for anyone using the address book.
6. **Charts ticker strip** — small tweaks possible.

Ignore the low-frequency pages (DepositBitcoin, Peers) unless you're already in the file.

---

## Workflow for each page

1. Create a new branch: `feature/ui-<page-name>` off `main` (not develop — main is current).
2. Run `npm run dev` in `app/web/` and navigate to the page.
3. Screenshot current state for the PR description.
4. Brainstorm options (use `superpowers:brainstorming` skill) — present 2-3 visual directions before editing.
5. Get user approval on direction.
6. Implement. **Tiny, reviewable commits.** One concept per commit.
7. Build: `cd app/web && npm run build`. Must be clean.
8. Test both dark and light theme. Screenshot both for the PR.
9. Test on a Tailscale IP (plain HTTP) to catch clipboard / HTTPS-only bugs.
10. Open PR with before/after screenshots. Do not merge without user review.

---

## Accessibility baseline

Current repo ships without ARIA roles on tab bars, dialogs, or menus. Matching precedent is fine — but if you add a new interactive pattern, add ARIA. Specifically:

- Tab bars: `role="tablist"`, each button `role="tab"` + `aria-selected`
- Modals (currently none): trap focus, ESC to close
- Form inputs: wrap in `<label>` (most already do)

Don't add a global accessibility overhaul in one PR; it becomes a massive diff. Layer it in with each page you touch.

---

## Version / release rules

- **Bump `bitcorn-lightning-node/umbrel-app.yml` + `docker-compose.yml` image tags together.** Drift causes Umbrel to pull stale images.
- UI-only changes → patch bump (v1.12.X).
- New feature → minor bump (v1.13.0).
- Breaking compose or data shape → major bump (v2.0.0). Discuss first.
- Always add a release-notes paragraph to `umbrel-app.yml`.

---

## When in doubt

1. Read `CLAUDE.md` at the repo root.
2. Read `docs/IMPLEMENTATION.md` for file-by-file routing map.
3. Read `docs/ARCHITECTURE.md` for data flow.
4. Ask before touching: auth, Lightning flows, rebalance logic, Coinbase flows, Umbrel manifests, or anything under `app/api/src/autoBuy/`.

This is a production Lightning application with real-money capital allocation. Polish the wrapper; don't touch the engine.
