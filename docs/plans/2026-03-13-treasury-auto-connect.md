# Treasury Auto-Connect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let members connect to the treasury hub with one click instead of manually entering a Tor address.

**Architecture:** Cloudflare Worker stores treasury pubkey + socket as env vars, serves them via `GET /treasury-info`. Member API proxies this. Frontend fetches on mount and pre-fills the connection, replacing the manual text input with a single "Connect to Treasury" button. Falls back to manual input if Worker is unreachable.

**Tech Stack:** Cloudflare Worker (existing), raw HTTP API (`index.ts`), React frontend (`MemberDashboard.tsx`)

**Design doc:** `docs/plans/2026-03-13-treasury-auto-connect-design.md`

---

### Task 1: Add `GET /treasury-info` to Cloudflare Worker

**Files:**
- Modify: `cloudflare-worker/src/index.ts`

**Step 1: Add env vars to `Env` interface**

In `cloudflare-worker/src/index.ts`, find the `Env` interface (line ~62) and add two optional fields:

```typescript
interface Env {
  CDP_KEY_NAME: string;
  CDP_PRIVATE_KEY: string;
  USDA_NASS_KEY: string;
  GOLD_API_KEY: string;
  PRICES_CACHE: KVNamespace;
  TREASURY_PUBKEY?: string;   // add
  TREASURY_SOCKET?: string;   // add
}
```

They're optional (`?`) so the Worker still deploys and runs if they're not set yet.

**Step 2: Add the `/treasury-info` route handler**

In the router `fetch()` function (line ~332), add a new route **before** the `GET /prices` route:

```typescript
    // GET /treasury-info — treasury node connection info for member auto-connect
    if (request.method === "GET" && url.pathname === "/treasury-info") {
      const pubkey = env.TREASURY_PUBKEY || null;
      const socket = env.TREASURY_SOCKET || null;
      return Response.json({ pubkey, socket }, { headers: CORS_HEADERS });
    }
```

**Step 3: Verify locally**

Run: `cd cloudflare-worker && npx wrangler dev`
Test: `curl http://localhost:8787/treasury-info`
Expected: `{"pubkey":null,"socket":null}` (secrets not set locally — that's fine)

**Step 4: Deploy and set secrets**

```bash
cd cloudflare-worker
npx wrangler deploy
npx wrangler secret put TREASURY_PUBKEY
# paste: 02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca
npx wrangler secret put TREASURY_SOCKET
# paste: prao2yfb6zmdv4mtc7zumiikla3jah3irrzgs6bilhz2rsp3wgl64cad.onion:9735
```

Test live: `curl https://bitcorn-onramp.ethancail.workers.dev/treasury-info`
Expected: `{"pubkey":"02b759b...","socket":"prao2y...onion:9735"}`

**Step 5: Commit**

```bash
git add cloudflare-worker/src/index.ts
git commit -m "feat: add GET /treasury-info endpoint to Cloudflare Worker"
```

---

### Task 2: Add `GET /api/treasury-info` proxy to API

**Files:**
- Modify: `app/api/src/index.ts` (insert after the `/api/corn-history` block, ~line 250)

**Step 1: Add the proxy route**

Insert this block immediately after the `/api/corn-history` handler (after line 250, before the `/api/peers` handler):

```typescript
  // Public — treasury connection info proxied from Cloudflare Worker
  if (req.method === "GET" && req.url === "/api/treasury-info") {
    try {
      const workerUrl = ENV.coinbaseWorkerUrl;
      if (!workerUrl) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "worker_not_configured" }));
        return;
      }
      const response = await fetch(`${workerUrl}/treasury-info`);
      if (!response.ok) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "treasury_info_unavailable" }));
        return;
      }
      const data = await response.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[treasury-info]", err);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "treasury_info_unavailable" }));
    }
    return;
  }
```

This follows the exact same pattern as `/api/commodity-prices` and `/api/corn-history`.

**Step 2: Build**

Run: `cd app/api && npm run build`
Expected: Clean compile, no errors.

**Step 3: Commit**

```bash
git add app/api/src/index.ts
git commit -m "feat: add GET /api/treasury-info proxy route"
```

---

### Task 3: Add `api.getTreasuryInfo()` to frontend client

**Files:**
- Modify: `app/web/src/api/client.ts`

**Step 1: Add the type**

Find the types section near the top of `client.ts`. Add:

```typescript
export type TreasuryInfo = {
  pubkey: string | null;
  socket: string | null;
};
```

**Step 2: Add the api method**

Find the `api` object (line ~26). Add after `getCornHistory`:

```typescript
  getTreasuryInfo: () => apiFetch<TreasuryInfo>("/api/treasury-info"),
```

**Step 3: Build**

Run: `cd app/web && npm run build`
Expected: Clean compile.

**Step 4: Commit**

```bash
git add app/web/src/api/client.ts
git commit -m "feat: add getTreasuryInfo API client method"
```

---

### Task 4: Rewrite ConnectToHub for one-click auto-connect

**Files:**
- Modify: `app/web/src/pages/MemberDashboard.tsx`

**Step 1: Add TreasuryInfo import**

At the top of `MemberDashboard.tsx`, update the import from `client.ts`:

```typescript
import { api, type MemberStats, type PreflightResult, type TreasuryInfo } from "../api/client";
```

**Step 2: Rewrite the ConnectToHub component**

Replace the `ConnectToHub` function (lines 30-283) with the updated version. Key changes:

1. **New state:** `treasuryInfo` and `treasuryInfoLoading` for the Worker fetch
2. **New `useEffect`:** fetch `api.getTreasuryInfo()` on mount
3. **When NOT peered + socket available:** Show "Connect to Treasury" button (no manual input). The button calls `handleOpen()` with the fetched socket pre-filled.
4. **When NOT peered + socket unavailable:** Fall back to the manual "Hub Address" text input (existing behavior).
5. **When peered:** Same green banner as before.
6. **Remove** the hardcoded `HUB_PUBKEY` constant at the top — use `treasuryInfo.pubkey` instead (with `HUB_PUBKEY` as fallback for backward compat).

The full replacement for `ConnectToHub`:

```tsx
function ConnectToHub({ isPeered }: { isPeered: boolean }) {
  const [capacity, setCapacity] = useState(1_000_000);
  const [socket, setSocket] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(true);
  const [treasuryInfo, setTreasuryInfo] = useState<TreasuryInfo | null>(null);
  const [treasuryInfoLoading, setTreasuryInfoLoading] = useState(true);

  useEffect(() => {
    api.getNodePreflight()
      .then(setPreflight)
      .catch(() => setPreflight(null))
      .finally(() => setPreflightLoading(false));
  }, []);

  useEffect(() => {
    api.getTreasuryInfo()
      .then(setTreasuryInfo)
      .catch(() => setTreasuryInfo(null))
      .finally(() => setTreasuryInfoLoading(false));
  }, []);

  function retryPreflight() {
    setPreflightLoading(true);
    api.getNodePreflight()
      .then(setPreflight)
      .catch(() => setPreflight(null))
      .finally(() => setPreflightLoading(false));
  }

  const hubPubkey = treasuryInfo?.pubkey || HUB_PUBKEY;
  const hubSocket = treasuryInfo?.socket || null;
  const hasAutoSocket = !!hubSocket;

  async function handleOpen() {
    setSubmitting(true);
    setError(null);
    try {
      const partnerSocket = hasAutoSocket && !isPeered ? hubSocket : socket.trim() || undefined;
      const res = await api.openMemberChannel({
        capacity_sats: capacity,
        partner_socket: partnerSocket || undefined,
      });
      setSuccess(res.funding_txid ?? "submitted");
    } catch (e: any) {
      setError(e.message ?? "Failed to open channel");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="alert healthy">
          <span className="alert-icon">✓</span>
          <div className="alert-body">
            <div className="alert-type">Channel opening submitted</div>
            <div className="alert-msg">
              Your channel to the hub is being broadcast. It will become active after
              1–3 on-chain confirmations. This page will update automatically.
            </div>
          </div>
        </div>
        {success !== "submitted" && (
          <div>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 6,
              }}
            >
              Funding Transaction
            </div>
            <div
              style={{
                background: "var(--bg-3)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "8px 12px",
                fontFamily: "var(--mono)",
                fontSize: "0.75rem",
                wordBreak: "break-all",
                color: "var(--text-1)",
              }}
            >
              {success}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Info alert */}
      <div className="alert info" style={{ marginBottom: 0 }}>
        <span className="alert-icon">◈</span>
        <div className="alert-body">
          <div className="alert-type">No hub channel</div>
          <div className="alert-msg">
            Open a channel to the hub to start routing payments and earning forwarding fees.
          </div>
        </div>
      </div>

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

      {/* Open channel form */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label className="form-label">Channel Capacity</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            {CAPACITY_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`btn ${capacity === p.value ? "btn-primary" : "btn-outline"}`}
                onClick={() => setCapacity(p.value)}
                style={{ flex: 1 }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            className="form-input"
            type="number"
            value={capacity}
            min={100_000}
            onChange={(e) => setCapacity(Math.max(100_000, Number(e.target.value)))}
          />
          <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
            Recommended: 500k–2M sats. Minimum: 100,000 sats.
          </div>
        </div>

        {/* Peering section */}
        {isPeered ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              background: "color-mix(in srgb, var(--green) 10%, var(--bg-2))",
              border: "1px solid color-mix(in srgb, var(--green) 30%, transparent)",
              borderRadius: 6,
              fontSize: "0.8125rem",
              color: "var(--green)",
            }}
          >
            <span>✓</span>
            <span>Already connected to hub via gossip — no address needed</span>
          </div>
        ) : hasAutoSocket ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              background: "color-mix(in srgb, var(--amber) 10%, var(--bg-2))",
              border: "1px solid color-mix(in srgb, var(--amber) 30%, transparent)",
              borderRadius: 6,
              fontSize: "0.8125rem",
              color: "var(--amber)",
            }}
          >
            <span>◈</span>
            <span>Treasury address found — will connect automatically</span>
          </div>
        ) : treasuryInfoLoading ? (
          <div className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />
        ) : (
          <div>
            <label className="form-label">
              Hub Address{" "}
              <span style={{ color: "var(--text-3)", fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              className="form-input"
              type="text"
              placeholder="host:port — only needed if not already peered"
              value={socket}
              onChange={(e) => setSocket(e.target.value)}
            />
            <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
              Leave blank if your node is already connected to the hub via gossip.
            </div>
          </div>
        )}

        {error && (
          <div className="alert critical">
            <span className="alert-icon">✕</span>
            <div className="alert-body">
              <div className="alert-msg">{error}</div>
            </div>
          </div>
        )}

        <button
          className="btn btn-primary"
          onClick={handleOpen}
          disabled={submitting || capacity < 100_000 || preflightLoading || (preflight != null && !preflight.all_passed)}
        >
          {submitting ? "Connecting…" : isPeered || hasAutoSocket ? "Open Channel →" : "Open Channel →"}
        </button>
      </div>

      {/* Hub pubkey for reference */}
      <div
        style={{
          borderTop: "1px solid var(--border)",
          paddingTop: 16,
        }}
      >
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: 8,
          }}
        >
          Hub Public Key
        </div>
        <div
          style={{
            background: "var(--bg-3)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 12px",
            fontFamily: "var(--mono)",
            fontSize: "0.75rem",
            wordBreak: "break-all",
            color: "var(--text-1)",
            lineHeight: 1.6,
          }}
        >
          {hubPubkey}
        </div>
      </div>
    </div>
  );
}
```

Key behavioral changes:
- `HUB_PUBKEY` constant stays as fallback, but `hubPubkey` now prefers Worker value
- When `hasAutoSocket` is true and NOT peered: amber banner "Treasury address found — will connect automatically" + button uses the auto socket
- When `hasAutoSocket` is false and NOT peered: falls back to manual text input (existing behavior)
- The "Copy" button for the pubkey is removed (it was confusing in the old flow — the pubkey is still displayed for reference)

**Step 3: Build**

Run: `cd app/web && npm run build`
Expected: Clean compile.

**Step 4: Test the UI locally**

Run: `cd app/web && npm run dev`
Open in browser. Since the local API won't have the Worker URL, you should see the **fallback** manual input (existing behavior). This confirms graceful degradation works.

**Step 5: Commit**

```bash
git add app/web/src/pages/MemberDashboard.tsx
git commit -m "feat: one-click treasury auto-connect via Cloudflare Worker rendezvous"
```

---

### Task 5: Build, deploy, and verify end-to-end

**Step 1: Final builds**

```bash
cd app/api && npm run build
cd ../web && npm run build
```

Both must pass clean.

**Step 2: Push to remote**

```bash
git push origin main
```

**Step 3: Deploy Worker with secrets**

```bash
cd cloudflare-worker
npx wrangler deploy
npx wrangler secret put TREASURY_PUBKEY
# paste: 02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca
npx wrangler secret put TREASURY_SOCKET
# paste: prao2yfb6zmdv4mtc7zumiikla3jah3irrzgs6bilhz2rsp3wgl64cad.onion:9735
```

Test: `curl https://bitcorn-onramp.ethancail.workers.dev/treasury-info`
Expected: `{"pubkey":"02b759b...","socket":"prao2y...onion:9735"}`

**Step 4: Update Umbrel app**

```bash
sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/api:1.5.3
sudo docker pull ghcr.io/ethancail/bitcorn-lightning-application/web:1.5.3
sudo umbreld client apps.restart.mutate --appId bitcorn-lightning-node
```

**Step 5: Verify on member node**

On a member node without a treasury channel:
1. Open the BitCorn app in browser
2. Should see amber banner "Treasury address found — will connect automatically"
3. Pick capacity, click "Open Channel →"
4. Should peer + open channel without manual address entry

**Step 6: Verify fallback**

Temporarily unset `TREASURY_SOCKET` on Worker:
```bash
# (or just test before setting the secrets)
```
Member should see the old manual "Hub Address" text input — graceful degradation confirmed.
