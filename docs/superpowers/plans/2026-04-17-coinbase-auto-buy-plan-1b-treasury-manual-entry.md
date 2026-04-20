# Coinbase Auto-Buy — Plan 1b: Treasury-side Manual Entry UI + Notification

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the treasury-node side of the manual-input workflow introduced in Plan 1 Revision. Treasury operator enters 8 Glassnode-sourced metrics once per day via a new admin-only web page; the treasury API records the submission locally, HMAC-signs it, and forwards to the Cloudflare Worker's `POST /valuation/manual` endpoint. A daily staleness check raises a treasury alert when >24h elapse without a submission.

**Architecture:** New local SQLite table + API routes in `app/api/` + new React page + sidebar link + dashboard banner in `app/web/`. Treasury-role only. Uses Node's `crypto.createHmac` (no new deps). Reuses existing treasury_alerts + JWT auth patterns from the repo.

**Tech Stack:** TypeScript, raw Node `http.createServer`, better-sqlite3, React + Vite (matches existing patterns in `app/api/` and `app/web/`). No new dependencies.

---

## Context for the engineer

- Plan 1 (Worker valuation engine) and Plan 1-revision (Worker manual-input pivot) must be complete before starting this plan.
- Current branch: `feature/coinbase-auto-buy` — continue on the same branch. Do NOT push.
- Repo-wide CLAUDE.md applies. Relevant rules:
  - API uses raw `http.createServer` with an if/else chain; more specific routes before general ones.
  - Migrations run automatically on API startup (see `src/db/migrations.ts`).
  - No automated test suite for API/Web — verification is manual (curl + browser). Do NOT introduce vitest/jest on this side.
  - Env config authority: `app/api/src/config/env.ts`.
  - Frontend uses existing chart/panel patterns at `app/web/src/components/` and `app/web/src/pages/`.
- The treasury node has an existing `treasury_alerts` table + alert-generation pipeline (see `src/rebalance/rebalanceScheduler.ts` for an example of a scheduler that emits alerts). The new staleness alert plugs into that pipeline.

## File structure after this plan

```
app/api/
├── src/
│   ├── db/
│   │   └── migrations/
│   │       └── 028_valuation_manual_inputs.sql   (new)
│   ├── config/
│   │   └── env.ts                                (modified: add VALUATION_WORKER_URL + VALUATION_SUBMIT_HMAC)
│   ├── valuation/
│   │   ├── manualInputStore.ts                   (new: SQLite read/write of the local audit cache)
│   │   ├── workerClient.ts                       (new: HMAC-sign + POST to Worker)
│   │   └── stalenessChecker.ts                   (new: scheduled alert generator)
│   └── index.ts                                  (modified: wire POST /api/valuation/manual + GET /api/valuation/manual/status + start staleness scheduler)

app/web/
├── src/
│   ├── api/
│   │   └── client.ts                             (modified: submitValuationInputs, getValuationInputStatus)
│   ├── pages/
│   │   └── ValuationInput.tsx                    (new)
│   ├── components/
│   │   └── ValuationInputAlertBanner.tsx         (new: dashboard banner when stale)
│   ├── App.tsx                                   (modified: /valuation-input route)
│   └── AppShell.tsx                              (modified: sidebar link)
```

## Wire-contract recap (from Plan 1 Revision spec §4.6)

**Body shape** for `POST /api/valuation/manual` (treasury internal) AND `POST /valuation/manual` (Worker, HMAC-signed):

```json
{
  "submitted_at": "2026-04-17T14:32:00Z",
  "values": {
    "mvrv":              2.10,
    "puell":             0.42,
    "sopr":              1.008,
    "reserve_risk":      0.003,
    "nvt":               85.4,
    "hash_ribbons":      1.02,
    "difficulty_ribbon": 0.023,
    "hodl_waves":        0.15
  }
}
```

**HMAC signature** (computed on treasury, verified on Worker):
- Canonical string: `<ISO timestamp>\n<SHA-256 hex of JSON body>`
- Signature: HMAC-SHA256 of canonical string with `VALUATION_SUBMIT_HMAC`, hex-encoded
- Headers: `X-Valuation-Timestamp`, `X-Valuation-Signature`

---

## Task B1: Migration `028_valuation_manual_inputs.sql`

Local audit cache. One row per submission; the UI queries "last row per metric" to display the "last entered" timestamps.

**Files:**
- Create: `app/api/src/db/migrations/028_valuation_manual_inputs.sql`

- [ ] **Step 1: Create the migration**

```sql
-- 028_valuation_manual_inputs.sql — local audit cache for the 8 manually-entered
-- Glassnode metrics. Full history lives on the Worker KV; this table exists to
-- power the "last entered at <when>, value: <x>" display in the UI and to drive
-- the staleness alert. One row per (metric, submission).

CREATE TABLE IF NOT EXISTS valuation_manual_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_key TEXT NOT NULL,                    -- mvrv | puell | sopr | reserve_risk | nvt | hash_ribbons | difficulty_ribbon | hodl_waves
  value REAL NOT NULL,
  submitted_at INTEGER NOT NULL,               -- unix seconds (sourced from the submission's submitted_at)
  created_at INTEGER NOT NULL,                 -- unix seconds; when this row was inserted locally
  worker_sync_status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | failed
  worker_sync_error TEXT,                      -- populated when worker_sync_status = 'failed'
  worker_sync_at INTEGER                       -- unix seconds; when the Worker confirmed receipt (204)
);

CREATE INDEX IF NOT EXISTS idx_valuation_manual_inputs_metric_key
  ON valuation_manual_inputs (metric_key, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_valuation_manual_inputs_sync_status
  ON valuation_manual_inputs (worker_sync_status);
```

- [ ] **Step 2: Verify migration runs on API startup**

```bash
cd app/api
npm run build
# Start briefly to ensure migrations apply cleanly, then stop:
npm start &
API_PID=$!
sleep 3
# Check the table exists. If data dir is fresh, this should list the new table.
sqlite3 /tmp/bitcorn-lightning-test.db ".schema valuation_manual_inputs" 2>/dev/null || \
  sudo sqlite3 /home/umbrel/umbrel/app-data/bitcorn-lightning-node/data/db/app.db ".schema valuation_manual_inputs" 2>/dev/null || \
  echo "(run against your own local data/db; tables will show up after first API start)"
kill $API_PID
```

The exact DB path depends on environment. The key assertion is: API starts without error. The migration runner logs should show "Applied: 028_valuation_manual_inputs.sql".

- [ ] **Step 3: Commit**

```bash
git add app/api/src/db/migrations/028_valuation_manual_inputs.sql
git commit -m "feat(api): migration 028 — valuation_manual_inputs (local audit cache)"
```

---

## Task B2: Env config — `VALUATION_WORKER_URL` + `VALUATION_SUBMIT_HMAC`

**Files:**
- Modify: `app/api/src/config/env.ts`

- [ ] **Step 1: Inspect existing env**

Read `app/api/src/config/env.ts` to understand the current `ENV` object shape — it exports a frozen config with properties for things like `coinbaseAppId`, `coinbaseWorkerUrl`, `treasuryPubkey`, etc. This task adds two new env-backed fields.

- [ ] **Step 2: Add the two new fields**

In `app/api/src/config/env.ts`, locate the section that reads `process.env.COINBASE_WORKER_URL` (or similar). Immediately after it, add:

```typescript
valuationWorkerUrl: process.env.VALUATION_WORKER_URL || process.env.COINBASE_WORKER_URL || null,
valuationSubmitHmac: process.env.VALUATION_SUBMIT_HMAC || null,
```

Rationale: `VALUATION_WORKER_URL` is a separate env var but defaults to `COINBASE_WORKER_URL` since both point to the same Cloudflare Worker. This keeps existing deployments working without requiring a second env var; operators can override if they ever split the Worker.

Make sure the type of the exported `ENV` object includes the two new fields.

- [ ] **Step 3: Run the API build to confirm no type errors**

```bash
cd app/api
npm run build
```

Expected: build succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/src/config/env.ts
git commit -m "feat(api/config): add VALUATION_WORKER_URL + VALUATION_SUBMIT_HMAC env"
```

---

## Task B3: Local audit store — `src/valuation/manualInputStore.ts`

Thin SQLite wrapper. Exports `recordSubmission(metrics, submittedAt)` that inserts 8 rows, `listLatestPerMetric()` that returns the newest row per metric for the UI, and `updateSyncStatus(ids, status, error?)` that the worker-client helper calls after the Worker round-trip resolves.

**Files:**
- Create: `app/api/src/valuation/manualInputStore.ts`

- [ ] **Step 1: Implement**

Create `app/api/src/valuation/manualInputStore.ts`:

```typescript
import type Database from "better-sqlite3";

export const MANUAL_METRIC_KEYS = [
  "mvrv",
  "puell",
  "sopr",
  "reserve_risk",
  "nvt",
  "hash_ribbons",
  "difficulty_ribbon",
  "hodl_waves",
] as const;

export type ManualMetricKey = (typeof MANUAL_METRIC_KEYS)[number];

export interface LatestPerMetricRow {
  metric_key: ManualMetricKey;
  value: number;
  submitted_at: number;       // unix seconds
  created_at: number;
  worker_sync_status: "pending" | "confirmed" | "failed";
  worker_sync_error: string | null;
  worker_sync_at: number | null;
}

export interface RecordResult {
  insertedIds: number[];
  submittedAt: number;
}

/**
 * Insert 8 rows (one per metric) as a single atomic submission.
 * Returns the inserted row IDs so the worker-client can update sync status later.
 */
export function recordSubmission(
  db: Database.Database,
  values: Record<ManualMetricKey, number>,
  submittedAtUnix: number,
): RecordResult {
  const createdAt = Math.floor(Date.now() / 1000);
  const insertedIds: number[] = [];
  const insert = db.prepare(
    `INSERT INTO valuation_manual_inputs (metric_key, value, submitted_at, created_at, worker_sync_status)
     VALUES (?, ?, ?, ?, 'pending')`,
  );
  const txn = db.transaction(() => {
    for (const key of MANUAL_METRIC_KEYS) {
      const v = values[key];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`invalid value for ${key}: ${v}`);
      }
      const info = insert.run(key, v, submittedAtUnix, createdAt);
      insertedIds.push(Number(info.lastInsertRowid));
    }
  });
  txn();
  return { insertedIds, submittedAt: submittedAtUnix };
}

/**
 * Return the most recent row per metric. Used by GET /api/valuation/manual/status.
 */
export function listLatestPerMetric(db: Database.Database): LatestPerMetricRow[] {
  const rows = db.prepare(
    `SELECT metric_key, value, submitted_at, created_at, worker_sync_status, worker_sync_error, worker_sync_at
     FROM valuation_manual_inputs v1
     WHERE id = (
       SELECT id FROM valuation_manual_inputs v2
       WHERE v2.metric_key = v1.metric_key
       ORDER BY submitted_at DESC, id DESC LIMIT 1
     )`,
  ).all() as LatestPerMetricRow[];
  return rows;
}

/**
 * Mark a batch of rows (by id) as confirmed or failed after the Worker round-trip.
 */
export function updateSyncStatus(
  db: Database.Database,
  ids: number[],
  status: "confirmed" | "failed",
  error?: string,
): void {
  const syncAt = status === "confirmed" ? Math.floor(Date.now() / 1000) : null;
  const stmt = db.prepare(
    `UPDATE valuation_manual_inputs
     SET worker_sync_status = ?, worker_sync_error = ?, worker_sync_at = ?
     WHERE id = ?`,
  );
  const txn = db.transaction(() => {
    for (const id of ids) stmt.run(status, error ?? null, syncAt, id);
  });
  txn();
}
```

- [ ] **Step 2: Build to confirm types**

```bash
cd app/api
npm run build
```

Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add app/api/src/valuation/manualInputStore.ts
git commit -m "feat(api/valuation): add manualInputStore (local SQLite audit cache)"
```

---

## Task B4: Worker client — `src/valuation/workerClient.ts`

HMAC-signs and POSTs the submission to the Worker. Returns success/failure; does not throw on network failure (caller decides how to surface).

**Files:**
- Create: `app/api/src/valuation/workerClient.ts`

- [ ] **Step 1: Implement**

Create `app/api/src/valuation/workerClient.ts`:

```typescript
import { createHash, createHmac } from "crypto";
import type { ManualMetricKey } from "./manualInputStore";

export interface SubmissionBody {
  submitted_at: string; // ISO
  values: Record<ManualMetricKey, number>;
}

export interface WorkerPostResult {
  ok: boolean;
  status: number;
  error?: string;
}

function canonicalString(timestamp: string, body: string): string {
  return `${timestamp}\n${createHash("sha256").update(body).digest("hex")}`;
}

function signHmac(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(canonicalString(timestamp, body)).digest("hex");
}

/**
 * Post a manual-input submission to the Worker. Never throws — returns a
 * structured result so the caller can persist a sync-status update.
 */
export async function postManualInputToWorker(
  workerBaseUrl: string,
  hmacSecret: string,
  submission: SubmissionBody,
): Promise<WorkerPostResult> {
  const body = JSON.stringify(submission);
  const timestamp = submission.submitted_at; // same ISO used as the signed timestamp
  const signature = signHmac(hmacSecret, timestamp, body);

  try {
    const res = await fetch(`${workerBaseUrl}/valuation/manual`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Valuation-Timestamp": timestamp,
        "X-Valuation-Signature": signature,
      },
      body,
    });
    if (res.status === 204) {
      return { ok: true, status: 204 };
    }
    const errBody = await res.text().catch(() => "");
    return { ok: false, status: res.status, error: errBody.slice(0, 500) };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 2: Build**

```bash
cd app/api
npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/api/src/valuation/workerClient.ts
git commit -m "feat(api/valuation): add workerClient — HMAC-signed POST to /valuation/manual"
```

---

## Task B5: API routes — `POST /api/valuation/manual` + `GET /api/valuation/manual/status`

**Files:**
- Modify: `app/api/src/index.ts`

- [ ] **Step 1: Locate the JWT/treasury-role gating pattern**

Read `app/api/src/index.ts` and find an existing treasury-role-gated POST endpoint (e.g., something in the rebalance or treasury settings area). Identify:
- How the JWT is parsed from `Authorization: Bearer ...`
- How role is extracted and rejected with 403 if not `treasury`
- How JSON body is parsed (there's typically a `readJsonBody(req)` helper)

Reuse those exact patterns in the new routes; do NOT introduce a new auth mechanism.

- [ ] **Step 2: Add `POST /api/valuation/manual`**

Add this branch to `index.ts` in the appropriate location (likely near the existing `/api/rebalance` or `/api/treasury` routes). Use the existing JWT-auth helper in the codebase (don't hand-roll):

```typescript
if (req.method === "POST" && req.url === "/api/valuation/manual") {
  try {
    const claims = await requireTreasuryRole(req); // use existing helper; reject returns 401/403
    if (!claims) return; // helper has already written the response
    if (!ENV.valuationWorkerUrl || !ENV.valuationSubmitHmac) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "valuation_worker_not_configured" }));
      return;
    }
    const raw = await readJsonBody(req);
    const values = raw?.values;
    if (!values || typeof values !== "object") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "values_required" }));
      return;
    }
    // Validate all 8 metric keys present + finite
    for (const key of MANUAL_METRIC_KEYS) {
      const v = values[key];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `invalid_value_for_${key}` }));
        return;
      }
    }

    const submittedAtISO = new Date().toISOString();
    const submittedAtUnix = Math.floor(Date.parse(submittedAtISO) / 1000);

    // 1. Record locally (8 rows, pending)
    const record = recordSubmission(db, values, submittedAtUnix);

    // 2. Forward to Worker (HMAC-signed)
    const workerResult = await postManualInputToWorker(
      ENV.valuationWorkerUrl,
      ENV.valuationSubmitHmac,
      { submitted_at: submittedAtISO, values },
    );

    // 3. Update sync status
    updateSyncStatus(
      db,
      record.insertedIds,
      workerResult.ok ? "confirmed" : "failed",
      workerResult.ok ? undefined : `status=${workerResult.status} error=${workerResult.error ?? ""}`,
    );

    // 4. Respond — 200 if local write + worker round-trip both succeeded,
    //    207 (multi-status) if local persisted but worker failed
    if (workerResult.ok) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, submitted_at: submittedAtISO }));
    } else {
      res.writeHead(207, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        submitted_at: submittedAtISO,
        local_saved: true,
        worker_error: workerResult.error ?? null,
        worker_status: workerResult.status,
      }));
    }
  } catch (err) {
    console.error("[valuation-manual]", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
  return;
}
```

Required imports at the top of `index.ts`:

```typescript
import { MANUAL_METRIC_KEYS, recordSubmission, updateSyncStatus, listLatestPerMetric } from "./valuation/manualInputStore";
import { postManualInputToWorker } from "./valuation/workerClient";
```

- [ ] **Step 3: Add `GET /api/valuation/manual/status`**

Add this branch (after the POST):

```typescript
if (req.method === "GET" && req.url === "/api/valuation/manual/status") {
  try {
    const claims = await requireTreasuryRole(req);
    if (!claims) return;
    const rows = listLatestPerMetric(db);
    // Fill in zero-row metrics with null so the UI always sees 8 entries
    const byKey = new Map(rows.map((r) => [r.metric_key, r]));
    const response = MANUAL_METRIC_KEYS.map((key) => {
      const row = byKey.get(key);
      return row ? {
        metric_key: key,
        value: row.value,
        submitted_at: row.submitted_at,
        worker_sync_status: row.worker_sync_status,
        worker_sync_error: row.worker_sync_error,
        worker_sync_at: row.worker_sync_at,
      } : {
        metric_key: key,
        value: null,
        submitted_at: null,
        worker_sync_status: null,
        worker_sync_error: null,
        worker_sync_at: null,
      };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ metrics: response }));
  } catch (err) {
    console.error("[valuation-manual-status]", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "internal_error" }));
  }
  return;
}
```

- [ ] **Step 4: Update CORS allowed methods if necessary**

If the CORS block in `index.ts` doesn't already include POST and GET in the `Access-Control-Allow-Methods`, add them. (They should already be there based on existing endpoints.)

- [ ] **Step 5: Build + manual smoke**

```bash
cd app/api
npm run build
# Start the API
npm start
```

In another terminal, get a JWT (the repo's JWT helper — likely `sudo cat /data/secrets/jwt-secret` or similar). Then:

```bash
TOKEN="<your-treasury-jwt>"

# Test GET /status (empty state — all null)
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3101/api/valuation/manual/status | jq .

# Test POST
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  http://localhost:3101/api/valuation/manual \
  -d '{"values":{"mvrv":2.1,"puell":0.4,"sopr":1.008,"reserve_risk":0.003,"nvt":85.4,"hash_ribbons":1.02,"difficulty_ribbon":0.023,"hodl_waves":0.15}}' | jq .

# Re-check status — all 8 metrics should show values with submitted_at + worker_sync_status
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3101/api/valuation/manual/status | jq .
```

Expected: POST returns `{ok: true, submitted_at: "..."}` if Worker is reachable and HMAC is configured; otherwise `{ok: false, local_saved: true, worker_error: "..."}`. GET returns the 8 metrics with current values.

- [ ] **Step 6: Commit**

```bash
git add app/api/src/index.ts
git commit -m "feat(api): add POST /api/valuation/manual + GET /api/valuation/manual/status

Treasury-role gated. POST records the 8-metric submission locally, HMAC-signs
it, and forwards to the Worker's /valuation/manual endpoint. GET returns the
last submission per metric for the UI. Local-saved-but-worker-failed yields
HTTP 207 so the UI can surface partial success."
```

---

## Task B6: Staleness checker — `src/valuation/stalenessChecker.ts` + scheduler wiring

Runs every 15 minutes. Queries the most recent submission per metric; if any metric's `submitted_at` is > 24 hours old, emits a `VALUATION_MANUAL_STALE` treasury alert (or clears it if everything's fresh).

**Files:**
- Create: `app/api/src/valuation/stalenessChecker.ts`
- Modify: `app/api/src/index.ts` (start the scheduler on API startup)

- [ ] **Step 1: Look up the existing alert-emission pattern**

Find a file in the repo that writes to the `treasury_alerts` table — likely `src/rebalance/rebalanceScheduler.ts` or similar. Identify:
- The SQL: `INSERT OR REPLACE INTO treasury_alerts (...)` pattern
- The alert shape (id, type, severity, title, body, acknowledged_at, etc.)
- How alerts are "cleared" (either DELETE or mark acknowledged)

Reuse the exact pattern. Do NOT invent a new alert-storage mechanism.

- [ ] **Step 2: Implement the checker**

Create `app/api/src/valuation/stalenessChecker.ts`:

```typescript
import type Database from "better-sqlite3";
import { listLatestPerMetric, MANUAL_METRIC_KEYS } from "./manualInputStore";

const STALE_THRESHOLD_SECONDS = 24 * 60 * 60;
const ALERT_ID = "VALUATION_MANUAL_STALE";

/**
 * Check whether any of the 8 manually-entered metrics is > 24h old. If so,
 * raise/refresh the treasury alert with a body summarising which metrics.
 * If all are fresh (or none have ever been entered in more than 24h),
 * clear any existing stale alert.
 *
 * This runs on a scheduler tick (see stalenessScheduler), NOT as a request handler.
 */
export function checkValuationStaleness(db: Database.Database): void {
  const rows = listLatestPerMetric(db);
  const byKey = new Map(rows.map((r) => [r.metric_key, r]));
  const now = Math.floor(Date.now() / 1000);

  const stale: string[] = [];
  const neverEntered: string[] = [];
  for (const key of MANUAL_METRIC_KEYS) {
    const row = byKey.get(key);
    if (!row) {
      neverEntered.push(key);
    } else if (now - row.submitted_at > STALE_THRESHOLD_SECONDS) {
      stale.push(key);
    }
  }

  if (stale.length === 0 && neverEntered.length === 0) {
    // All fresh — clear alert if present.
    db.prepare(`DELETE FROM treasury_alerts WHERE id = ?`).run(ALERT_ID);
    return;
  }

  const title = neverEntered.length === MANUAL_METRIC_KEYS.length
    ? "Valuation inputs not yet entered"
    : "Valuation inputs stale";

  const parts: string[] = [];
  if (neverEntered.length > 0) {
    parts.push(`Never entered: ${neverEntered.join(", ")}`);
  }
  if (stale.length > 0) {
    parts.push(`> 24h old: ${stale.join(", ")}`);
  }
  const body = `${parts.join("; ")}. Open the Valuation Inputs page to enter today's values.`;

  db.prepare(
    `INSERT OR REPLACE INTO treasury_alerts (id, type, severity, title, body, created_at, acknowledged_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(ALERT_ID, "valuation_manual_stale", "warning", title, body, now);
}

/**
 * Start a 15-minute scheduler that periodically runs checkValuationStaleness.
 * Called from index.ts on API startup. Returns the interval handle so it can
 * be cleared in tests or on shutdown.
 */
export function startStalenessScheduler(db: Database.Database): NodeJS.Timeout {
  // Run once on startup (give the server 5s to fully boot first)
  setTimeout(() => {
    try { checkValuationStaleness(db); }
    catch (err) { console.error("[valuation-staleness]", err); }
  }, 5_000);
  // Then every 15 minutes
  return setInterval(() => {
    try { checkValuationStaleness(db); }
    catch (err) { console.error("[valuation-staleness]", err); }
  }, 15 * 60 * 1000);
}
```

Note on the `treasury_alerts` insert: you must verify the exact column names of the existing table (from the existing migrations). If the real schema differs (e.g. `id` is `INTEGER PRIMARY KEY AUTOINCREMENT` instead of `TEXT`, or the `type` column is named something else), adjust the INSERT statement to match — DO NOT modify the `treasury_alerts` schema. If the existing table's id is an integer, use `INSERT OR REPLACE` keyed on a unique `type` constraint instead.

- [ ] **Step 3: Start the scheduler from `index.ts`**

In `app/api/src/index.ts`, locate where other schedulers start (e.g., `startRebalanceScheduler(db)` or similar). Add:

```typescript
import { startStalenessScheduler } from "./valuation/stalenessChecker";
```

And in the startup block:

```typescript
startStalenessScheduler(db);
```

- [ ] **Step 4: Build + smoke**

```bash
cd app/api
npm run build
npm start
```

Watch the logs; after ~5s you should see the first `checkValuationStaleness` run. Confirm via sqlite:

```bash
sudo sqlite3 <app-db> "SELECT id, type, severity, title, body FROM treasury_alerts WHERE id = 'VALUATION_MANUAL_STALE';"
```

If no submissions have been made, expect the alert row present with body mentioning "Never entered: mvrv, puell, ...". Submit values via the POST route from B5, wait for the next scheduler tick (or patch the interval to 10 seconds temporarily for testing), and confirm the row is deleted.

- [ ] **Step 5: Commit**

```bash
git add app/api/src/valuation/stalenessChecker.ts app/api/src/index.ts
git commit -m "feat(api/valuation): add manual-input staleness alert + 15-min scheduler"
```

---

## Task B7: Web client additions — `submitValuationInputs`, `getValuationInputStatus`

**Files:**
- Modify: `app/web/src/api/client.ts`

- [ ] **Step 1: Add the two client functions**

In `app/web/src/api/client.ts`, locate the existing `api` object / client export and add:

```typescript
export interface ManualMetricStatus {
  metric_key: "mvrv" | "puell" | "sopr" | "reserve_risk" | "nvt" | "hash_ribbons" | "difficulty_ribbon" | "hodl_waves";
  value: number | null;
  submitted_at: number | null;
  worker_sync_status: "pending" | "confirmed" | "failed" | null;
  worker_sync_error: string | null;
  worker_sync_at: number | null;
}

export interface ManualMetricStatusResponse {
  metrics: ManualMetricStatus[];
}

export interface SubmitValuationInputsRequest {
  values: {
    mvrv: number;
    puell: number;
    sopr: number;
    reserve_risk: number;
    nvt: number;
    hash_ribbons: number;
    difficulty_ribbon: number;
    hodl_waves: number;
  };
}

export interface SubmitValuationInputsResponse {
  ok: boolean;
  submitted_at: string;
  local_saved?: boolean;
  worker_error?: string | null;
  worker_status?: number;
}
```

Add these methods to the `api` object (or equivalent exported pattern — match the repo's existing style):

```typescript
async submitValuationInputs(body: SubmitValuationInputsRequest): Promise<SubmitValuationInputsResponse> {
  const res = await authedFetch("/api/valuation/manual", { method: "POST", body: JSON.stringify(body) });
  // NOTE: success is any 2xx (including 207 — local saved, worker failed)
  if (!res.ok && res.status !== 207) {
    throw new Error(`submitValuationInputs failed: ${res.status}`);
  }
  return res.json();
},

async getValuationInputStatus(): Promise<ManualMetricStatusResponse> {
  const res = await authedFetch("/api/valuation/manual/status");
  if (!res.ok) throw new Error(`getValuationInputStatus failed: ${res.status}`);
  return res.json();
},
```

Use the repo's existing `authedFetch` helper (or equivalent). Do not hand-roll JWT handling.

- [ ] **Step 2: Confirm typecheck**

```bash
cd app/web
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/api/client.ts
git commit -m "feat(web/api): add submitValuationInputs + getValuationInputStatus"
```

---

## Task B8: `ValuationInput.tsx` page

**Files:**
- Create: `app/web/src/pages/ValuationInput.tsx`

Layout:
- Page header "Daily Valuation Inputs" with subtitle describing cadence
- Warning banner if any metric is stale (> 24h) or never-entered
- 8 rows, each with: metric label + short description + current "last entered" value + input field + link to the free public chart
- Single "Save All" button at the bottom
- Success/error toast after submission

- [ ] **Step 1: Implement the page**

Create `app/web/src/pages/ValuationInput.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api, type ManualMetricStatus, type SubmitValuationInputsRequest } from "../api/client";

type MetricKey = ManualMetricStatus["metric_key"];

interface MetricConfig {
  key: MetricKey;
  label: string;
  description: string;
  chartUrl: string;  // public free chart where operator reads the value
  typicalRange: string;
  decimals: number;  // display precision
}

const METRICS: MetricConfig[] = [
  { key: "mvrv",              label: "MVRV Z-Score",          description: "Market Value / Realised Value deviation", chartUrl: "https://studio.glassnode.com/charts/market.MvrvZScore", typicalRange: "−0.5 to +10", decimals: 3 },
  { key: "puell",             label: "Puell Multiple",        description: "Miner revenue / 365-day MA",              chartUrl: "https://studio.glassnode.com/charts/indicators.PuellMultiple", typicalRange: "0.3 to 4",    decimals: 3 },
  { key: "sopr",              label: "SOPR (30d MA)",         description: "Spent Output Profit Ratio, 30-day MA",    chartUrl: "https://studio.glassnode.com/charts/indicators.Sopr",          typicalRange: "0.97 to 1.05", decimals: 4 },
  { key: "reserve_risk",      label: "Reserve Risk",          description: "Confidence-weighted HODL score",          chartUrl: "https://studio.glassnode.com/charts/indicators.ReserveRisk",    typicalRange: "0.002 to 0.02", decimals: 4 },
  { key: "nvt",               label: "NVT Signal",            description: "Network Value / Transaction Volume (90d)", chartUrl: "https://studio.glassnode.com/charts/indicators.Nvts",          typicalRange: "30 to 200", decimals: 2 },
  { key: "hash_ribbons",      label: "Hash Ribbons",          description: "30d/60d hashrate crossover",              chartUrl: "https://studio.glassnode.com/charts/indicators.HashRibbon",     typicalRange: "0.9 to 1.1", decimals: 3 },
  { key: "difficulty_ribbon", label: "Difficulty Ribbon",     description: "Compression of 9 difficulty MAs",         chartUrl: "https://studio.glassnode.com/charts/indicators.DifficultyRibbonCompression", typicalRange: "0.005 to 0.08", decimals: 4 },
  { key: "hodl_waves",        label: "Realized Cap HODL Waves", description: "1y-2y age-band realized cap share",     chartUrl: "https://studio.glassnode.com/charts/supply.RealizedHodlWaves",  typicalRange: "0.05 to 0.25", decimals: 3 },
];

function formatRelative(unix: number | null): string {
  if (unix == null) return "never";
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ValuationInput() {
  const [status, setStatus] = useState<ManualMetricStatus[]>([]);
  const [inputs, setInputs] = useState<Record<MetricKey, string>>(() =>
    METRICS.reduce((acc, m) => ({ ...acc, [m.key]: "" }), {} as Record<MetricKey, string>),
  );
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error" | "partial"; message: string } | null>(null);

  const refresh = () => {
    api.getValuationInputStatus()
      .then((r) => setStatus(r.metrics))
      .catch((err) => console.error("[valuation-input] fetch status", err));
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setToast(null);
    try {
      // Parse all 8 inputs; fail fast if any is not a finite number
      const parsed = {} as SubmitValuationInputsRequest["values"];
      for (const m of METRICS) {
        const n = Number(inputs[m.key]);
        if (!Number.isFinite(n)) {
          setToast({ kind: "error", message: `Invalid number for ${m.label}` });
          setSaving(false);
          return;
        }
        parsed[m.key] = n;
      }
      const res = await api.submitValuationInputs({ values: parsed });
      if (res.ok) {
        setToast({ kind: "success", message: `Saved at ${res.submitted_at}` });
      } else {
        setToast({ kind: "partial", message: `Local saved, Worker failed (${res.worker_error || "unknown"})` });
      }
      refresh();
      // Clear input fields after successful save
      setInputs(METRICS.reduce((acc, m) => ({ ...acc, [m.key]: "" }), {} as Record<MetricKey, string>));
    } catch (err) {
      setToast({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const staleOrMissing = status.filter((m) => {
    if (m.submitted_at == null) return true;
    return Math.floor(Date.now() / 1000) - m.submitted_at > 24 * 60 * 60;
  });

  return (
    <div className="page">
      <div className="page-header">
        <h1>Daily Valuation Inputs</h1>
        <p className="muted">
          Enter the 8 Glassnode-sourced metrics once per day. Read each value from the linked chart;
          submissions flow to the Cloudflare Worker which updates the composite Z-score used by Auto-Buy.
        </p>
      </div>

      {staleOrMissing.length > 0 && (
        <div className="alert alert-warning">
          <strong>{staleOrMissing.length} metric{staleOrMissing.length === 1 ? "" : "s"} need attention:</strong>{" "}
          {staleOrMissing.map((m) => m.metric_key).join(", ")}
        </div>
      )}

      <div className="valuation-grid">
        {METRICS.map((m) => {
          const s = status.find((x) => x.metric_key === m.key);
          return (
            <div key={m.key} className="valuation-row">
              <div className="valuation-info">
                <div className="valuation-label">{m.label}</div>
                <div className="valuation-description muted">{m.description}</div>
                <div className="valuation-meta muted">
                  typical range: {m.typicalRange}
                  {" · "}
                  <a href={m.chartUrl} target="_blank" rel="noreferrer">chart ↗</a>
                </div>
              </div>
              <div className="valuation-last">
                {s?.value != null ? (
                  <>
                    <div className="valuation-last-value">{s.value.toFixed(m.decimals)}</div>
                    <div className="muted small">
                      {formatRelative(s.submitted_at)}
                      {s.worker_sync_status === "failed" && (
                        <span title={s.worker_sync_error || ""}> · worker sync failed</span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="muted">never entered</div>
                )}
              </div>
              <input
                type="number"
                step="any"
                value={inputs[m.key]}
                onChange={(e) => setInputs({ ...inputs, [m.key]: e.target.value })}
                placeholder="—"
                disabled={saving}
              />
            </div>
          );
        })}
      </div>

      <div className="valuation-actions">
        <button onClick={handleSave} disabled={saving} className="btn btn-primary">
          {saving ? "Saving…" : "Save All"}
        </button>
      </div>

      {toast && (
        <div className={`toast toast-${toast.kind}`}>{toast.message}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Styles**

The component references CSS classes (`page`, `page-header`, `valuation-grid`, `valuation-row`, etc.). Add the needed rules to the existing stylesheet (likely `app/web/src/index.css` or `app/web/src/App.css` — check the repo's pattern). Keep the styling minimal and consistent with the existing components (e.g., ChannelsPage).

Example minimal CSS:

```css
.valuation-grid { display: flex; flex-direction: column; gap: 1rem; margin: 1rem 0; }
.valuation-row {
  display: grid; grid-template-columns: 2fr 1fr 10rem; gap: 1rem; align-items: center;
  padding: 0.75rem; border: 1px solid var(--border); border-radius: 0.5rem;
}
.valuation-info .valuation-label { font-weight: 600; }
.valuation-info .valuation-description, .valuation-info .valuation-meta { font-size: 0.875rem; }
.valuation-last { text-align: right; }
.valuation-last-value { font-family: var(--mono); font-size: 1.125rem; }
.valuation-actions { display: flex; justify-content: flex-end; margin-top: 1rem; }
.toast { margin-top: 1rem; padding: 0.75rem 1rem; border-radius: 0.5rem; }
.toast-success { background: var(--green-bg); color: var(--green); }
.toast-error   { background: var(--red-bg);   color: var(--red); }
.toast-partial { background: var(--amber-bg); color: var(--amber); }
```

Match the existing CSS variable names in the repo (`--border`, `--mono`, `--red`, etc.) — check an existing page's styling and reuse the tokens.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/pages/ValuationInput.tsx app/web/src/index.css
git commit -m "feat(web): add /valuation-input page for daily manual metric entry"
```

---

## Task B9: Wire route in `App.tsx` and sidebar link in `AppShell`

**Files:**
- Modify: `app/web/src/App.tsx`
- Modify: `app/web/src/AppShell.tsx` (or wherever the treasury sidebar lives — verify the filename)

- [ ] **Step 1: Add the route**

Locate the route table in `App.tsx`. Add:

```tsx
<Route path="/valuation-input" element={<ValuationInput />} />
```

alongside the other treasury-only routes. Import at the top:

```tsx
import ValuationInput from "./pages/ValuationInput";
```

- [ ] **Step 2: Add the sidebar link**

In `AppShell.tsx` (treasury shell), add a sidebar entry near the existing treasury-admin entries:

```tsx
{ to: "/valuation-input", label: "Valuation Inputs", icon: "📊" }
```

Match the exact icon/label style used by neighbouring links. Do NOT add the link to the member shell (this is treasury-only).

- [ ] **Step 3: Build + browser smoke**

```bash
cd app/web
npm run build
npm run dev
```

Open `http://localhost:3200`, log in as treasury, confirm:
- Sidebar shows "Valuation Inputs"
- Clicking it loads the page, shows 8 rows, all "never entered"
- Enter 8 test values, click "Save All"
- Success toast appears
- Page refreshes and shows "last entered: now" for each metric
- Reload — status persists

If the Worker is running and `VALUATION_WORKER_URL` + `VALUATION_SUBMIT_HMAC` are set, the status should show `worker_sync_status: confirmed` for each metric.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/App.tsx app/web/src/AppShell.tsx
git commit -m "feat(web): wire /valuation-input route + sidebar link (treasury only)"
```

---

## Task B10: Dashboard banner — `ValuationInputAlertBanner.tsx`

Pulls the stale-alert state from the existing treasury-alerts endpoint and renders a dismissible (or non-dismissible) banner linking to `/valuation-input`.

**Files:**
- Create: `app/web/src/components/ValuationInputAlertBanner.tsx`
- Modify: the treasury Dashboard page (likely `app/web/src/pages/Dashboard.tsx`) to render the banner

- [ ] **Step 1: Find the existing treasury-alerts hook**

Search for where `treasury_alerts` are fetched on the dashboard. There's likely a hook or direct fetch in `Dashboard.tsx` that renders active alerts. The banner should reuse that data source if possible, filtering for `id === "VALUATION_MANUAL_STALE"`.

- [ ] **Step 2: Implement the banner**

Create `app/web/src/components/ValuationInputAlertBanner.tsx`:

```tsx
import { Link } from "react-router-dom";

interface TreasuryAlertLike {
  id: string;
  title: string;
  body: string;
  severity: string;
}

interface Props {
  alerts: TreasuryAlertLike[];
}

export default function ValuationInputAlertBanner({ alerts }: Props) {
  const alert = alerts.find((a) => a.id === "VALUATION_MANUAL_STALE");
  if (!alert) return null;
  return (
    <div className="alert alert-warning" role="alert">
      <div>
        <strong>{alert.title}</strong>
        <div className="muted">{alert.body}</div>
      </div>
      <Link to="/valuation-input" className="btn btn-sm">Enter now →</Link>
    </div>
  );
}
```

- [ ] **Step 3: Render from the Dashboard**

In `Dashboard.tsx` (treasury), import the component and render it near the top — below the balance panel, above the rebalance/channels panels. Pass the existing `alerts` array.

```tsx
import ValuationInputAlertBanner from "../components/ValuationInputAlertBanner";
// ... inside the component render:
<ValuationInputAlertBanner alerts={alerts} />
```

- [ ] **Step 4: Browser smoke**

Start the dev server. Log in as treasury. If you haven't submitted inputs (or last submission > 24h old), the banner should appear at the top of the dashboard with a link to the inputs page. After submitting, wait for the next 15-min staleness scheduler tick (or restart the API, which fires the check 5s after startup), then reload the dashboard — the banner should disappear.

- [ ] **Step 5: Commit**

```bash
git add app/web/src/components/ValuationInputAlertBanner.tsx app/web/src/pages/Dashboard.tsx
git commit -m "feat(web): add dashboard banner for stale valuation inputs"
```

---

## Task B11: Operational setup + smoke test

**No code changes.** Set env vars, verify end-to-end.

- [ ] **Step 1: Set the treasury env vars**

In the Umbrel app's `docker-compose.yml` (`bitcorn-lightning-node/docker-compose.yml` in the repo, which gets deployed to Umbrel), add to the `api` service's `environment` block:

```yaml
      - VALUATION_WORKER_URL=https://bitcorn-onramp.ethancail.workers.dev
      - VALUATION_SUBMIT_HMAC=<random-64-char-hex-secret>
```

Generate the HMAC secret with:

```bash
openssl rand -hex 32
```

Use the SAME value on the Worker via `wrangler secret put VALUATION_SUBMIT_HMAC` when deploying Plan 1 Revision. The two sides must share the exact same secret.

For local dev testing, `export VALUATION_WORKER_URL=...` and `export VALUATION_SUBMIT_HMAC=...` before `npm start` in `app/api`.

- [ ] **Step 2: End-to-end smoke**

With both Worker (running locally via `wrangler dev` or deployed) and treasury API running:

1. Log into treasury web UI.
2. Click "Valuation Inputs" sidebar link.
3. Enter 8 test values (read current values from Glassnode Studio charts — they're free to view).
4. Click "Save All".
5. Expect green success toast with ISO timestamp.
6. Page refreshes, all 8 rows show `worker_sync_status: confirmed` (if dashboard shows this detail — otherwise check via `GET /api/valuation/manual/status`).
7. Open Cloudflare Worker dashboard → Logs → look for `[manualInput] …` success log.
8. `curl https://bitcorn-onramp.ethancail.workers.dev/valuation/inputs | jq '.mvrv'` — should show the submitted value.
9. After the next Worker cron run (00:15 UTC), `curl .../valuation/current` should reflect a composite that includes the manual inputs' contribution.

- [ ] **Step 3: Stale-alert test**

- Set up the alert: in SQL, `UPDATE valuation_manual_inputs SET submitted_at = submitted_at - 90000 WHERE id = (SELECT MAX(id) FROM valuation_manual_inputs);` (fakes a >24h-old latest submission).
- Restart the API or wait 15 min for next scheduler tick.
- Check `treasury_alerts` table — should have `id = 'VALUATION_MANUAL_STALE'` row.
- Reload the dashboard — banner appears.
- Submit new values.
- Wait for next scheduler tick.
- Alert row deleted; banner disappears.

- [ ] **Step 4: Commit nothing, push the branch**

No new files were created in Task B11. Push the branch now so the user can open the PR to `develop`:

```bash
git push -u origin feature/coinbase-auto-buy
```

Plan 1b complete. Valuation engine end-to-end is operational. Plan 2 (Coinbase Auto-Buy Executor on the node) can start.

---

## Self-review checklist (already performed)

- **Spec coverage**: §4.6 manual-input workflow → B1 (migration), B3 (local store), B4 (worker client), B5 (API routes), B6 (staleness alert), B8 (UI page), B9 (route/sidebar), B10 (dashboard banner). §4.5 secrets → B2 (env config) + B11 (operational).
- **Placeholder scan**: no TBD / "Similar to Task N" cross-references.
- **Type consistency**: `MANUAL_METRIC_KEYS` defined once in B3 and consumed in B5 (routes), B6 (staleness), B7 (client), B8 (UI). HMAC sign in B4 matches verify in Plan 1 Revision Task R1 by canonical-string contract.
- **Verification coverage**: no automated tests on the API/Web side (repo convention); manual curl + browser smoke in B5, B6, B9, B10, B11 close the loop.
