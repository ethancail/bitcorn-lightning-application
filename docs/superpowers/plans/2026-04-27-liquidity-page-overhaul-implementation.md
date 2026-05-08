# Liquidity Page Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the treasury `/liquidity` page (currently a 600px NetworkGraph SVG) with a role-aware overhaul: KPI banner + slim interactive topology + two role lanes (merchants send-capacity / farmers receive-capacity) + collapsible External & Unclassified section. Surface health at a glance instead of forcing the operator to mentally invert the topology fill direction per role.

**Architecture:** New page at `app/web/src/pages/Liquidity.tsx` composed of 5 sub-components in `app/web/src/components/liquidity/`. Pure-TS data layer transforms raw `/api/channels` + contacts into role-aware `LiquidityPeer[]` with computed `rolePct` and `healthTier`. Refresh is manual. FLIP animation handles smooth re-sort on refresh. App.tsx route swap replaces inline `<NetworkGraph />` with `<Liquidity />`.

**Tech Stack:** React 18 + TypeScript + Vite, CSS custom properties, plain SVG (no D3 / no recharts for this page). FLIP via vanilla `getBoundingClientRect` + `transform: translateY` — no new deps.

**Spec:** `docs/superpowers/specs/2026-04-24-liquidity-page-overhaul-design.md` (committed at `484d037`).

---

## Preflight notes for the engineer

- **No automated test suite.** Verification = `cd app/web && npm run build` clean + visual check in `npm run dev`.
- **Branch `feature/ui-liquidity`** off `main`. Already cut and the spec commit is at `484d037`. Do not switch branches.
- **Briefing Room chrome** lives in `app/web/src/styles.css` — `.panel.ops` (line ~248) gives amber border-top + tinted header. `.panel-header`, `.panel-title`, `.panel-body` are the existing structure classes. `.panel-title .icon` for the leading glyph.
- **Do not modify** anything on `docs/UI_CONVENTIONS.md`'s do-not-touch list.
- **Existing API call pattern**: NetworkGraph fetches `/api/channels` via raw `fetch(`${API_BASE}/api/channels`)` — there's no `api.getChannels()` helper. Follow this pattern (don't add the helper here; out of scope).
- **Role detection logic** (today's NetworkGraph at lines 67–85): externalPubkeys hard-coded set + contact tags lowercase. Reuse the same logic verbatim.
- **Current `LiquidityPage()` in `App.tsx` line 2463** is a 3-line function returning `<NetworkGraph />`. We replace its body with `<Liquidity />` from the new page file (and remove the now-unused `NetworkGraph` import).
- **Tokens currently in `:root`**: `--amber`, `--amber-dim`, `--amber-glow`, `--amber-glow2`, `--green`, `--red`, `--blue`, `--purple`, `--bg`, `--bg-1`, `--bg-2`, `--bg-3`, `--text`, `--text-2`, `--text-3`, `--border`, `--border-hi`, `--mono`, `--sans`. All used by this plan; no new tokens needed.
- **Main is at v1.13.7** (PR #125 hide-dashboard-valuation-banner). Task 10 bumps to v1.13.8.

---

## File Structure

### Files created

- `app/web/src/components/liquidity/types.ts` — `LiquidityPeer` type + thresholds + role color map
- `app/web/src/components/liquidity/transform.ts` — `buildLiquidityPeers()`, `classifyHealthTier()`, `comparePeers()`, `formatSatsShort()`, `computeKpis()` pure functions
- `app/web/src/components/liquidity/LiquidityKpiBanner.tsx` — 3 KPI cards
- `app/web/src/components/liquidity/LiquidityLaneRow.tsx` — single row in a lane
- `app/web/src/components/liquidity/LiquidityLane.tsx` — one role-aware lane
- `app/web/src/components/liquidity/LiquidityTopology.tsx` — slim interactive topology
- `app/web/src/components/liquidity/ExternalUnclassifiedSection.tsx` — collapsible section
- `app/web/src/components/liquidity/useFlip.ts` — FLIP animation hook
- `app/web/src/pages/Liquidity.tsx` — page assembly (overwrites current 2-line stub)

### Files modified

- `app/web/src/App.tsx` — replace inline `LiquidityPage()` body with import + render of new `<Liquidity />`
- `app/web/src/styles.css` — append `.liq-*` class block at the end
- `bitcorn-lightning-node/umbrel-app.yml` — version + release notes
- `bitcorn-lightning-node/docker-compose.yml` — both image tags

### Files NOT modified

- `app/web/src/components/NetworkGraph.tsx` — stays on disk, unused after this PR (cleanup is a future PR)
- `app/web/src/pages/MemberLiquidity.tsx` — orphaned, stays orphaned
- Anything else

---

### Task 1: Data layer — types, classification, sort, format

Pure TS. No UI, no React. Sets the data backbone every other component will consume.

**Files:**
- Create: `app/web/src/components/liquidity/types.ts`
- Create: `app/web/src/components/liquidity/transform.ts`

- [ ] **Step 1: Create the types file**

Create `app/web/src/components/liquidity/types.ts`:

```ts
// Liquidity page — role-aware peer health types and constants.

export type LiquidityRole = "merchant" | "farmer" | "external" | "unknown";

export type HealthTier = "critical" | "heavy" | "healthy" | "neutral";

export type LiquidityPeer = {
  pubkey: string;
  name: string;
  role: LiquidityRole;
  capacity: number;          // sum across channels, sats
  memberLocal: number;       // sum of treasury-remote across channels (= member's local)
  memberRemote: number;      // sum of treasury-local across channels (= member's remote)
  channelCount: number;
  // role-aware metric: send% for merchants, receive% for farmers, null for external/unknown
  rolePct: number | null;
  healthTier: HealthTier;
};

// Health thresholds (matches member-side advisor's heavy/saturated bands).
export const HEALTH_CRITICAL_MAX = 0.15; // <15% → critical
export const HEALTH_HEAVY_MAX    = 0.30; // 15-30% → heavy; ≥30% → healthy

// Role color tokens — values are CSS-var strings so theme switches cascade.
export const ROLE_COLOR: Record<LiquidityRole, string> = {
  merchant: "var(--amber)",
  farmer:   "var(--green)",
  external: "var(--blue)",
  unknown:  "var(--text-3)",
};

// Health color tokens — same pattern.
export const HEALTH_COLOR: Record<HealthTier, string> = {
  critical: "var(--red)",
  heavy:    "var(--amber)",
  healthy:  "var(--green)",
  neutral:  "var(--text-3)",
};

// Hard-coded external pubkeys (mirrors NetworkGraph.tsx today). ACINQ.
export const EXTERNAL_PUBKEYS = new Set([
  "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f",
]);
```

- [ ] **Step 2: Create the transform/utilities file**

Create `app/web/src/components/liquidity/transform.ts`:

```ts
import { resolveContactName, type Contact } from "../../api/client";
import {
  EXTERNAL_PUBKEYS,
  HEALTH_CRITICAL_MAX,
  HEALTH_HEAVY_MAX,
  type HealthTier,
  type LiquidityPeer,
  type LiquidityRole,
} from "./types";

export type ChannelData = {
  channel_id: string;
  peer_pubkey: string;
  capacity_sat: number;
  local_balance_sat: number;
  remote_balance_sat: number;
  active: number;
};

function classifyRole(pubkey: string, contact: Contact | undefined): LiquidityRole {
  const tags = (contact?.tags ?? []).map((t) => t.toLowerCase());
  if (EXTERNAL_PUBKEYS.has(pubkey) || tags.includes("external")) return "external";
  if (tags.includes("merchant")) return "merchant";
  if (tags.includes("farmer")) return "farmer";
  return "unknown";
}

export function classifyHealthTier(role: LiquidityRole, rolePct: number | null): HealthTier {
  if (role === "external" || role === "unknown" || rolePct === null) return "neutral";
  if (rolePct < HEALTH_CRITICAL_MAX) return "critical";
  if (rolePct < HEALTH_HEAVY_MAX) return "heavy";
  return "healthy";
}

export function buildLiquidityPeers(
  channels: ChannelData[],
  contacts: Contact[],
): LiquidityPeer[] {
  const peerMap = new Map<string, ChannelData[]>();
  for (const ch of channels) {
    if (!peerMap.has(ch.peer_pubkey)) peerMap.set(ch.peer_pubkey, []);
    peerMap.get(ch.peer_pubkey)!.push(ch);
  }

  const peers: LiquidityPeer[] = [];
  for (const [pubkey, chs] of peerMap) {
    const contact = contacts.find((c) => c.pubkey === pubkey);
    const role = classifyRole(pubkey, contact);
    const capacity = chs.reduce((s, c) => s + c.capacity_sat, 0);
    const treasuryLocal = chs.reduce((s, c) => s + c.local_balance_sat, 0);
    const treasuryRemote = chs.reduce((s, c) => s + c.remote_balance_sat, 0);
    // From treasury POV: treasury_local = member_remote, treasury_remote = member_local.
    const memberLocal = treasuryRemote;
    const memberRemote = treasuryLocal;

    let rolePct: number | null = null;
    if (capacity > 0) {
      if (role === "merchant") rolePct = memberLocal / capacity;
      else if (role === "farmer") rolePct = memberRemote / capacity;
    }

    peers.push({
      pubkey,
      name: resolveContactName(pubkey, contacts),
      role,
      capacity,
      memberLocal,
      memberRemote,
      channelCount: chs.length,
      rolePct,
      healthTier: classifyHealthTier(role, rolePct),
    });
  }

  return peers;
}

// Urgency-first sort: critical → heavy → healthy → neutral. Alphabetical tie-break.
export function comparePeers(a: LiquidityPeer, b: LiquidityPeer): number {
  const tierOrder: Record<HealthTier, number> = {
    critical: 0,
    heavy: 1,
    healthy: 2,
    neutral: 3,
  };
  const tierDiff = tierOrder[a.healthTier] - tierOrder[b.healthTier];
  if (tierDiff !== 0) return tierDiff;
  return a.name.localeCompare(b.name);
}

// Short-format a sats number: "320k", "1.2M", "850" for sub-1000.
export function formatSatsShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

export type LiquidityKpis = {
  totalDeployed: number;
  peerCount: number;
  merchantsHealthy: number;
  merchantsTotal: number;
  merchantsTier: HealthTier; // overall tier — lowest among merchants
  farmersHealthy: number;
  farmersTotal: number;
  farmersTier: HealthTier;
};

function aggregateTier(peers: LiquidityPeer[]): HealthTier {
  if (peers.some((p) => p.healthTier === "critical")) return "critical";
  if (peers.some((p) => p.healthTier === "heavy")) return "heavy";
  if (peers.length === 0) return "neutral";
  return "healthy";
}

export function computeKpis(peers: LiquidityPeer[]): LiquidityKpis {
  const merchants = peers.filter((p) => p.role === "merchant");
  const farmers = peers.filter((p) => p.role === "farmer");
  return {
    totalDeployed: peers.reduce((s, p) => s + p.capacity, 0),
    peerCount: peers.length,
    merchantsHealthy: merchants.filter((p) => p.healthTier === "healthy").length,
    merchantsTotal: merchants.length,
    merchantsTier: aggregateTier(merchants),
    farmersHealthy: farmers.filter((p) => p.healthTier === "healthy").length,
    farmersTotal: farmers.length,
    farmersTier: aggregateTier(farmers),
  };
}
```

- [ ] **Step 3: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/components/liquidity/types.ts app/web/src/components/liquidity/transform.ts
git commit -m "feat(web/liquidity): role-aware peer types + transform utilities

Pure TS data layer for the Liquidity page overhaul. buildLiquidityPeers
takes raw channels + contacts and produces LiquidityPeer[] with
role-aware rolePct (merchant=member-local/cap, farmer=member-remote/cap)
and healthTier per the 15/30 threshold policy. comparePeers handles
urgency-first sort with alphabetical tie-break. computeKpis aggregates
merchant/farmer healthy-counts for the top banner.

Spec: docs/superpowers/specs/2026-04-24-liquidity-page-overhaul-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: KPI Banner component + CSS

Three KPI cards in a horizontal flex row above the page. Reuses Briefing Room chrome.

**Files:**
- Create: `app/web/src/components/liquidity/LiquidityKpiBanner.tsx`
- Modify: `app/web/src/styles.css` (append at end)

- [ ] **Step 1: Create the component**

Create `app/web/src/components/liquidity/LiquidityKpiBanner.tsx`:

```tsx
import { HEALTH_COLOR } from "./types";
import { formatSatsShort, type LiquidityKpis } from "./transform";

type Props = { kpis: LiquidityKpis };

export default function LiquidityKpiBanner({ kpis }: Props) {
  return (
    <div className="liq-kpi-banner">
      <div className="liq-kpi-card panel ops">
        <div className="liq-kpi-label">Total Deployed</div>
        <div className="liq-kpi-value">{formatSatsShort(kpis.totalDeployed)}</div>
        <div className="liq-kpi-sub">{kpis.peerCount} peers</div>
      </div>
      <div className="liq-kpi-card panel ops">
        <div className="liq-kpi-label">Merchants Send-Ready</div>
        <div className="liq-kpi-value" style={{ color: HEALTH_COLOR[kpis.merchantsTier] }}>
          {kpis.merchantsHealthy}<span className="liq-kpi-divider">/</span>{kpis.merchantsTotal}
        </div>
        <div className="liq-kpi-sub">healthy / total</div>
      </div>
      <div className="liq-kpi-card panel ops">
        <div className="liq-kpi-label">Farmers Receive-Ready</div>
        <div className="liq-kpi-value" style={{ color: HEALTH_COLOR[kpis.farmersTier] }}>
          {kpis.farmersHealthy}<span className="liq-kpi-divider">/</span>{kpis.farmersTotal}
        </div>
        <div className="liq-kpi-sub">healthy / total</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append CSS to `app/web/src/styles.css`**

Append at the very end of the file (after the last existing rule):

```css

/* ─── Liquidity page overhaul ────────────────────────────────── */

.liq-kpi-banner {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}

.liq-kpi-card {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.liq-kpi-label {
  font-family: var(--mono);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--amber-dim);
  font-weight: 600;
}

.liq-kpi-value {
  font-family: var(--mono);
  font-size: 1.625rem;
  font-weight: 600;
  color: var(--text);
  line-height: 1.1;
}

.liq-kpi-divider {
  color: var(--text-3);
  margin: 0 2px;
  font-weight: 400;
}

.liq-kpi-sub {
  font-size: 0.75rem;
  color: var(--text-3);
}

@media (max-width: 720px) {
  .liq-kpi-banner { grid-template-columns: 1fr; }
}
```

- [ ] **Step 3: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/components/liquidity/LiquidityKpiBanner.tsx app/web/src/styles.css
git commit -m "feat(web/liquidity): KPI banner — 3 cards across the top

Total Deployed, Merchants Send-Ready (n/total), Farmers Receive-Ready
(n/total). Each card is .panel.ops with the Briefing Room chrome.
Healthy count value color follows the aggregate tier (red if any
critical, amber if any heavy, green if all healthy). Mobile breakpoint
stacks the 3 cards vertically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Lane Row component + CSS

A single row in either the merchant or farmer lane. Standard 4-column layout.

**Files:**
- Create: `app/web/src/components/liquidity/LiquidityLaneRow.tsx`
- Modify: `app/web/src/styles.css` (append)

- [ ] **Step 1: Create the row component**

Create `app/web/src/components/liquidity/LiquidityLaneRow.tsx`:

```tsx
import { forwardRef } from "react";
import { HEALTH_COLOR, ROLE_COLOR, type LiquidityPeer } from "./types";
import { formatSatsShort } from "./transform";

type Props = {
  peer: LiquidityPeer;
  isSelected: boolean;
  pulseKey: number; // bump to replay the pulse animation
};

const LiquidityLaneRow = forwardRef<HTMLDivElement, Props>(({ peer, isSelected, pulseKey }, ref) => {
  const pct = peer.rolePct ?? 0;
  const pctInt = Math.round(pct * 100);
  const tierColor = HEALTH_COLOR[peer.healthTier];
  const roleColor = ROLE_COLOR[peer.role];

  return (
    <div
      ref={ref}
      className={`liq-lane-row${isSelected ? " is-selected" : ""}`}
      data-pubkey={peer.pubkey}
      data-pulse-key={pulseKey}
    >
      <span className="liq-lane-row-name" style={{ color: roleColor }}>
        {peer.name}
      </span>
      <span className="liq-lane-row-cap">{formatSatsShort(peer.capacity)}</span>
      <div className="liq-health-bar">
        <div
          className="liq-health-bar-fill"
          style={{
            width: `${pctInt}%`,
            background: tierColor,
          }}
        />
      </div>
      <span
        className="liq-health-chip"
        style={{
          color: tierColor,
          background: `color-mix(in srgb, ${tierColor} 20%, transparent)`,
        }}
      >
        {pctInt}%
      </span>
    </div>
  );
});

LiquidityLaneRow.displayName = "LiquidityLaneRow";

export default LiquidityLaneRow;
```

- [ ] **Step 2: Append row CSS**

Append at the end of `app/web/src/styles.css`:

```css

.liq-lane-row {
  display: grid;
  grid-template-columns: 110px 60px 1fr 60px;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  transition: background 0.2s, border-color 0.2s;
}

.liq-lane-row:last-child { border-bottom: 0; }

.liq-lane-row.is-selected {
  background: color-mix(in srgb, var(--amber) 6%, transparent);
}

.liq-lane-row-name {
  font-family: var(--mono);
  font-size: 0.8125rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.liq-lane-row-cap {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--text-3);
  text-align: right;
}

.liq-health-bar {
  height: 8px;
  background: var(--bg-3);
  border-radius: 4px;
  overflow: hidden;
}

.liq-health-bar-fill {
  height: 100%;
  border-radius: 4px;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1), background 0.2s;
}

.liq-health-chip {
  font-family: var(--mono);
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  text-align: center;
  letter-spacing: 0.02em;
}
```

- [ ] **Step 3: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/components/liquidity/LiquidityLaneRow.tsx app/web/src/styles.css
git commit -m "feat(web/liquidity): lane row — name · capacity · bar · chip

Standard row used by both merchant and farmer lanes. Forward-ref so the
parent lane can attach refs for FLIP measurement (Task 8). Bar fill
animates width on data change (400ms cubic-bezier). Chip background uses
color-mix() so the soft tint composes with the CSS-var color.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Lane component + CSS

One role-aware lane. Sorts peers urgency-first, renders one `LiquidityLaneRow` per peer.

**Files:**
- Create: `app/web/src/components/liquidity/LiquidityLane.tsx`
- Modify: `app/web/src/styles.css` (append)

- [ ] **Step 1: Create the lane component**

Create `app/web/src/components/liquidity/LiquidityLane.tsx`:

```tsx
import { useMemo, useRef } from "react";
import LiquidityLaneRow from "./LiquidityLaneRow";
import { comparePeers } from "./transform";
import type { LiquidityPeer } from "./types";

type Props = {
  title: string;
  peers: LiquidityPeer[];
  selectedPubkey: string | null;
  pulseKey: number;
  rowRefs: Map<string, HTMLDivElement | null>;
};

export default function LiquidityLane({ title, peers, selectedPubkey, pulseKey, rowRefs }: Props) {
  const sorted = useMemo(() => [...peers].sort(comparePeers), [peers]);

  return (
    <div className="liq-lane panel ops fade-in">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        <span className="badge badge-muted">{sorted.length}</span>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {sorted.length === 0 ? (
          <div className="empty-state" style={{ padding: 16 }}>No peers in this role.</div>
        ) : (
          sorted.map((peer) => (
            <LiquidityLaneRow
              key={peer.pubkey}
              peer={peer}
              isSelected={peer.pubkey === selectedPubkey}
              pulseKey={pulseKey}
              ref={(el) => { rowRefs.set(peer.pubkey, el); }}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append lane CSS**

Append at the end of `app/web/src/styles.css`:

```css

.liq-lanes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}

.liq-lane .panel-body {
  display: flex;
  flex-direction: column;
}

@media (max-width: 720px) {
  .liq-lanes { grid-template-columns: 1fr; }
}
```

- [ ] **Step 3: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/components/liquidity/LiquidityLane.tsx app/web/src/styles.css
git commit -m "feat(web/liquidity): lane — urgency-sorted role-specific peer list

One lane per role (merchants/farmers). Sort is critical→heavy→healthy
with alphabetical tie-break (comparePeers from transform.ts). Briefing
Room chrome (.panel.ops). rowRefs Map is populated as a side effect of
the row ref callback so the parent page can measure positions for FLIP
animation in Task 8. Mobile breakpoint stacks the two lanes vertically.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Topology component + CSS

Slim radial SVG (~140px tall). Hover/click/keyboard interactions emit `selectedPubkey` to parent.

**Files:**
- Create: `app/web/src/components/liquidity/LiquidityTopology.tsx`
- Modify: `app/web/src/styles.css` (append)

- [ ] **Step 1: Create the topology component**

Create `app/web/src/components/liquidity/LiquidityTopology.tsx`:

```tsx
import { useMemo, useState, useCallback } from "react";
import { HEALTH_COLOR, ROLE_COLOR, type LiquidityPeer } from "./types";
import { formatSatsShort } from "./transform";

type Props = {
  peers: LiquidityPeer[];
  treasuryAlias: string;
  selectedPubkey: string | null;
  onSelect: (pubkey: string | null) => void;
};

const W = 800;
const H = 220;
const HUB_R = 22;
const NODE_R = 10;
const ORBIT_R = 75;

export default function LiquidityTopology({ peers, treasuryAlias, selectedPubkey, onSelect }: Props) {
  const [focusedIdx, setFocusedIdx] = useState<number>(-1);

  const positioned = useMemo(() => {
    const cx = W / 2;
    const cy = H / 2;
    const maxCap = Math.max(...peers.map((p) => p.capacity), 1);
    return peers.map((peer, i) => {
      const angle = (i / Math.max(peers.length, 1)) * 2 * Math.PI - Math.PI / 2;
      const x = cx + Math.cos(angle) * ORBIT_R;
      const y = cy + Math.sin(angle) * ORBIT_R;
      const lineWidth = Math.max(1, (peer.capacity / maxCap) * 4);
      return { peer, x, y, cx, cy, lineWidth };
    });
  }, [peers]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<SVGSVGElement>) => {
      if (peers.length === 0) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = (focusedIdx + 1 + peers.length) % peers.length;
        setFocusedIdx(next);
        onSelect(peers[next].pubkey);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = (focusedIdx - 1 + peers.length) % peers.length;
        setFocusedIdx(next);
        onSelect(peers[next].pubkey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setFocusedIdx(-1);
        onSelect(null);
      }
    },
    [focusedIdx, peers, onSelect],
  );

  if (peers.length === 0) {
    return (
      <div className="liq-topology panel ops fade-in">
        <div className="panel-header">
          <span className="panel-title"><span className="icon">⟐</span>Network Topology</span>
        </div>
        <div className="empty-state" style={{ padding: 16 }}>No active channels.</div>
      </div>
    );
  }

  return (
    <div className="liq-topology panel ops fade-in">
      <div className="panel-header">
        <span className="panel-title"><span className="icon">⟐</span>Network Topology</span>
        <span className="badge badge-muted">{peers.length} peers</span>
      </div>
      <div className="panel-body" style={{ padding: 8 }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="liq-topology-svg"
          tabIndex={0}
          onKeyDown={handleKeyDown}
          role="application"
          aria-label="Network topology — use arrow keys to navigate peers"
        >
          {/* Spoke lines */}
          {positioned.map(({ peer, x, y, cx, cy, lineWidth }) => (
            <line
              key={`line-${peer.pubkey}`}
              x1={cx} y1={cy} x2={x} y2={y}
              stroke={ROLE_COLOR[peer.role]}
              strokeWidth={lineWidth}
              strokeOpacity={selectedPubkey === peer.pubkey ? 0.8 : 0.35}
              strokeLinecap="round"
            />
          ))}

          {/* Hub */}
          {(() => {
            const cx = W / 2;
            const cy = H / 2;
            return (
              <>
                <circle cx={cx} cy={cy} r={HUB_R} fill="var(--bg-2)" stroke="var(--amber)" strokeWidth={2} />
                <text x={cx} y={cy + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--amber)" fontFamily="var(--mono)">
                  {treasuryAlias.length > 10 ? treasuryAlias.slice(0, 10) : treasuryAlias}
                </text>
              </>
            );
          })()}

          {/* Peer nodes */}
          {positioned.map(({ peer, x, y }) => {
            const isSelected = selectedPubkey === peer.pubkey;
            const r = isSelected ? NODE_R + 3 : NODE_R;
            const ringColor = HEALTH_COLOR[peer.healthTier];
            const fillColor = ROLE_COLOR[peer.role];
            return (
              <g
                key={`node-${peer.pubkey}`}
                onMouseEnter={() => onSelect(peer.pubkey)}
                onClick={() => onSelect(peer.pubkey)}
                style={{ cursor: "pointer" }}
                aria-label={`${peer.name}, ${formatSatsShort(peer.capacity)} capacity, ${
                  peer.rolePct !== null ? `${Math.round(peer.rolePct * 100)}% ${peer.role === "merchant" ? "send" : "receive"} capacity` : "external"
                }, ${peer.healthTier}`}
              >
                <circle cx={x} cy={y} r={r + 3} fill="none" stroke={ringColor} strokeWidth={2} strokeOpacity={peer.healthTier === "neutral" ? 0.4 : 0.85} />
                <circle cx={x} cy={y} r={r} fill={fillColor} strokeOpacity={0} />
                <text x={x} y={y - r - 6} textAnchor="middle" fontSize={9} fill="var(--text-2)" fontFamily="var(--mono)">
                  {peer.name.length > 10 ? peer.name.slice(0, 9) + "…" : peer.name}
                </text>
                <text x={x} y={y + r + 12} textAnchor="middle" fontSize={8} fill="var(--text-3)" fontFamily="var(--mono)">
                  {formatSatsShort(peer.capacity)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append topology CSS**

Append at the end of `app/web/src/styles.css`:

```css

.liq-topology { margin-bottom: 16px; }

.liq-topology-svg {
  width: 100%;
  height: 200px;
  display: block;
  border-radius: 6px;
  background: var(--bg-2);
  outline: none;
}

.liq-topology-svg:focus-visible {
  outline: 2px solid var(--amber);
  outline-offset: 2px;
}

.liq-topology-svg circle, .liq-topology-svg line, .liq-topology-svg text {
  transition: stroke-opacity 0.2s, r 0.2s ease-out;
}
```

- [ ] **Step 3: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/components/liquidity/LiquidityTopology.tsx app/web/src/styles.css
git commit -m "feat(web/liquidity): slim interactive topology

~200px tall radial SVG with treasury hub center, peers on a circle.
Spoke color = role color, thickness = capacity. Node fill = role color,
ring color = health tier. Hover/click both call onSelect — single-select
pattern. Keyboard (Arrow keys / Esc) walks through peers. ARIA labels
on each node read role-aware health out loud. Empty-state panel for
zero-peer case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: External & Unclassified collapsible section

Beneath the two role lanes. Closed by default. Plain table of external/unknown peers.

**Files:**
- Create: `app/web/src/components/liquidity/ExternalUnclassifiedSection.tsx`
- Modify: `app/web/src/styles.css` (append)

- [ ] **Step 1: Create the section**

Create `app/web/src/components/liquidity/ExternalUnclassifiedSection.tsx`:

```tsx
import { useState } from "react";
import { ROLE_COLOR, type LiquidityPeer } from "./types";
import { formatSatsShort } from "./transform";

type Props = { peers: LiquidityPeer[] };

export default function ExternalUnclassifiedSection({ peers }: Props) {
  const [open, setOpen] = useState(false);
  if (peers.length === 0) return null;

  return (
    <div className="liq-external-section panel fade-in">
      <button
        type="button"
        className="liq-external-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="liq-external-chevron">{open ? "▾" : "▸"}</span>
        <span className="liq-external-title">External &amp; Unclassified</span>
        <span className="badge badge-muted">{peers.length}</span>
      </button>
      {open && (
        <div className="panel-body">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th style={{ textAlign: "right" }}>Capacity</th>
                <th style={{ textAlign: "right" }}>Treasury Local</th>
                <th style={{ textAlign: "right" }}>Treasury Remote</th>
                <th style={{ textAlign: "right" }}>Util %</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((peer) => {
                const util = peer.capacity > 0 ? Math.round((peer.memberRemote / peer.capacity) * 100) : 0;
                return (
                  <tr key={peer.pubkey}>
                    <td style={{ color: ROLE_COLOR[peer.role], fontWeight: 600 }}>{peer.name}</td>
                    <td style={{ color: "var(--text-3)", textTransform: "capitalize" }}>{peer.role}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{formatSatsShort(peer.capacity)}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-3)" }}>{formatSatsShort(peer.memberRemote)}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)", color: "var(--text-3)" }}>{formatSatsShort(peer.memberLocal)}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--mono)" }}>{util}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Append section CSS**

Append at the end of `app/web/src/styles.css`:

```css

.liq-external-section { margin-bottom: 16px; }

.liq-external-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--bg-2);
  border: none;
  width: 100%;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-3);
  font-weight: 600;
  text-align: left;
  border-radius: var(--radius-lg);
  transition: background 0.2s;
}

.liq-external-header:hover { background: var(--bg-3); }

.liq-external-chevron {
  display: inline-block;
  width: 12px;
  color: var(--text-3);
  font-size: 0.875rem;
}

.liq-external-title { flex: 1; }

.liq-external-section .panel-body {
  border-top: 1px solid var(--border);
}
```

- [ ] **Step 3: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/components/liquidity/ExternalUnclassifiedSection.tsx app/web/src/styles.css
git commit -m "feat(web/liquidity): External & Unclassified collapsible section

Closed by default. Plain table reveal on click — name, role, capacity,
treasury local/remote, utilization%. No role-specific framing because
external peers (ACINQ) and unclassified peers don't have a role
preference. Header is neutral text-3 (not amber-dim) to distinguish
this from the primary role lanes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Page assembly + App.tsx route swap

Wires everything together. State: peers, selectedPubkey, isRefreshing, pulseKey. Refresh button triggers a re-fetch + pulse-key bump. Routing swap replaces the inline `LiquidityPage()`.

**Files:**
- Create: `app/web/src/pages/Liquidity.tsx` (overwrites existing 2-line stub)
- Modify: `app/web/src/App.tsx` lines 13–22 (imports) + lines 2463–2465 (LiquidityPage body)

- [ ] **Step 1: Create the page**

Create `app/web/src/pages/Liquidity.tsx` (overwrites the 2-line TODO stub):

```tsx
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { api, type Contact } from "../api/client";
import { API_BASE } from "../config/api";
import LiquidityKpiBanner from "../components/liquidity/LiquidityKpiBanner";
import LiquidityTopology from "../components/liquidity/LiquidityTopology";
import LiquidityLane from "../components/liquidity/LiquidityLane";
import ExternalUnclassifiedSection from "../components/liquidity/ExternalUnclassifiedSection";
import { buildLiquidityPeers, computeKpis, type ChannelData } from "../components/liquidity/transform";
import type { LiquidityPeer } from "../components/liquidity/types";

export default function Liquidity() {
  const [peers, setPeers] = useState<LiquidityPeer[]>([]);
  const [treasuryAlias, setTreasuryAlias] = useState("Treasury");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedPubkey, setSelectedPubkey] = useState<string | null>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());

  const fetchData = useCallback(async () => {
    const [channelsResp, contacts, nodeInfo] = await Promise.all([
      fetch(`${API_BASE}/api/channels`).then((r) => r.json()) as Promise<ChannelData[]>,
      api.getContacts().catch(() => [] as Contact[]),
      api.getNode().catch(() => null),
    ]);
    if (nodeInfo?.alias) setTreasuryAlias(nodeInfo.alias);
    setPeers(buildLiquidityPeers(channelsResp, contacts));
  }, []);

  useEffect(() => {
    fetchData().finally(() => setLoading(false));
  }, [fetchData]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchData();
    } finally {
      setRefreshing(false);
    }
  }, [fetchData]);

  const handleSelect = useCallback((pubkey: string | null) => {
    setSelectedPubkey(pubkey);
    setPulseKey((k) => k + 1);
    if (pubkey) {
      const row = rowRefs.current.get(pubkey);
      row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  const merchants = useMemo(() => peers.filter((p) => p.role === "merchant"), [peers]);
  const farmers = useMemo(() => peers.filter((p) => p.role === "farmer"), [peers]);
  const others = useMemo(() => peers.filter((p) => p.role === "external" || p.role === "unknown"), [peers]);
  const kpis = useMemo(() => computeKpis(peers), [peers]);

  if (loading) {
    return (
      <div className="panel fade-in">
        <div className="panel-body" style={{ padding: 32, textAlign: "center" }}>
          <div className="loading-shimmer" style={{ width: 200, height: 16, margin: "0 auto", borderRadius: 4 }} />
        </div>
      </div>
    );
  }

  return (
    <div className="liq-page fade-in">
      <div className="liq-page-header">
        <h1 className="liq-page-title">Liquidity</h1>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={handleRefresh}
          disabled={refreshing}
          style={{ fontSize: "0.75rem" }}
        >
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      <LiquidityKpiBanner kpis={kpis} />

      <LiquidityTopology
        peers={peers}
        treasuryAlias={treasuryAlias}
        selectedPubkey={selectedPubkey}
        onSelect={handleSelect}
      />

      <div className="liq-lanes">
        <LiquidityLane
          title="[ Merchants · Send Capacity ]"
          peers={merchants}
          selectedPubkey={selectedPubkey}
          pulseKey={pulseKey}
          rowRefs={rowRefs.current}
        />
        <LiquidityLane
          title="[ Farmers · Receive Capacity ]"
          peers={farmers}
          selectedPubkey={selectedPubkey}
          pulseKey={pulseKey}
          rowRefs={rowRefs.current}
        />
      </div>

      <ExternalUnclassifiedSection peers={others} />
    </div>
  );
}
```

- [ ] **Step 2: Append page-shell CSS**

Append at the end of `app/web/src/styles.css`:

```css

.liq-page { display: flex; flex-direction: column; }

.liq-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.liq-page-title {
  font-family: var(--mono);
  font-size: 1rem;
  font-weight: 600;
  color: var(--amber-dim);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0;
}
```

- [ ] **Step 3: Modify `app/web/src/App.tsx`**

Two edits in this file:

3a. Around line 21, after the `import NetworkGraph from "./components/NetworkGraph";` line, add:

```tsx
import Liquidity from "./pages/Liquidity";
```

3b. Replace the `LiquidityPage` function at line 2463–2465. Find:

```tsx
function LiquidityPage() {
  return <NetworkGraph />;
}
```

Replace with:

```tsx
function LiquidityPage() {
  return <Liquidity />;
}
```

The `NetworkGraph` import at line 21 stays — it's still in the file even though not rendered. Cleanup is a future PR per the spec.

- [ ] **Step 4: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/web/src/pages/Liquidity.tsx app/web/src/App.tsx app/web/src/styles.css
git commit -m "feat(web/liquidity): page assembly + route swap

Liquidity.tsx composes KPI banner + topology + two lanes + external
section. State: peers, selectedPubkey, pulseKey, refreshing. Refresh
button calls fetchData and bumps pulseKey for selection re-pulse. Click
or hover on a topology peer scrolls its lane row into view.

App.tsx LiquidityPage now renders <Liquidity /> instead of <NetworkGraph />.
NetworkGraph import retained — cleanup in a future PR.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: FLIP re-sort animation hook

Adds smooth row sliding when refresh changes the urgency order. Vanilla approach — measure before, measure after, animate `transform: translateY` to zero.

**Files:**
- Create: `app/web/src/components/liquidity/useFlip.ts`
- Modify: `app/web/src/components/liquidity/LiquidityLane.tsx` to consume the hook

- [ ] **Step 1: Create the hook**

Create `app/web/src/components/liquidity/useFlip.ts`:

```ts
import { useLayoutEffect, useRef } from "react";

// FLIP: First, Last, Invert, Play. Tracks an array of keys and animates
// each element's translateY when its DOM position changes between renders.
export function useFlip(keys: string[], elements: Map<string, HTMLElement | null>, durationMs = 500) {
  const prevPositions = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const newPositions = new Map<string, number>();
    for (const key of keys) {
      const el = elements.get(key);
      if (el) newPositions.set(key, el.getBoundingClientRect().top);
    }

    // First pass: compute deltas vs previous positions; if changed, prime the inverted transform.
    for (const key of keys) {
      const el = elements.get(key);
      if (!el) continue;
      const prevTop = prevPositions.current.get(key);
      const newTop = newPositions.get(key);
      if (prevTop !== undefined && newTop !== undefined && prevTop !== newTop) {
        const delta = prevTop - newTop;
        el.style.transition = "none";
        el.style.transform = `translateY(${delta}px)`;
      }
    }

    // Second pass (next frame): release the transform with a transition so the row slides into place.
    requestAnimationFrame(() => {
      for (const key of keys) {
        const el = elements.get(key);
        if (!el) continue;
        if (el.style.transform) {
          el.style.transition = `transform ${durationMs}ms cubic-bezier(0.4, 0, 0.2, 1)`;
          el.style.transform = "";
        }
      }
    });

    prevPositions.current = newPositions;
  }, [keys, elements, durationMs]);
}
```

- [ ] **Step 2: Modify `LiquidityLane.tsx` to consume the hook**

Open `app/web/src/components/liquidity/LiquidityLane.tsx`. Replace the entire file with:

```tsx
import { useMemo, useRef } from "react";
import LiquidityLaneRow from "./LiquidityLaneRow";
import { comparePeers } from "./transform";
import { useFlip } from "./useFlip";
import type { LiquidityPeer } from "./types";

type Props = {
  title: string;
  peers: LiquidityPeer[];
  selectedPubkey: string | null;
  pulseKey: number;
  rowRefs: Map<string, HTMLDivElement | null>;
};

export default function LiquidityLane({ title, peers, selectedPubkey, pulseKey, rowRefs }: Props) {
  const sorted = useMemo(() => [...peers].sort(comparePeers), [peers]);
  const localRefs = useRef<Map<string, HTMLElement | null>>(new Map());

  // FLIP animation when urgency order changes (e.g. on refresh).
  useFlip(sorted.map((p) => p.pubkey), localRefs.current);

  return (
    <div className="liq-lane panel ops fade-in">
      <div className="panel-header">
        <span className="panel-title">{title}</span>
        <span className="badge badge-muted">{sorted.length}</span>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {sorted.length === 0 ? (
          <div className="empty-state" style={{ padding: 16 }}>No peers in this role.</div>
        ) : (
          sorted.map((peer) => (
            <LiquidityLaneRow
              key={peer.pubkey}
              peer={peer}
              isSelected={peer.pubkey === selectedPubkey}
              pulseKey={pulseKey}
              ref={(el) => {
                rowRefs.set(peer.pubkey, el);
                localRefs.current.set(peer.pubkey, el);
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/components/liquidity/useFlip.ts app/web/src/components/liquidity/LiquidityLane.tsx
git commit -m "feat(web/liquidity): FLIP re-sort animation on refresh

useFlip hook (vanilla — no new deps): measures each row's bounding
rect on every render, primes the inverted transform when position
changes, then animates back to zero with a 500ms cubic-bezier transition.
Lanes consume it so the urgency-first reorder slides smoothly when
refresh changes a peer's tier (e.g. amber → green).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Pulse highlight on selection

Adds a CSS animation on the row's amber border when `pulseKey` bumps (i.e. user clicks/hovers a topology peer or the same peer is re-clicked).

**Files:**
- Modify: `app/web/src/components/liquidity/LiquidityLaneRow.tsx`
- Modify: `app/web/src/styles.css` (append keyframes)

- [ ] **Step 1: Modify the lane row to apply the pulse class on selection + pulse-key change**

Open `app/web/src/components/liquidity/LiquidityLaneRow.tsx`. Replace it entirely with:

```tsx
import { forwardRef, useEffect, useState } from "react";
import { HEALTH_COLOR, ROLE_COLOR, type LiquidityPeer } from "./types";
import { formatSatsShort } from "./transform";

type Props = {
  peer: LiquidityPeer;
  isSelected: boolean;
  pulseKey: number;
};

const LiquidityLaneRow = forwardRef<HTMLDivElement, Props>(({ peer, isSelected, pulseKey }, ref) => {
  const pct = peer.rolePct ?? 0;
  const pctInt = Math.round(pct * 100);
  const tierColor = HEALTH_COLOR[peer.healthTier];
  const roleColor = ROLE_COLOR[peer.role];
  const [pulseClass, setPulseClass] = useState("");

  // Trigger the pulse animation when this row becomes selected (or pulseKey bumps while selected).
  useEffect(() => {
    if (!isSelected) {
      setPulseClass("");
      return;
    }
    setPulseClass(""); // reset so re-applying re-triggers the keyframes
    const t = setTimeout(() => setPulseClass("is-pulsing"), 0);
    return () => clearTimeout(t);
  }, [isSelected, pulseKey]);

  return (
    <div
      ref={ref}
      className={`liq-lane-row${isSelected ? " is-selected" : ""}${pulseClass ? " " + pulseClass : ""}`}
      data-pubkey={peer.pubkey}
    >
      <span className="liq-lane-row-name" style={{ color: roleColor }}>
        {peer.name}
      </span>
      <span className="liq-lane-row-cap">{formatSatsShort(peer.capacity)}</span>
      <div className="liq-health-bar">
        <div
          className="liq-health-bar-fill"
          style={{
            width: `${pctInt}%`,
            background: tierColor,
          }}
        />
      </div>
      <span
        className="liq-health-chip"
        style={{
          color: tierColor,
          background: `color-mix(in srgb, ${tierColor} 20%, transparent)`,
        }}
      >
        {pctInt}%
      </span>
    </div>
  );
});

LiquidityLaneRow.displayName = "LiquidityLaneRow";

export default LiquidityLaneRow;
```

- [ ] **Step 2: Append pulse keyframes to `app/web/src/styles.css`**

Append at the end of the file:

```css

@keyframes liq-pulse {
  0%   { box-shadow: inset 0 0 0 0 transparent; }
  20%  { box-shadow: inset 0 0 0 2px var(--amber); }
  60%  { box-shadow: inset 0 0 0 2px var(--amber); }
  100% { box-shadow: inset 0 0 0 0 transparent; }
}

.liq-lane-row.is-pulsing {
  animation: liq-pulse 600ms cubic-bezier(0.4, 0, 0.2, 1);
}
```

- [ ] **Step 3: Build**

```bash
cd app/web && npm run build
```

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/components/liquidity/LiquidityLaneRow.tsx app/web/src/styles.css
git commit -m "feat(web/liquidity): selection pulse on topology click/hover

Lane row plays a 600ms amber inset-shadow pulse when the peer becomes
selected. pulseKey bump on each onSelect call retriggers the animation
even when re-selecting the same peer. The .is-pulsing class is applied
via setTimeout(_, 0) so React commits the empty-class first, then the
class re-application restarts the keyframes cleanly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Version bump

**Files:**
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

- [ ] **Step 1: Check current version**

```bash
grep -nE "^version:" bitcorn-lightning-node/umbrel-app.yml
```

Expected output: `version: "1.13.7"` (main is at v1.13.7 from PR #125 hide-dashboard-valuation-banner).

If anything else: STOP and report as NEEDS_CONTEXT — main has advanced unexpectedly.

Substitute `<NEW>` = `1.13.8`, `<OLD>` = `1.13.7`.

- [ ] **Step 2: Bump version in `umbrel-app.yml`**

Find:
```yaml
version: "1.13.7"
```
Replace with:
```yaml
version: "1.13.8"
```

- [ ] **Step 3: Prepend release-notes paragraph in `umbrel-app.yml`**

Find the `releaseNotes: >` block. The first paragraph currently starts with `v1.13.7: …`. Insert ABOVE it (preserving 2-space YAML indentation; do NOT delete the v1.13.7 paragraph):

```yaml
  v1.13.8: Liquidity page overhaul. Replaces the radial NetworkGraph
  with a role-aware layout: KPI banner up top (total deployed,
  merchants send-ready, farmers receive-ready), slim interactive
  topology beneath, then two role lanes (merchants by send capacity,
  farmers by receive capacity) sorted urgency-first. Hover or click a
  topology peer to scroll-and-pulse its lane row. Smooth FLIP animation
  when refresh changes the order. External / unclassified peers in a
  collapsible section below. No backend changes.
```

- [ ] **Step 4: Bump both image tags in `docker-compose.yml`**

Find:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/api:1.13.7
```
Replace with:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/api:1.13.8
```

Find:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/web:1.13.7
```
Replace with:
```yaml
    image: ghcr.io/ethancail/bitcorn-lightning-application/web:1.13.8
```

- [ ] **Step 5: Verify**

```bash
grep -nE "^version:|v1.13.8|api:1.13.|web:1.13." bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml | head -12
```

Expected: `version: "1.13.8"`, the new `v1.13.8:` release-notes line, and **no** remaining `api:1.13.7` or `web:1.13.7` image tags.

- [ ] **Step 6: Commit**

```bash
git add bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml
git commit -m "chore: bump to v1.13.8 for Liquidity page overhaul

Umbrel manifest + compose image tags bumped together. Release notes
for v1.13.8 prepended.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

## Report format for Task 10

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- `<OLD>` → `<NEW>` values used
- Grep verification output (verbatim)
- Commit SHA

---

### Task 11: Visual verification (human)

No code changes expected.

- [ ] **Step 1: Clean build**

```bash
cd app/web && npm run build
```

Expected: exit 0.

- [ ] **Step 2: Dev server + manual verification**

```bash
cd app/web && npm run dev
# or: VITE_API_BASE=http://<umbrel-ip>:3101 npm run dev
```

Open `/liquidity`. Check the spec's test plan:

- All 3 KPI cards render with correct counts
- Topology map shows all peers with correct role colors + health rings
- Hover a topology node → its lane row scrolls into view, pulses amber
- Click a topology node → row stays highlighted; clicking another peer moves the highlight
- Tab into the topology, arrow-key navigation moves the "focused" peer; Esc clears
- Merchants lane sorts red-first-amber-second-green-third, alphabetical tie-break
- Farmers lane same
- Refresh button triggers smooth re-sort + bar-width animation; no snap
- External & Unclassified section opens/closes on click
- Narrow viewport (<720px): KPI cards and lanes stack vertically; topology stays at top
- Theme toggle: all colors, chips, bars re-color correctly — no hardcoded hex bleeding through

Save before/after screenshots for the PR body (both themes, the `/liquidity` page).

- [ ] **Step 3: Fix any visual issues**

If something looks off, commit a `fix(web/liquidity): <what>` commit. If all good, skip to Task 12.

---

### Task 12: Push + open PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/ui-liquidity
```

- [ ] **Step 2: Open PR**

```bash
gh pr create --base main --title "feat(web/liquidity): role-aware page overhaul (v1.13.8)" --body "$(cat <<'EOF'
## Summary

Replaces the treasury \`/liquidity\` page (currently a 600px radial NetworkGraph) with a role-aware layout that surfaces health at a glance.

- **KPI banner** at the top — Total Deployed, Merchants Send-Ready, Farmers Receive-Ready
- **Slim interactive topology** (~200px tall) — hover or click a peer to scroll-and-pulse its lane row; arrow-key + Esc keyboard nav
- **Two role lanes** below — merchants sorted by send capacity, farmers sorted by receive capacity, urgency-first (red < 15% / amber 15–30% / green ≥ 30%)
- **External & Unclassified** collapsible section beneath
- **Manual refresh** with FLIP-animated re-sort and smooth bar-width transitions

Solves the existing NetworkGraph's role-inversion problem: today's \"fill from hub\" encoding means *opposite things* depending on whether the peer is a merchant or farmer. The new page surfaces role-specific metrics directly.

Spec: \`docs/superpowers/specs/2026-04-24-liquidity-page-overhaul-design.md\`
Plan: \`docs/superpowers/plans/2026-04-27-liquidity-page-overhaul-implementation.md\`

## Version

**v1.13.8** on top of main's v1.13.7.

## Files

- New: \`app/web/src/pages/Liquidity.tsx\` (replaces 2-line TODO stub)
- New: \`app/web/src/components/liquidity/\` (8 files: types, transform, useFlip hook, 5 components)
- Modified: \`app/web/src/App.tsx\` (route swap), \`app/web/src/styles.css\` (new \`.liq-*\` block)
- \`app/web/src/components/NetworkGraph.tsx\` is now unused but stays on disk — cleanup in a future PR

## Test plan

- [x] \`cd app/web && npm run build\` clean after every commit
- [x] Visual verification: KPI counts correct, topology hover/click/keyboard works, lanes urgency-sorted, refresh re-sort animates smoothly, external section opens/closes, narrow viewport stacks correctly, both themes cascade

## Screenshots

(attach: KPI banner + topology + lanes, both themes, on \`/liquidity\`)

## Post-merge

1. Wait for \`Build and publish Docker images\` workflow (~5 min).
2. On Umbrel: \`cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0 && git pull\`
3. Hard-refresh Umbrel browser UI — v1.13.8 update prompt appears.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report PR URL**

The output of `gh pr create` includes the PR URL.

---

## Post-merge checklist (reference, not steps)

- Wait for GitHub Actions `Build and publish Docker images` workflow ✅ (~5 min).
- On the Umbrel host:
  ```bash
  cd ~/umbrel/app-stores/ethancail-bitcorn-lightning-application-github-020f9ee0
  git pull
  ```
- Hard-refresh the Umbrel UI — Update button appears on the BitCorn Lightning tile.

---

## Self-review notes

- **Spec coverage:** Every section of the spec maps to a task. KPI banner = T2. Topology = T5. Lanes (with sorting) = T3+T4. External section = T6. Page assembly + route swap = T7. Refresh button + manual re-fetch = T7. FLIP animation = T8. Pulse highlight = T9. Thresholds + colors = T1 (constants) consumed by T3+T5. Quality bar (smooth/fluid) is enforced via T8 (FLIP), T9 (pulse), and bar `transition: width 0.4s` in T3.
- **Type consistency:** `LiquidityPeer` shape defined once in T1; every component imports from `./types` (or `./transform` for re-exports). `ChannelData` lives in `transform.ts` because it's a wire shape used only by `buildLiquidityPeers`. `pulseKey: number` is consistent across page → lane → row.
- **Placeholder check:** Searched the plan for TBD/TODO/"as needed"/"similar to" — only `// TODO` reference is in T0 preflight notes describing the existing 2-line stub being replaced. No real placeholders.
- **`localCompare` vs `localeCompare`:** Used `localeCompare` (correct API name) in `comparePeers` for alphabetical tie-break.
- **Tier-color mismatch risk:** The spec flags the role-color ring vs. health-color ring potential conflict. T5 resolves it: ring color = health tier, fill color = role color. Distinct semantics, no overlap.
- **FLIP edge case:** `useFlip` ignores keys without elements (multi-render race). On first render, `prevPositions` is empty so no animation fires (correct — nothing to compare to).
- **Pulse re-trigger:** T9 uses `setPulseClass("")` then `setTimeout(setPulseClass("is-pulsing"), 0)` to force a class-removal between selections so React commits two state changes back-to-back, restarting the keyframes.
- **Refresh button position:** Lives in `.liq-page-header`, top-right next to the page title, matching the pattern used by the Treasury Dashboard's net-24h hero row.
- **No new tokens needed:** All colors/spacing pulled from existing CSS vars. No risk of token drift.
- **No tests added:** Project has no automated test suite (per CLAUDE.md). Verification = build + manual visual.
- **Commits per task:** 9 code commits + 1 chore + 0 fix (assuming visual verification clean) = 10 commits on the branch, plus the spec commit. Slightly larger than the 7 polish PRs (~5–6 each) but the scope is meaningfully larger.
