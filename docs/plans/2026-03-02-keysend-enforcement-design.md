# Keysend Enforcement for Member Nodes — Design

**Date:** 2026-03-02
**Branch:** `feature/keysend-member-enforcement` from `develop`
**Version:** 1.3.2 → 1.3.3

## Problem

Keysend push rebalancing (v1.3.1) requires member nodes to have `accept-keysend=true` in LND config. If a member doesn't have this enabled, keysend pushes fail with `PaymentRejectedByDestination` and the channel cannot be auto-rebalanced. There is no detection, warning, or enforcement — the treasury silently fails and the member is unaware.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Pre-flight location | Existing ConnectToHub form | No member wizard exists; adding check to existing flow avoids new infrastructure |
| Feature detection | Extend `getWalletInfo` types + runtime check | ln-service likely returns features from LND GetInfo; type declaration is just incomplete |
| Treasury-side tracking | Failure-based only | Simple, reliable, no extra gossip API calls; 24h retry window handles re-enablement |
| Persistence | Separate `member_keysend_status` table | `lnd_channels` is rebuilt every 15s by sync; separate table persists across syncs |

## Architecture

### 1. Keysend Detection Utility (`lnd.ts`)

Add `features` field to `WalletInfo` type in `ln-service.d.ts`:

```typescript
features?: Array<{
  bit: number;
  is_known: boolean;
  is_required: boolean;
  type: string;
}>;
```

New function in `lnd.ts`:

```typescript
export async function isKeysendEnabled(): Promise<boolean> {
  const { lnd } = getLndClient();
  const info = await getWalletInfo({ lnd });
  if (!info.features || !Array.isArray(info.features)) return false;
  const keysendBit = info.features.find((f: any) => f.bit === 55);
  return !!keysendBit?.is_known;
}
```

Checks **local** node's own feature bit 55. Used by member-side preflight and dashboard.

### 2. Pre-flight Check (ConnectToHub flow)

**New endpoint: `GET /api/node/preflight`**

Returns an array of checks:

```typescript
{
  checks: [
    {
      check: "keysend_enabled",
      passed: boolean,
      message: string,
      required: true
    }
  ],
  all_passed: boolean
}
```

Extensible for future checks (sync status, LND version, etc.).

**Frontend integration in `ConnectToHub` (MemberDashboard.tsx):**

- Calls `/api/node/preflight` on mount
- If keysend check fails:
  - Show warning banner with Umbrel instructions (Lightning → Settings → Enable "Receive Keysend Payments" → Restart LND)
  - Disable "Open Channel" button
  - Show "Retry Check" button that re-calls preflight
- If keysend check passes: normal flow, "Open Channel" enabled

### 3. Runtime Detection — Treasury Side

**New migration `021_member_keysend_status.sql`:**

```sql
CREATE TABLE IF NOT EXISTS member_keysend_status (
  peer_pubkey TEXT PRIMARY KEY,
  keysend_disabled INTEGER DEFAULT 0,
  last_failure_at INTEGER,
  last_checked_at INTEGER,
  failure_message TEXT
);
```

**`executeKeysendRebalance()` changes:**

On catch: detect `PaymentRejectedByDestination` → insert/update `member_keysend_status` with `keysend_disabled = 1`.

On success: update `member_keysend_status` with `keysend_disabled = 0`, `last_checked_at = now`.

**`autoKeysendRebalance()` changes:**

Before attempting each channel, check `member_keysend_status`. Skip peers with `keysend_disabled = 1` AND `last_failure_at` within 24 hours. After 24h, retry (in case member re-enabled keysend).

**New alert `MEMBER_KEYSEND_DISABLED` in `treasury-alerts.ts`:**

```typescript
{
  type: "MEMBER_KEYSEND_DISABLED",
  severity: "warning",
  message: `${count} member node(s) have keysend disabled`,
  data: {
    count,
    peers: [{ peer_pubkey, last_failure_at }]
  },
  at: now
}
```

### 4. Runtime Detection — Member Side

Add `keysend_enabled: boolean` to `/api/member/stats` response. Populated by calling `isKeysendEnabled()` on the member's own node.

In `MemberDashboard.tsx`: if `stats.keysend_enabled === false`, render non-dismissible warning banner above NodeBalancePanel with enable instructions.

### 5. Auto-clear on Success

When `executeKeysendRebalance()` succeeds for a previously-disabled peer, the status row is updated to `keysend_disabled = 0`. The 24h retry window in `autoKeysendRebalance()` ensures this happens naturally.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/types/ln-service.d.ts` | Modify | Add `features` to `WalletInfo` |
| `src/lightning/lnd.ts` | Modify | Add `isKeysendEnabled()` |
| `src/db/migrations/021_member_keysend_status.sql` | Create | New table |
| `src/index.ts` | Modify | Add `GET /api/node/preflight`, update `/api/member/stats` |
| `src/lightning/rebalance-keysend.ts` | Modify | Failure tracking + skip logic + success clearing |
| `src/api/treasury-alerts.ts` | Modify | Add `MEMBER_KEYSEND_DISABLED` alert |
| `app/web/src/api/client.ts` | Modify | Add preflight types + API method, add `keysend_enabled` to `MemberStats` |
| `app/web/src/pages/MemberDashboard.tsx` | Modify | Preflight check in ConnectToHub, keysend warning banner |
| `CLAUDE.md` | Modify | Document new table, endpoint, alert |
| `bitcorn-lightning-node/umbrel-app.yml` | Modify | Version bump |
| `bitcorn-lightning-node/docker-compose.yml` | Modify | Version bump |
