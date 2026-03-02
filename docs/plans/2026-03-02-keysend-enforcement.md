# Keysend Enforcement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce keysend support across member nodes — block setup if disabled, detect failures at runtime, alert both treasury and member dashboards.

**Architecture:** Pre-flight check in ConnectToHub form via new `/api/node/preflight` endpoint. Failure-based tracking on treasury side via `member_keysend_status` table. Auto-rebalancer skips known-disabled peers for 24h. Member dashboard shows non-dismissible banner when keysend is off.

**Tech Stack:** TypeScript, ln-service (getWalletInfo features), SQLite, React

---

### Task 1: Extend WalletInfo type + add isKeysendEnabled()

**Files:**
- Modify: `app/api/src/types/ln-service.d.ts:17-27`
- Modify: `app/api/src/lightning/lnd.ts`

**Step 1: Add `features` to WalletInfo interface**

In `app/api/src/types/ln-service.d.ts`, update the `WalletInfo` interface:

```typescript
export interface WalletInfo {
  public_key?: string;
  alias?: string;
  version?: string;
  active_channels_count?: number;
  peers_count?: number;
  current_block_height?: number;
  block_hash?: string;
  is_synced_to_chain?: boolean;
  is_synced_to_graph?: boolean;
  features?: Array<{
    bit: number;
    is_known: boolean;
    is_required: boolean;
    type: string;
  }>;
}
```

**Step 2: Add `isKeysendEnabled()` to lnd.ts**

After the `getLndInfo()` function (~line 117), add:

```typescript
/**
 * Check if the local LND node has keysend enabled by inspecting
 * feature bit 55 in the getWalletInfo response.
 * Returns true if accept-keysend=true is set in LND config.
 * Falls back to false if features field is absent.
 */
export async function isKeysendEnabled(): Promise<boolean> {
  const { lnd } = getLndClient();
  const info = await getWalletInfo({ lnd });
  if (!info.features || !Array.isArray(info.features)) return false;
  const keysendBit = info.features.find((f) => f.bit === 55);
  return !!keysendBit?.is_known;
}
```

**Step 3: Commit**

```bash
git add app/api/src/types/ln-service.d.ts app/api/src/lightning/lnd.ts
git commit -m "feat: add isKeysendEnabled() utility for feature bit 55 detection"
```

---

### Task 2: Create member_keysend_status migration

**Files:**
- Create: `app/api/src/db/migrations/021_member_keysend_status.sql`

**Step 1: Write the migration**

```sql
-- Track member nodes with keysend disabled (detected via rebalance failure)
CREATE TABLE IF NOT EXISTS member_keysend_status (
  peer_pubkey TEXT PRIMARY KEY,
  keysend_disabled INTEGER NOT NULL DEFAULT 0,
  last_failure_at INTEGER,
  last_checked_at INTEGER,
  failure_message TEXT
);
```

**Step 2: Commit**

```bash
git add app/api/src/db/migrations/021_member_keysend_status.sql
git commit -m "feat: add migration 021 for member_keysend_status table"
```

---

### Task 3: Add failure tracking + skip logic in rebalance-keysend.ts

**Files:**
- Modify: `app/api/src/lightning/rebalance-keysend.ts`

**Step 1: Add db import and keysend-disabled detection in executeKeysendRebalance()**

Add `import { db } from "../db";` at the top (after existing imports).

In the `catch` block of `executeKeysendRebalance()` (currently lines 126-139), add keysend-disabled detection and success clearing:

Replace the existing catch block:

```typescript
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
```

With:

```typescript
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    updateRebalanceExecution(execId, "failed", null, null, msg);

    // Detect keysend-disabled specifically
    if (msg.includes("PaymentRejectedByDestination") || msg.includes("rejected by destination")) {
      db.prepare(
        `INSERT INTO member_keysend_status (peer_pubkey, keysend_disabled, last_failure_at, failure_message)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(peer_pubkey) DO UPDATE SET
           keysend_disabled = 1, last_failure_at = excluded.last_failure_at, failure_message = excluded.failure_message`
      ).run(channel.partner_public_key, Date.now(), msg);
    }

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
```

Also in the success path (after `insertRebalanceCost`), add auto-clear logic:

```typescript
    // Clear keysend-disabled flag on success (peer may have re-enabled)
    db.prepare(
      `UPDATE member_keysend_status SET keysend_disabled = 0, last_checked_at = ? WHERE peer_pubkey = ?`
    ).run(Date.now(), channel.partner_public_key);
```

**Step 2: Add skip logic in autoKeysendRebalance()**

Inside the `for (const ch of criticalChannels)` loop, before the push amount calculation, add:

```typescript
    // Skip peers with keysend disabled within last 24 hours
    const keysendStatus = db.prepare(
      `SELECT keysend_disabled, last_failure_at FROM member_keysend_status WHERE peer_pubkey = ?`
    ).get(ch.peer_pubkey) as { keysend_disabled: number; last_failure_at: number } | undefined;

    if (keysendStatus?.keysend_disabled && (Date.now() - keysendStatus.last_failure_at) < 86_400_000) {
      results.push({
        channel_id: ch.channel_id,
        peer_pubkey: ch.peer_pubkey,
        amount_sats: 0,
        fee_paid_sats: 0,
        payment_hash: "",
        status: "failed",
        error: "Skipped — peer has keysend disabled. Will retry in 24h.",
      });
      continue;
    }
```

**Step 3: Commit**

```bash
git add app/api/src/lightning/rebalance-keysend.ts
git commit -m "feat: track keysend-disabled peers and skip in auto-rebalance"
```

---

### Task 4: Add MEMBER_KEYSEND_DISABLED alert

**Files:**
- Modify: `app/api/src/api/treasury-alerts.ts`

**Step 1: Add the alert**

After the keysend rebalance available alert block (before `return alerts;`), add:

```typescript
  // --- Member keysend disabled ---
  const keysendDisabled = db.prepare(
    `SELECT peer_pubkey, last_failure_at FROM member_keysend_status WHERE keysend_disabled = 1`
  ).all() as Array<{ peer_pubkey: string; last_failure_at: number }>;

  if (keysendDisabled.length > 0) {
    alerts.push({
      type: "MEMBER_KEYSEND_DISABLED",
      severity: "warning",
      message: `${keysendDisabled.length} member node(s) have keysend disabled and cannot be auto-rebalanced`,
      data: {
        count: keysendDisabled.length,
        peers: keysendDisabled.map((p) => ({
          peer_pubkey: p.peer_pubkey,
          last_failure_at: p.last_failure_at,
        })),
      },
      at: now,
    });
  }
```

**Step 2: Commit**

```bash
git add app/api/src/api/treasury-alerts.ts
git commit -m "feat: add MEMBER_KEYSEND_DISABLED treasury alert"
```

---

### Task 5: Add /api/node/preflight endpoint + keysend_enabled to /api/member/stats

**Files:**
- Modify: `app/api/src/index.ts`

**Step 1: Add GET /api/node/preflight endpoint**

Add this new endpoint BEFORE the existing `/api/member/stats` handler. Import `isKeysendEnabled` from `./lightning/lnd` (add to existing import).

```typescript
  if (req.method === "GET" && req.url === "/api/node/preflight") {
    try {
      const keysendEnabled = await isKeysendEnabled();

      const checks = [
        {
          check: "keysend_enabled",
          passed: keysendEnabled,
          message: keysendEnabled
            ? "Keysend payments are enabled"
            : 'Keysend is not enabled. Go to Umbrel → Lightning → Settings → Enable "Receive Keysend Payments" → Restart LND, then retry.',
          required: true,
        },
      ];

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ checks, all_passed: checks.every((c) => c.passed) }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message ?? "preflight_check_failed" }));
    }
    return;
  }
```

**Step 2: Add keysend_enabled to /api/member/stats**

In the existing `/api/member/stats` handler, after the `isPeeredToHub` check block, add:

```typescript
      let keysendEnabled = false;
      try {
        keysendEnabled = await isKeysendEnabled();
      } catch {
        // non-fatal — keysend check best-effort
      }
```

And add `keysend_enabled: keysendEnabled` to the `result` object (after `is_peered_to_hub`):

```typescript
      const result = {
        hub_pubkey: hubPubkey || null,
        membership_status: node?.membership_status ?? "unsynced",
        node_role: node?.node_role ?? "external",
        is_peered_to_hub: isPeeredToHub,
        keysend_enabled: keysendEnabled,
        treasury_channel: treasuryChannel
        // ... rest unchanged
```

**Step 3: Commit**

```bash
git add app/api/src/index.ts
git commit -m "feat: add /api/node/preflight endpoint and keysend_enabled to member stats"
```

---

### Task 6: Add frontend types + API methods

**Files:**
- Modify: `app/web/src/api/client.ts`

**Step 1: Add PreflightCheck type and API method**

After the `MemberStats` type, add:

```typescript
export type PreflightCheck = {
  check: string;
  passed: boolean;
  message: string;
  required: boolean;
};

export type PreflightResult = {
  checks: PreflightCheck[];
  all_passed: boolean;
};
```

Add `keysend_enabled: boolean;` to the existing `MemberStats` type (after `is_peered_to_hub`):

```typescript
export type MemberStats = {
  hub_pubkey: string | null;
  membership_status: string;
  node_role: string;
  is_peered_to_hub: boolean;
  keysend_enabled: boolean;
  // ... rest unchanged
```

Add to the `api` object:

```typescript
  getNodePreflight: () => apiFetch<PreflightResult>("/api/node/preflight"),
```

**Step 2: Commit**

```bash
git add app/web/src/api/client.ts
git commit -m "feat: add preflight types and keysend_enabled to MemberStats"
```

---

### Task 7: Add preflight check to ConnectToHub + keysend warning banner to MemberDashboard

**Files:**
- Modify: `app/web/src/pages/MemberDashboard.tsx`

**Step 1: Update imports**

Change the import to include `PreflightResult`:

```typescript
import { api, type MemberStats, type PreflightResult } from "../api/client";
```

**Step 2: Add preflight check to ConnectToHub**

In the `ConnectToHub` component, add preflight state and fetch:

```typescript
function ConnectToHub({ isPeered }: { isPeered: boolean }) {
  const [capacity, setCapacity] = useState(1_000_000);
  const [socket, setSocket] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(true);

  useEffect(() => {
    api.getNodePreflight()
      .then(setPreflight)
      .catch(() => setPreflight(null))
      .finally(() => setPreflightLoading(false));
  }, []);

  function retryPreflight() {
    setPreflightLoading(true);
    api.getNodePreflight()
      .then(setPreflight)
      .catch(() => setPreflight(null))
      .finally(() => setPreflightLoading(false));
  }
```

After the info alert ("No hub channel") and before the "Open channel form" div, add the preflight warning:

```tsx
      {/* Preflight warning */}
      {!preflightLoading && preflight && !preflight.all_passed && (
        <div className="alert warning" style={{ marginBottom: 0 }}>
          <span className="alert-icon">⚠</span>
          <div className="alert-body">
            <div className="alert-type">Configuration Required</div>
            {preflight.checks
              .filter((c) => !c.passed)
              .map((c) => (
                <div key={c.check} className="alert-msg">{c.message}</div>
              ))}
            <button
              className="btn btn-outline"
              style={{ marginTop: 8 }}
              onClick={retryPreflight}
              disabled={preflightLoading}
            >
              {preflightLoading ? "Checking…" : "Retry Check"}
            </button>
          </div>
        </div>
      )}
```

Update the "Open Channel" button to be disabled when preflight fails:

```tsx
        <button
          className="btn btn-primary"
          onClick={handleOpen}
          disabled={submitting || capacity < 100_000 || preflightLoading || (preflight != null && !preflight.all_passed)}
        >
          {submitting ? "Opening…" : "Open Channel →"}
        </button>
```

**Step 3: Add keysend warning banner to MemberDashboard**

In the `MemberDashboard` component, after `<BitcoinPriceGraph />` and before the membership status panel, add:

```tsx
      {/* Keysend disabled warning */}
      {!loading && stats && stats.keysend_enabled === false && (
        <div className="alert warning" style={{ marginBottom: 16 }}>
          <span className="alert-icon">⚠</span>
          <div className="alert-body">
            <div className="alert-type">Keysend Payments Disabled</div>
            <div className="alert-msg">
              Your node cannot receive rebalancing payments from the treasury.
              Enable "Receive Keysend Payments" in Umbrel → Lightning → Settings, then restart LND.
            </div>
          </div>
        </div>
      )}
```

**Step 4: Commit**

```bash
git add app/web/src/pages/MemberDashboard.tsx
git commit -m "feat: add preflight keysend check and dashboard warning banner"
```

---

### Task 8: Update CLAUDE.md + version bump

**Files:**
- Modify: `CLAUDE.md`
- Modify: `bitcorn-lightning-node/umbrel-app.yml`
- Modify: `bitcorn-lightning-node/docker-compose.yml`

**Step 1: Update CLAUDE.md**

Add `member_keysend_status` to the Key tables list in the Database section:

```
Key tables: ..., `contacts`, `member_keysend_status`.
```

Add to Current Capabilities (append to the end of the capabilities list):

```
keysend enforcement (pre-flight check in member ConnectToHub form, runtime failure tracking with 24h retry, MEMBER_KEYSEND_DISABLED treasury alert, member dashboard keysend warning banner).
```

Add `/api/node/preflight` to the Public endpoints in Role-Based Access Control:

```
- **Public**: `/health`, `/api/node`, `/api/node/balances`, `/api/node/preflight`, ...
```

In the Liquidity Management section, after the keysend push rebalance paragraph, add:

```
Keysend enforcement: member pre-flight check via `GET /api/node/preflight` inspects feature bit 55 — blocks channel open if keysend disabled. Runtime: `member_keysend_status` table tracks peers that reject keysend; auto-rebalancer skips disabled peers for 24h then retries. `MEMBER_KEYSEND_DISABLED` alert (warning severity) shows on treasury dashboard. Member dashboard shows non-dismissible banner when keysend is off.
```

**Step 2: Bump version to 1.3.3**

In `umbrel-app.yml`: change `version: "1.3.2"` to `version: "1.3.3"` and update `releaseNotes`.

In `docker-compose.yml`: change both image tags from `1.3.2` to `1.3.3`.

**Step 3: Commit**

```bash
git add CLAUDE.md bitcorn-lightning-node/umbrel-app.yml bitcorn-lightning-node/docker-compose.yml
git commit -m "chore: update docs, bump version to 1.3.3 for keysend enforcement"
```

---

## Task Dependency Graph

```
Task 1 (types + isKeysendEnabled)
  ├─→ Task 2 (migration) — independent
  ├─→ Task 3 (rebalance tracking) — depends on Task 1, 2
  ├─→ Task 4 (alert) — depends on Task 2
  ├─→ Task 5 (API endpoints) — depends on Task 1
  └─→ Task 6 (frontend types) — depends on Task 5
       └─→ Task 7 (frontend UI) — depends on Task 6
            └─→ Task 8 (docs + version) — depends on all
```

Parallelizable pairs: Task 1 + Task 2, Task 4 + Task 5 (after Task 2 completes).
