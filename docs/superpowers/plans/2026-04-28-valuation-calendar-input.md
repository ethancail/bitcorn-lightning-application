# Valuation Calendar Input — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 8-metric `/valuation-input` form with a year/month/day calendar UI that lets the operator (Cael) backdate entries, edit prior values, delete bad data, and audit history at a glance.

**Architecture:** Three views (year heatmap → month grid → day form) wired together via React state + URL params. Backend extends the existing manual-input pipeline (treasury-node API → HMAC-signed POST → Cloudflare Worker → KV) with upsert-by-date semantics, day/range queries, and per-metric delete. Single timestamp per entry = day's UTC midnight; in-place edits; hard delete.

**Tech Stack:** TypeScript / React 18 / Vite (frontend), Node `http.createServer` raw HTTP server (API on port 3101), Cloudflare Workers + KV (manual-input store at key `valuation_manual_v1`).

**Sequencing:** Three PRs. PR A is backend foundation (additive — existing form keeps working). PR B replaces the UI with the calendar (depends on PR A). PR C is optional polish.

---

## File Structure

### Worker (`cloudflare-worker/src/`)

| File | Responsibility |
|---|---|
| `valuation/manualStore.ts` | Existing — extend with `upsertManualSubmission`, `deleteManualEntries`, `getDayValues`, `getCalendarSummary` |
| `handlers/manualInput.ts` | Existing — extend `handleManualInput` to support upsert + delete in a single signed POST |
| `handlers/manualInputQuery.ts` (NEW) | GET handlers for `/valuation/manual/day` and `/valuation/manual/calendar` — read-only, no HMAC needed |
| `index.ts` | Register the two new GET routes |

### API server (`app/api/src/`)

| File | Responsibility |
|---|---|
| `valuation/manualInputStore.ts` | Existing — add `recordUpsertForDate`, `recordDeletionForDate`, `listValuesForDay`, `summarizeDateRange` |
| `valuation/workerClient.ts` | Existing — extend `postManualInputToWorker` to send the unified upsert+delete body shape |
| `db/migrations/035_valuation_manual_calendar.sql` (NEW) | Schema upgrade: add `entry_date` TEXT column to `valuation_manual_inputs`, indexed; `INSERT OR REPLACE` semantics via `(metric_key, entry_date)` unique constraint |
| `index.ts` | Extend `POST /api/valuation/manual` to accept `{date, values?, delete?}`; add `GET /api/valuation/manual/day` and `GET /api/valuation/manual/calendar` |

### Frontend (`app/web/src/`)

| File | Responsibility |
|---|---|
| `pages/ValuationInput.tsx` | Replace flat-form rendering with calendar shell; manage `view` (`year`/`month`/`day`) + `selectedDate` state, sync to URL params |
| `components/valuation/YearHeatmap.tsx` (NEW) | 52w × 7d cells; color-coded by completeness; arrow nav to prior years; click → month |
| `components/valuation/MonthGrid.tsx` (NEW) | 5–6 row × 7 col calendar grid; per-day completeness badges; click → day |
| `components/valuation/DayForm.tsx` (NEW) | Existing 8-metric form, scoped to `selectedDate`; per-metric save + Save All; per-metric delete; pre-populated from server values for that date |
| `components/valuation/Breadcrumb.tsx` (NEW) | `2026 ▸ April ▸ 24` clickable breadcrumb + Today button |
| `api/client.ts` | Add `getValuationDay`, `getValuationCalendar`, `submitValuationDay` (replaces `submitValuationInputs`), `deleteValuationEntry` |

---

## API Contract (locked-in)

**`POST /api/valuation/manual`** (extended):

Request body:
```json
{
  "date": "2026-04-27",
  "values": { "mvrv": 1.42, "puell": 0.51 },   // optional — upsert these
  "delete": ["sopr"]                            // optional — remove these for the date
}
```

Both `values` and `delete` are optional but at least one must be present. The API records locally + signs and forwards to the Worker as a single payload. Worker upserts all `values` keys and deletes all `delete` keys for `date`.

Response: `200 {ok: true, date}` on success, `207 {ok: false, local_saved: true, worker_error}` on Worker failure with local persistence intact.

**`GET /api/valuation/manual/day?date=YYYY-MM-DD`**:

Response:
```json
{
  "date": "2026-04-27",
  "metrics": {
    "mvrv": { "value": 1.42, "submitted_at": 1745712000, "worker_sync_status": "confirmed" },
    "puell": { "value": null, "submitted_at": null, "worker_sync_status": null },
    ...
  }
}
```

All 8 keys present; missing entries return `null` value.

**`GET /api/valuation/manual/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`**:

Response:
```json
{
  "from": "2026-01-01",
  "to": "2026-12-31",
  "days": {
    "2026-04-27": { "filled": 8, "total": 8 },
    "2026-04-26": { "filled": 5, "total": 8 },
    ...
  }
}
```

Only days with at least one entry appear in `days`. Caller treats missing dates as `{filled: 0, total: 8}`.

---

# PR A — Backend Foundation

**Branch:** `feature/calendar-backend`

This PR is additive: existing `POST /api/valuation/manual` keeps working unchanged for callers that don't pass `date`. Existing flat form on `/valuation-input` continues to function until PR B replaces it.

### Task A1: Worker — extend `manualStore.ts` with upsert/delete/query primitives

**Files:**
- Modify: `cloudflare-worker/src/valuation/manualStore.ts`

- [ ] **Step 1: Add date utilities and the upsert/delete/query helpers**

Append after the existing `appendManualSubmission` function:

```typescript
// All entries align to UTC midnight of their `entry_date`. This makes
// upsert-by-date trivially correct (same date string → same timestamp)
// and matches Glassnode's daily-resolution publishing cadence.
function dateToTimestamp(dateStr: string): number {
  // dateStr: "YYYY-MM-DD" → unix seconds at UTC midnight of that day
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const t = Math.floor(d.getTime() / 1000);
  if (!Number.isFinite(t)) {
    throw new Error(`[manualStore] invalid date: ${dateStr}`);
  }
  return t;
}

function timestampToDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Upsert N metrics for a specific date. Existing entries on the same
 * (date, metric) key are replaced in place. Other dates are untouched.
 * Pass `deletes` to remove specific metrics for that date in the same
 * round-trip.
 */
export async function upsertManualEntries(
  kv: KVNamespace,
  dateStr: string,
  values: Partial<ManualValues>,
  deletes: ManualMetricKey[] = [],
): Promise<void> {
  const ts = dateToTimestamp(dateStr);
  const history = await loadManualHistory(kv);

  for (const k of MANUAL_METRIC_KEYS) {
    const series = history[k];
    const sameDayIdx = series.findIndex((r) => r.timestamp === ts);

    if (deletes.includes(k)) {
      if (sameDayIdx !== -1) series.splice(sameDayIdx, 1);
      continue;
    }

    const v = values[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;

    if (sameDayIdx !== -1) {
      series[sameDayIdx] = { timestamp: ts, value: v };
    } else {
      series.push({ timestamp: ts, value: v });
      series.sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  await kv.put(MANUAL_KV_KEY, JSON.stringify(history));
}

/**
 * Return the value for each metric on a specific date, or null if absent.
 */
export async function getDayValues(
  kv: KVNamespace,
  dateStr: string,
): Promise<Record<ManualMetricKey, number | null>> {
  const ts = dateToTimestamp(dateStr);
  const history = await loadManualHistory(kv);
  const out: Partial<Record<ManualMetricKey, number | null>> = {};
  for (const k of MANUAL_METRIC_KEYS) {
    const hit = history[k].find((r) => r.timestamp === ts);
    out[k] = hit ? hit.value : null;
  }
  return out as Record<ManualMetricKey, number | null>;
}

/**
 * Return per-day completeness counts across the inclusive [from, to] range.
 * Days with zero entries are omitted; caller treats missing dates as 0/8.
 */
export async function getCalendarSummary(
  kv: KVNamespace,
  fromDateStr: string,
  toDateStr: string,
): Promise<Record<string, { filled: number; total: number }>> {
  const fromTs = dateToTimestamp(fromDateStr);
  const toTs = dateToTimestamp(toDateStr);
  if (fromTs > toTs) return {};

  const history = await loadManualHistory(kv);
  const counts = new Map<string, number>();
  for (const k of MANUAL_METRIC_KEYS) {
    for (const reading of history[k]) {
      if (reading.timestamp < fromTs || reading.timestamp > toTs) continue;
      const date = timestampToDate(reading.timestamp);
      counts.set(date, (counts.get(date) ?? 0) + 1);
    }
  }
  const out: Record<string, { filled: number; total: number }> = {};
  for (const [date, filled] of counts) {
    out[date] = { filled, total: MANUAL_METRIC_KEYS.length };
  }
  return out;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd cloudflare-worker && npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add cloudflare-worker/src/valuation/manualStore.ts
git commit -m "feat(worker/manualStore): add upsert/delete/query helpers for calendar"
```

### Task A2: Worker — extend `handleManualInput` to support upsert + delete

**Files:**
- Modify: `cloudflare-worker/src/handlers/manualInput.ts`

- [ ] **Step 1: Replace the body-parsing + persistence block**

Find the section starting `let parsed: { submitted_at?: string; values?: Partial<ManualValues> };` and replace it through the end of the function with:

```typescript
  let parsed: {
    submitted_at?: string;
    date?: string;          // NEW: "YYYY-MM-DD" — when present, route to upsert
    values?: Partial<ManualValues>;
    delete?: ManualMetricKey[];
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return deny(400, "invalid_json");
  }

  if (!parsed.submitted_at || typeof parsed.submitted_at !== "string") {
    return deny(400, "submitted_at_required");
  }

  // ── Calendar upsert/delete path (PR A) ──
  if (parsed.date && typeof parsed.date === "string") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
      return deny(400, "invalid_date_format");
    }
    const upserts: Partial<ManualValues> = {};
    if (parsed.values && typeof parsed.values === "object") {
      for (const k of MANUAL_METRIC_KEYS) {
        const v = (parsed.values as Partial<ManualValues>)[k];
        if (v === undefined) continue;
        if (typeof v !== "number" || !Number.isFinite(v)) {
          return deny(400, `invalid_value_for_${k}`);
        }
        upserts[k] = v;
      }
    }
    const deletes: ManualMetricKey[] = [];
    if (Array.isArray(parsed.delete)) {
      for (const k of parsed.delete) {
        if (!MANUAL_METRIC_KEYS.includes(k as ManualMetricKey)) {
          return deny(400, `invalid_delete_key_${k}`);
        }
        deletes.push(k as ManualMetricKey);
      }
    }
    if (Object.keys(upserts).length === 0 && deletes.length === 0) {
      return deny(400, "values_or_delete_required");
    }
    try {
      await upsertManualEntries(env.PRICES_CACHE, parsed.date, upserts, deletes);
    } catch (err) {
      console.error("[manualInput] upsert failed:", err instanceof Error ? err.message : err);
      return deny(503, "storage_failure");
    }
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ── Legacy append-by-now path ──
  if (!parsed.values || typeof parsed.values !== "object") {
    return deny(400, "values_required");
  }
  const values: Partial<ManualValues> = parsed.values;
  for (const k of MANUAL_METRIC_KEYS) {
    const v = values[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      return deny(400, `invalid_value_for_${k}`);
    }
  }
  try {
    await appendManualSubmission(env.PRICES_CACHE, parsed.submitted_at, values as ManualValues);
  } catch (err) {
    console.error("[manualInput] append failed:", err instanceof Error ? err.message : err);
    return deny(503, "storage_failure");
  }
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
```

- [ ] **Step 2: Add the new import at the top of the file**

Replace the existing import line:

```typescript
import { appendManualSubmission, MANUAL_METRIC_KEYS, type ManualValues } from "../valuation/manualStore";
```

with:

```typescript
import {
  appendManualSubmission,
  upsertManualEntries,
  MANUAL_METRIC_KEYS,
  type ManualMetricKey,
  type ManualValues,
} from "../valuation/manualStore";
```

- [ ] **Step 3: Verify typecheck**

Run: `cd cloudflare-worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add cloudflare-worker/src/handlers/manualInput.ts
git commit -m "feat(worker/manualInput): accept date+values+delete for calendar upsert"
```

### Task A3: Worker — new GET handlers for day + calendar

**Files:**
- Create: `cloudflare-worker/src/handlers/manualInputQuery.ts`
- Modify: `cloudflare-worker/src/index.ts`

- [ ] **Step 1: Create the query handler file**

Create `cloudflare-worker/src/handlers/manualInputQuery.ts`:

```typescript
import { CORS_HEADERS } from "../lib/cors";
import type { Env } from "../lib/types";
import { getCalendarSummary, getDayValues } from "../valuation/manualStore";

function deny(status: number, reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export async function handleManualInputDay(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return deny(400, "invalid_or_missing_date");
  }
  try {
    const metrics = await getDayValues(env.PRICES_CACHE, date);
    return ok({ date, metrics });
  } catch (err) {
    console.error("[manualInputQuery:day]", err instanceof Error ? err.message : err);
    return deny(503, "storage_failure");
  }
}

export async function handleManualInputCalendar(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return deny(400, "invalid_from");
  if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return deny(400, "invalid_to");
  try {
    const days = await getCalendarSummary(env.PRICES_CACHE, from, to);
    return ok({ from, to, days });
  } catch (err) {
    console.error("[manualInputQuery:calendar]", err instanceof Error ? err.message : err);
    return deny(503, "storage_failure");
  }
}
```

- [ ] **Step 2: Register the two new routes in `cloudflare-worker/src/index.ts`**

In the imports section, after `import { handleManualInput } from "./handlers/manualInput";`, add:

```typescript
import { handleManualInputCalendar, handleManualInputDay } from "./handlers/manualInputQuery";
```

In the route block, after the existing `/valuation/inputs` GET route (around line 57), add:

```typescript
    if (request.method === "GET" && url.pathname === "/valuation/manual/day") {
      return handleManualInputDay(request, env);
    }
    if (request.method === "GET" && url.pathname === "/valuation/manual/calendar") {
      return handleManualInputCalendar(request, env);
    }
```

- [ ] **Step 3: Update the route inventory comment block at the top of `index.ts`**

Add to the comment block (after the existing valuation routes):

```
//   GET  /valuation/manual/day      — Read all 8 metric values for a date (handlers/manualInputQuery.ts)
//   GET  /valuation/manual/calendar — Per-day completeness summary across a range (handlers/manualInputQuery.ts)
```

- [ ] **Step 4: Typecheck**

Run: `cd cloudflare-worker && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add cloudflare-worker/src/handlers/manualInputQuery.ts cloudflare-worker/src/index.ts
git commit -m "feat(worker): GET /valuation/manual/day and /calendar for calendar UI"
```

### Task A4: API — migration 035 for calendar-friendly schema

**Files:**
- Create: `app/api/src/db/migrations/035_valuation_manual_calendar.sql`

Note: SQLite migrations run automatically on API startup (per CLAUDE.md). The existing `valuation_manual_inputs` table is append-only; we need to add an `entry_date` column and unique constraint to make upsert-by-date efficient on the local audit store.

- [ ] **Step 1: Create the migration file**

Create `app/api/src/db/migrations/035_valuation_manual_calendar.sql`:

```sql
-- 035_valuation_manual_calendar.sql — adds entry_date + uniqueness for the
-- calendar-input feature. Without this, the API has to scan submitted_at to
-- find "the most recent entry for date D" which is O(N) per metric.
--
-- entry_date is the canonical "what date does this value represent" column;
-- submitted_at remains "when did the operator type it in" for audit. For
-- legacy rows (before this migration), entry_date is backfilled from the
-- UTC date of submitted_at — accurate for any row submitted same-day.

ALTER TABLE valuation_manual_inputs
  ADD COLUMN entry_date TEXT;

UPDATE valuation_manual_inputs
  SET entry_date = strftime('%Y-%m-%d', submitted_at, 'unixepoch')
  WHERE entry_date IS NULL;

CREATE INDEX IF NOT EXISTS idx_valuation_manual_inputs_entry_date
  ON valuation_manual_inputs (entry_date);

CREATE INDEX IF NOT EXISTS idx_valuation_manual_inputs_metric_date
  ON valuation_manual_inputs (metric_key, entry_date);
```

Note: We deliberately skip a UNIQUE constraint on `(metric_key, entry_date)`. Reasoning: the local store is an audit log — multiple rows for the same `(metric_key, entry_date)` are fine (each represents one operator action). The "current" value for a date is just the most-recent row by `submitted_at`. The Worker KV is the single source of truth for what the engine reads; it enforces the upsert semantics naturally.

- [ ] **Step 2: Verify migration loads on next API start**

Run: `cd app/api && npm run build`
Expected: build succeeds. Migrations are auto-discovered at runtime, no separate registration needed.

- [ ] **Step 3: Commit**

```bash
git add app/api/src/db/migrations/035_valuation_manual_calendar.sql
git commit -m "feat(api/db): migration 035 — entry_date column for calendar audit"
```

### Task A5: API — extend `manualInputStore.ts` with date-aware queries

**Files:**
- Modify: `app/api/src/valuation/manualInputStore.ts`

- [ ] **Step 1: Add date-aware helpers**

Append after the existing `updateSyncStatus` function:

```typescript
export interface DayValueRow {
  metric_key: ManualMetricKey;
  value: number;
  submitted_at: number;
  entry_date: string;
  worker_sync_status: "pending" | "confirmed" | "failed";
  worker_sync_error: string | null;
}

/**
 * Insert one row per (metric, date) representing an operator action.
 * Local store is append-only; the canonical "current value for the date"
 * is the most-recent row by submitted_at. The Worker KV is upserted
 * separately by the calling code.
 */
export function recordCalendarSubmission(
  db: Database.Database,
  entryDate: string,             // "YYYY-MM-DD"
  values: Partial<Record<ManualMetricKey, number>>,
  deletes: ManualMetricKey[],
  submittedAtUnix: number,
): { insertedIds: number[] } {
  const createdAt = Math.floor(Date.now() / 1000);
  const insertedIds: number[] = [];
  const insert = db.prepare(
    `INSERT INTO valuation_manual_inputs
       (metric_key, value, submitted_at, created_at, worker_sync_status, entry_date)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  );
  // Tombstone rows for deletes — value=NaN encoded as -1 with a sentinel
  // status. We keep them so audit can tell "operator deleted this on date X."
  // For the value column we use 0 with worker_sync_error = "deleted".
  const tombstone = db.prepare(
    `INSERT INTO valuation_manual_inputs
       (metric_key, value, submitted_at, created_at, worker_sync_status, entry_date, worker_sync_error)
     VALUES (?, 0, ?, ?, 'pending', ?, 'deleted')`,
  );
  const txn = db.transaction(() => {
    for (const key of MANUAL_METRIC_KEYS) {
      const v = values[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        const info = insert.run(key, v, submittedAtUnix, createdAt, entryDate);
        insertedIds.push(Number(info.lastInsertRowid));
      } else if (deletes.includes(key)) {
        const info = tombstone.run(key, submittedAtUnix, createdAt, entryDate);
        insertedIds.push(Number(info.lastInsertRowid));
      }
    }
  });
  txn();
  return { insertedIds };
}

/**
 * Return the most-recent row per metric for a specific entry_date.
 * Returns null per-metric if no row exists for that date or the latest
 * is a tombstone.
 */
export function listValuesForDay(
  db: Database.Database,
  entryDate: string,
): Record<ManualMetricKey, DayValueRow | null> {
  const rows = db.prepare(
    `SELECT metric_key, value, submitted_at, entry_date,
            worker_sync_status, worker_sync_error
     FROM valuation_manual_inputs v1
     WHERE entry_date = ?
       AND id = (
         SELECT id FROM valuation_manual_inputs v2
         WHERE v2.metric_key = v1.metric_key AND v2.entry_date = ?
         ORDER BY submitted_at DESC, id DESC LIMIT 1
       )`,
  ).all(entryDate, entryDate) as DayValueRow[];

  const out: Partial<Record<ManualMetricKey, DayValueRow | null>> = {};
  for (const k of MANUAL_METRIC_KEYS) out[k] = null;
  for (const row of rows) {
    if (row.worker_sync_error === "deleted") continue;
    out[row.metric_key] = row;
  }
  return out as Record<ManualMetricKey, DayValueRow | null>;
}

/**
 * Per-day completeness across [from, to]. Tombstones (deletes) reduce the
 * count for that day. Returns only days that have ≥1 non-deleted entry.
 */
export function summarizeDateRange(
  db: Database.Database,
  fromDate: string,
  toDate: string,
): Record<string, { filled: number; total: number }> {
  const rows = db.prepare(
    `SELECT entry_date, metric_key,
            (CASE WHEN worker_sync_error = 'deleted' THEN 0 ELSE 1 END) AS is_filled
     FROM valuation_manual_inputs v1
     WHERE entry_date >= ? AND entry_date <= ?
       AND id = (
         SELECT id FROM valuation_manual_inputs v2
         WHERE v2.metric_key = v1.metric_key AND v2.entry_date = v1.entry_date
         ORDER BY submitted_at DESC, id DESC LIMIT 1
       )`,
  ).all(fromDate, toDate) as Array<{ entry_date: string; metric_key: ManualMetricKey; is_filled: number }>;

  const out: Record<string, { filled: number; total: number }> = {};
  for (const r of rows) {
    if (r.is_filled !== 1) continue;
    if (!out[r.entry_date]) out[r.entry_date] = { filled: 0, total: MANUAL_METRIC_KEYS.length };
    out[r.entry_date].filled += 1;
  }
  return out;
}
```

- [ ] **Step 2: Typecheck the API**

Run: `cd app/api && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/api/src/valuation/manualInputStore.ts
git commit -m "feat(api/manualInputStore): add calendar upsert + day/range queries"
```

### Task A6: API — extend `workerClient.ts` to send unified upsert+delete shape

**Files:**
- Modify: `app/api/src/valuation/workerClient.ts`

- [ ] **Step 1: Replace the `SubmissionBody` type and add a new function**

Replace the existing `SubmissionBody` interface and `postManualInputToWorker` function with:

```typescript
export interface LegacySubmissionBody {
  submitted_at: string;
  values: Record<ManualMetricKey, number>;
}

export interface CalendarSubmissionBody {
  submitted_at: string;          // ISO; signed timestamp + audit
  date: string;                  // "YYYY-MM-DD" — what date the data represents
  values?: Partial<Record<ManualMetricKey, number>>;
  delete?: ManualMetricKey[];
}

export type SubmissionBody = LegacySubmissionBody | CalendarSubmissionBody;

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
 * Post any manual-input submission shape (legacy append or calendar
 * upsert/delete) to the Worker. Never throws — returns a structured result.
 */
export async function postManualInputToWorker(
  workerBaseUrl: string,
  hmacSecret: string,
  submission: SubmissionBody,
): Promise<WorkerPostResult> {
  const body = JSON.stringify(submission);
  const timestamp = submission.submitted_at;
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
    if (res.status === 204) return { ok: true, status: 204 };
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

- [ ] **Step 2: Typecheck**

Run: `cd app/api && npx tsc --noEmit`
Expected: exit 0 (other call sites use `postManualInputToWorker` which keeps its signature).

- [ ] **Step 3: Commit**

```bash
git add app/api/src/valuation/workerClient.ts
git commit -m "feat(api/workerClient): support calendar upsert+delete body shape"
```

### Task A7: API — extend `POST /api/valuation/manual` + add 2 new GET routes

**Files:**
- Modify: `app/api/src/index.ts`

- [ ] **Step 1: Add new imports at the top of the file**

Find the existing import line:

```typescript
import { MANUAL_METRIC_KEYS, recordSubmission, updateSyncStatus, listLatestPerMetric } from "./valuation/manualInputStore";
```

Replace with:

```typescript
import {
  MANUAL_METRIC_KEYS,
  recordSubmission,
  recordCalendarSubmission,
  listValuesForDay,
  summarizeDateRange,
  updateSyncStatus,
  listLatestPerMetric,
  type ManualMetricKey,
} from "./valuation/manualInputStore";
```

- [ ] **Step 2: Extend the POST handler at line ~303**

Replace the body of the `if (req.method === "POST" && req.url === "/api/valuation/manual")` handler (the section inside `req.on("end", async () => { ... })`) with this:

```typescript
      try {
        const parsed = JSON.parse(body || "{}");

        // ── Calendar mode: parsed.date present → upsert/delete for that date ──
        if (parsed?.date && typeof parsed.date === "string") {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.date)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_date_format" }));
            return;
          }
          // Reject future dates
          const todayUtc = new Date().toISOString().slice(0, 10);
          if (parsed.date > todayUtc) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "future_date_not_allowed" }));
            return;
          }

          const upserts: Partial<Record<ManualMetricKey, number>> = {};
          if (parsed.values && typeof parsed.values === "object") {
            for (const k of MANUAL_METRIC_KEYS) {
              const v = parsed.values[k];
              if (v === undefined) continue;
              if (typeof v !== "number" || !Number.isFinite(v)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `invalid_value_for_${k}` }));
                return;
              }
              upserts[k] = v;
            }
          }
          const deletes: ManualMetricKey[] = [];
          if (Array.isArray(parsed.delete)) {
            for (const k of parsed.delete) {
              if (!MANUAL_METRIC_KEYS.includes(k as ManualMetricKey)) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: `invalid_delete_key_${k}` }));
                return;
              }
              deletes.push(k as ManualMetricKey);
            }
          }
          if (Object.keys(upserts).length === 0 && deletes.length === 0) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "values_or_delete_required" }));
            return;
          }

          const submittedAtISO = new Date().toISOString();
          const submittedAtUnix = Math.floor(Date.parse(submittedAtISO) / 1000);

          // 1. Local audit row(s)
          const record = recordCalendarSubmission(db, parsed.date, upserts, deletes, submittedAtUnix);

          // 2. Forward to Worker (unified shape)
          const workerResult = await postManualInputToWorker(
            ENV.valuationWorkerUrl,
            ENV.valuationSubmitHmac,
            { submitted_at: submittedAtISO, date: parsed.date, values: upserts, delete: deletes },
          );

          // 3. Update sync status on the local rows we just inserted
          updateSyncStatus(
            db,
            record.insertedIds,
            workerResult.ok ? "confirmed" : "failed",
            workerResult.ok ? undefined : `status=${workerResult.status} error=${workerResult.error ?? ""}`,
          );

          if (workerResult.ok) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, date: parsed.date, submitted_at: submittedAtISO }));
          } else {
            res.writeHead(207, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              ok: false,
              date: parsed.date,
              local_saved: true,
              submitted_at: submittedAtISO,
              worker_error: workerResult.error ?? null,
              worker_status: workerResult.status,
            }));
          }
          return;
        }

        // ── Legacy mode: no date field, all 8 values required, append-by-now ──
        const values = parsed?.values;
        if (!values || typeof values !== "object") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "values_required" }));
          return;
        }
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

        const record = recordSubmission(db, values, submittedAtUnix);
        const workerResult = await postManualInputToWorker(
          ENV.valuationWorkerUrl,
          ENV.valuationSubmitHmac,
          { submitted_at: submittedAtISO, values },
        );
        updateSyncStatus(
          db,
          record.insertedIds,
          workerResult.ok ? "confirmed" : "failed",
          workerResult.ok ? undefined : `status=${workerResult.status} error=${workerResult.error ?? ""}`,
        );

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
      } catch (err: any) {
        console.error("[valuation-manual]", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
```

- [ ] **Step 3: Add the `GET /api/valuation/manual/day` route**

Add this block immediately after the existing `if (req.method === "GET" && req.url === "/api/valuation/manual/status")` handler block (around line 379+):

```typescript
  if (req.method === "GET" && req.url?.startsWith("/api/valuation/manual/day")) {
    const node = getNodeInfo();
    try { assertTreasury(node?.node_role); } catch (err: any) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
      return;
    }
    try {
      const u = new URL(req.url, "http://localhost");
      const date = u.searchParams.get("date");
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_or_missing_date" }));
        return;
      }
      const rows = listValuesForDay(db, date);
      const metrics: Record<string, unknown> = {};
      for (const k of MANUAL_METRIC_KEYS) {
        const r = rows[k];
        metrics[k] = r ? {
          value: r.value,
          submitted_at: r.submitted_at,
          worker_sync_status: r.worker_sync_status,
        } : { value: null, submitted_at: null, worker_sync_status: null };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ date, metrics }));
    } catch (err: any) {
      console.error("[valuation-manual:day]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    }
    return;
  }

  if (req.method === "GET" && req.url?.startsWith("/api/valuation/manual/calendar")) {
    const node = getNodeInfo();
    try { assertTreasury(node?.node_role); } catch (err: any) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err?.message }));
      return;
    }
    try {
      const u = new URL(req.url, "http://localhost");
      const from = u.searchParams.get("from");
      const to = u.searchParams.get("to");
      if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_from" }));
        return;
      }
      if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_to" }));
        return;
      }
      const days = summarizeDateRange(db, from, to);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ from, to, days }));
    } catch (err: any) {
      console.error("[valuation-manual:calendar]", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error" }));
    }
    return;
  }
```

- [ ] **Step 4: Build the API**

Run: `cd app/api && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add app/api/src/index.ts
git commit -m "feat(api): calendar upsert/delete + GET day/calendar routes"
```

### Task A8: Smoke test PR A end-to-end

**Files:** None. Manual verification.

- [ ] **Step 1: Start the API in a worktree against a clean DB (or local dev DB)**

Run: `cd app/api && npm run build && npm start`
Expected: server listens on 3101.

- [ ] **Step 2: Test the legacy POST still works**

Run from another shell:
```bash
curl -s -X POST http://localhost:3101/api/valuation/manual \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TREASURY_JWT>" \
  -d '{"values":{"mvrv":1.4,"puell":0.5,"sopr":1.01,"reserve_risk":0.005,"nvt":50,"hash_ribbons":1.0,"difficulty_ribbon":0.02,"hodl_waves":0.15}}'
```
Expected: `200 {"ok":true, ...}`. Existing flat-form callers continue to work.

- [ ] **Step 3: Test the new calendar upsert**

```bash
curl -s -X POST http://localhost:3101/api/valuation/manual \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TREASURY_JWT>" \
  -d '{"date":"2026-04-25","values":{"mvrv":1.50}}'
```
Expected: `200 {"ok":true, "date":"2026-04-25", ...}`.

- [ ] **Step 4: Test future-date rejection**

```bash
curl -s -X POST http://localhost:3101/api/valuation/manual \
  -H "Authorization: Bearer <TREASURY_JWT>" \
  -d '{"date":"2099-01-01","values":{"mvrv":1.0}}'
```
Expected: `400 {"error":"future_date_not_allowed"}`.

- [ ] **Step 5: Test the new day-query**

```bash
curl -s "http://localhost:3101/api/valuation/manual/day?date=2026-04-25" \
  -H "Authorization: Bearer <TREASURY_JWT>"
```
Expected: `200 {"date":"2026-04-25","metrics":{"mvrv":{"value":1.5,...},"puell":{"value":null,...},...}}`.

- [ ] **Step 6: Test the new calendar-summary**

```bash
curl -s "http://localhost:3101/api/valuation/manual/calendar?from=2026-04-01&to=2026-04-30" \
  -H "Authorization: Bearer <TREASURY_JWT>"
```
Expected: `200 {"from":"2026-04-01","to":"2026-04-30","days":{"2026-04-25":{"filled":1,"total":8},...}}`.

- [ ] **Step 7: Test delete**

```bash
curl -s -X POST http://localhost:3101/api/valuation/manual \
  -H "Authorization: Bearer <TREASURY_JWT>" \
  -d '{"date":"2026-04-25","delete":["mvrv"]}'
```
Expected: `200 {"ok":true, "date":"2026-04-25", ...}`. Then re-query the day; `mvrv.value` should be `null`.

### Task A9: Open PR A

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feature/calendar-backend
```

- [ ] **Step 2: Open the PR**

Title: `feat(valuation): backend foundation for calendar input UI`

Body should describe: additive changes (existing flat form unchanged), new `date` field on POST, new GET endpoints for day + calendar, migration 035 for entry_date, all wired through the existing HMAC pipeline.

---

# PR B — Calendar UI

**Branch:** `feature/calendar-ui` (off the post-merge main once PR A lands)

This PR replaces the existing flat form on `/valuation-input` with the year/month/day calendar.

### Task B1: API client wrappers

**Files:**
- Modify: `app/web/src/api/client.ts`

- [ ] **Step 1: Add types for the new endpoints**

Find the existing types around the manual-input client functions and add:

```typescript
export interface DayMetricStatus {
  value: number | null;
  submitted_at: number | null;
  worker_sync_status: "pending" | "confirmed" | "failed" | null;
}

export interface DayValues {
  date: string;
  metrics: Record<ManualMetricKey, DayMetricStatus>;
}

export interface CalendarSummary {
  from: string;
  to: string;
  days: Record<string, { filled: number; total: number }>;
}

export interface DaySubmitRequest {
  date: string;
  values?: Partial<Record<ManualMetricKey, number>>;
  delete?: ManualMetricKey[];
}

export interface DaySubmitResponse {
  ok: boolean;
  date: string;
  submitted_at: string;
  local_saved?: boolean;
  worker_error?: string | null;
  worker_status?: number;
}
```

- [ ] **Step 2: Add three client methods**

In the `api` object, after `submitValuationInputs`, add:

```typescript
  getValuationDay: (date: string): Promise<DayValues> =>
    apiCall(`/api/valuation/manual/day?date=${encodeURIComponent(date)}`),

  getValuationCalendar: (from: string, to: string): Promise<CalendarSummary> =>
    apiCall(`/api/valuation/manual/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  submitValuationDay: (req: DaySubmitRequest): Promise<DaySubmitResponse> =>
    apiCall("/api/valuation/manual", { method: "POST", body: JSON.stringify(req) }),
```

(Use whatever `apiCall` helper the file already uses; keep convention identical to `submitValuationInputs`.)

- [ ] **Step 3: Build the web app**

Run: `cd app/web && npx vite build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/api/client.ts
git commit -m "feat(web/client): add getValuationDay, getValuationCalendar, submitValuationDay"
```

### Task B2: `YearHeatmap.tsx`

**Files:**
- Create: `app/web/src/components/valuation/YearHeatmap.tsx`

- [ ] **Step 1: Create the component**

```typescript
import { useEffect, useMemo, useState } from "react";
import { api, type CalendarSummary } from "../../api/client";

interface Props {
  year: number;
  onSelectMonth: (year: number, month: number) => void;
  onPrevYear: () => void;
  onNextYear: () => void;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

function colorForCompleteness(filled: number): string {
  // 8/8 -> full, gradient down to 0
  if (filled === 0) return "var(--surface-2)";
  if (filled >= 8) return "#22c55e";
  if (filled >= 6) return "#84cc16";
  if (filled >= 4) return "#facc15";
  if (filled >= 1) return "#fbbf24";
  return "var(--surface-2)";
}

export default function YearHeatmap({ year, onSelectMonth, onPrevYear, onNextYear }: Props) {
  const [summary, setSummary] = useState<CalendarSummary | null>(null);
  const todayUtc = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    api.getValuationCalendar(from, to)
      .then(setSummary)
      .catch((err) => console.error("[YearHeatmap]", err));
  }, [year]);

  // Build a 12-row × 31-col grid (rows = months, cols = day-of-month)
  const cells = useMemo(() => {
    const rows: Array<Array<{ date: string; filled: number; isFuture: boolean; exists: boolean }>> = [];
    for (let m = 0; m < 12; m++) {
      const row: typeof rows[number] = [];
      const daysInMonth = new Date(year, m + 1, 0).getDate();
      for (let d = 1; d <= 31; d++) {
        if (d > daysInMonth) {
          row.push({ date: "", filled: 0, isFuture: false, exists: false });
          continue;
        }
        const dateStr = isoDate(year, m, d);
        const cell = summary?.days[dateStr];
        row.push({
          date: dateStr,
          filled: cell?.filled ?? 0,
          isFuture: dateStr > todayUtc,
          exists: true,
        });
      }
      rows.push(row);
    }
    return rows;
  }, [year, summary, todayUtc]);

  const monthLabels = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button
          onClick={onPrevYear}
          style={{ background: "none", border: "1px solid var(--border)", padding: "4px 10px", cursor: "pointer", color: "var(--text-2)" }}
        >
          ← {year - 1}
        </button>
        <div style={{ fontSize: "1.125rem", fontWeight: 600 }}>{year}</div>
        <button
          onClick={onNextYear}
          style={{ background: "none", border: "1px solid var(--border)", padding: "4px 10px", cursor: "pointer", color: "var(--text-2)" }}
        >
          {year + 1} →
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 8 }}>
        {cells.map((row, mIdx) => (
          <div key={mIdx} style={{ display: "contents" }}>
            <button
              onClick={() => onSelectMonth(year, mIdx)}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-2)",
                fontSize: "0.8125rem",
                textAlign: "right",
                paddingRight: 8,
                cursor: "pointer",
              }}
            >
              {monthLabels[mIdx]}
            </button>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(31, 1fr)", gap: 2 }}>
              {row.map((cell, dIdx) => (
                <div
                  key={dIdx}
                  title={cell.exists ? `${cell.date}: ${cell.filled}/8` : ""}
                  onClick={() => cell.exists && !cell.isFuture && onSelectMonth(year, mIdx)}
                  style={{
                    width: "100%",
                    aspectRatio: "1",
                    background: cell.exists
                      ? (cell.isFuture ? "transparent" : colorForCompleteness(cell.filled))
                      : "transparent",
                    border: cell.exists && !cell.isFuture ? "1px solid var(--border)" : "1px solid transparent",
                    borderRadius: 2,
                    cursor: cell.exists && !cell.isFuture ? "pointer" : "default",
                    opacity: cell.isFuture ? 0.3 : 1,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, display: "flex", gap: 12, fontSize: "0.75rem", color: "var(--text-3)" }}>
        <span>Empty</span>
        <span style={{ color: "#fbbf24" }}>1–3</span>
        <span style={{ color: "#facc15" }}>4–5</span>
        <span style={{ color: "#84cc16" }}>6–7</span>
        <span style={{ color: "#22c55e" }}>8/8</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd app/web && npx vite build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/components/valuation/YearHeatmap.tsx
git commit -m "feat(web/valuation): YearHeatmap component"
```

### Task B3: `MonthGrid.tsx`

**Files:**
- Create: `app/web/src/components/valuation/MonthGrid.tsx`

- [ ] **Step 1: Create the component**

```typescript
import { useEffect, useMemo, useState } from "react";
import { api, type CalendarSummary } from "../../api/client";

interface Props {
  year: number;
  month: number; // 0-11
  onSelectDay: (date: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onZoomToYear: () => void;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function colorForCompleteness(filled: number): string {
  if (filled === 0) return "var(--surface-2)";
  if (filled >= 8) return "rgba(34,197,94,0.25)";
  if (filled >= 6) return "rgba(132,204,22,0.25)";
  if (filled >= 4) return "rgba(250,204,21,0.25)";
  return "rgba(251,191,36,0.25)";
}

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW_LABELS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

export default function MonthGrid({ year, month, onSelectDay, onPrevMonth, onNextMonth, onZoomToYear }: Props) {
  const [summary, setSummary] = useState<CalendarSummary | null>(null);
  const todayUtc = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    const from = `${year}-${pad2(month + 1)}-01`;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const to = `${year}-${pad2(month + 1)}-${pad2(lastDay)}`;
    api.getValuationCalendar(from, to)
      .then(setSummary)
      .catch((err) => console.error("[MonthGrid]", err));
  }, [year, month]);

  const cells = useMemo(() => {
    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: Array<{ date: string; day: number; filled: number; isFuture: boolean; exists: boolean }> = [];
    for (let i = 0; i < firstDow; i++) out.push({ date: "", day: 0, filled: 0, isFuture: false, exists: false });
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${pad2(month + 1)}-${pad2(d)}`;
      out.push({
        date: dateStr,
        day: d,
        filled: summary?.days[dateStr]?.filled ?? 0,
        isFuture: dateStr > todayUtc,
        exists: true,
      });
    }
    while (out.length % 7 !== 0) out.push({ date: "", day: 0, filled: 0, isFuture: false, exists: false });
    return out;
  }, [year, month, summary, todayUtc]);

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <button onClick={onPrevMonth} style={{ background: "none", border: "1px solid var(--border)", padding: "4px 10px", cursor: "pointer", color: "var(--text-2)" }}>← Prev</button>
        <button onClick={onZoomToYear} style={{ background: "none", border: "none", fontSize: "1.125rem", fontWeight: 600, color: "var(--text-1)", cursor: "pointer" }}>
          {MONTH_NAMES[month]} {year}
        </button>
        <button onClick={onNextMonth} style={{ background: "none", border: "1px solid var(--border)", padding: "4px 10px", cursor: "pointer", color: "var(--text-2)" }}>Next →</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4, marginBottom: 4 }}>
        {DOW_LABELS.map((d) => (
          <div key={d} style={{ textAlign: "center", fontSize: "0.75rem", color: "var(--text-3)" }}>{d}</div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {cells.map((cell, idx) => (
          <button
            key={idx}
            disabled={!cell.exists || cell.isFuture}
            onClick={() => cell.exists && !cell.isFuture && onSelectDay(cell.date)}
            style={{
              aspectRatio: "1",
              background: cell.exists && !cell.isFuture ? colorForCompleteness(cell.filled) : "transparent",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: 4,
              cursor: cell.exists && !cell.isFuture ? "pointer" : "default",
              opacity: cell.exists ? (cell.isFuture ? 0.3 : 1) : 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              justifyContent: "space-between",
              color: "var(--text-1)",
              fontSize: "0.8125rem",
            }}
          >
            <span>{cell.exists ? cell.day : ""}</span>
            {cell.exists && !cell.isFuture && (
              <span style={{ fontSize: "0.625rem", color: "var(--text-3)", alignSelf: "flex-end" }}>
                {cell.filled > 0 ? `${cell.filled}/8` : "—"}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify build**

Run: `cd app/web && npx vite build`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add app/web/src/components/valuation/MonthGrid.tsx
git commit -m "feat(web/valuation): MonthGrid component"
```

### Task B4: `DayForm.tsx`

**Files:**
- Create: `app/web/src/components/valuation/DayForm.tsx`

- [ ] **Step 1: Create the component**

This component renders the existing 8-metric form, scoped to a date. It pre-populates from `getValuationDay`, supports per-metric save and delete, and a "Save All" for the day.

```typescript
import { useEffect, useState } from "react";
import { api, type DayValues, type ManualMetricKey } from "../../api/client";

// Same metric metadata as the existing flat form. We intentionally re-declare
// rather than import from ValuationInput.tsx so this component has zero
// coupling to the old page during the migration.
interface MetricConfig {
  key: ManualMetricKey;
  label: string;
  description: string;
  chartUrl: string;
  typicalRange: string;
  decimals: number;
  tier: "free" | "paid" | "missing";
  tierNote: string;
}

const METRICS: MetricConfig[] = [
  // ... copy from ValuationInput.tsx (the post-PR-#137 array)
];

interface Props {
  date: string;       // "YYYY-MM-DD"
  onSaved: () => void;
}

export default function DayForm({ date, onSaved }: Props) {
  const [day, setDay] = useState<DayValues | null>(null);
  const [inputs, setInputs] = useState<Record<ManualMetricKey, string>>(() =>
    METRICS.reduce((acc, m) => ({ ...acc, [m.key]: "" }), {} as Record<ManualMetricKey, string>),
  );
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error" | "partial"; msg: string } | null>(null);

  const refresh = () => {
    api.getValuationDay(date)
      .then((d) => {
        setDay(d);
        const next: Record<ManualMetricKey, string> = {} as Record<ManualMetricKey, string>;
        for (const m of METRICS) {
          const v = d.metrics[m.key]?.value;
          next[m.key] = v == null ? "" : String(v);
        }
        setInputs(next);
      })
      .catch((err) => console.error("[DayForm]", err));
  };

  useEffect(refresh, [date]);

  const submit = async (req: { values?: Partial<Record<ManualMetricKey, number>>; delete?: ManualMetricKey[] }) => {
    setBusy(true);
    setToast(null);
    try {
      const res = await api.submitValuationDay({ date, ...req });
      if (res.ok) setToast({ kind: "success", msg: "Saved" });
      else setToast({ kind: "partial", msg: `Local saved, Worker failed: ${res.worker_error ?? "unknown"}` });
      refresh();
      onSaved();
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const saveAll = () => {
    const values: Partial<Record<ManualMetricKey, number>> = {};
    for (const m of METRICS) {
      const raw = inputs[m.key];
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        setToast({ kind: "error", msg: `Invalid number for ${m.label}` });
        return;
      }
      // Only include in the submit if the value differs from what's currently saved
      const existing = day?.metrics[m.key]?.value;
      if (existing === n) continue;
      values[m.key] = n;
    }
    if (Object.keys(values).length === 0) {
      setToast({ kind: "error", msg: "No changes to save" });
      return;
    }
    submit({ values });
  };

  const saveOne = (m: MetricConfig) => {
    const raw = inputs[m.key];
    if (raw === "") {
      setToast({ kind: "error", msg: `${m.label}: enter a value first` });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setToast({ kind: "error", msg: `Invalid number for ${m.label}` });
      return;
    }
    submit({ values: { [m.key]: n } as Partial<Record<ManualMetricKey, number>> });
  };

  const deleteOne = (m: MetricConfig) => {
    if (!confirm(`Delete ${m.label} for ${date}?`)) return;
    submit({ delete: [m.key] });
  };

  return (
    <div>
      <div style={{ marginBottom: 16, fontSize: "0.875rem", color: "var(--text-2)" }}>
        Entries for <strong>{date}</strong>. Editing any value upserts (replaces) the existing entry for that day.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {METRICS.map((m) => {
          const status = day?.metrics[m.key];
          const existing = status?.value;
          return (
            <div key={m.key} className="panel" style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 8rem auto auto",
              gap: 12,
              alignItems: "center",
              padding: "10px 14px",
            }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>{m.label}</div>
                <div style={{ color: "var(--text-3)", fontSize: "0.75rem", marginTop: 2 }}>
                  range: {m.typicalRange} ·{" "}
                  <a href={m.chartUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>chart ↗</a>
                </div>
              </div>
              <div style={{ textAlign: "right", fontSize: "0.8125rem", color: "var(--text-3)" }}>
                {existing != null ? `current: ${existing.toFixed(m.decimals)}` : "no entry"}
              </div>
              <input
                type="number"
                step="any"
                value={inputs[m.key]}
                onChange={(e) => setInputs({ ...inputs, [m.key]: e.target.value })}
                placeholder={existing != null ? String(existing) : "—"}
                disabled={busy}
                style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "right" }}
              />
              <button onClick={() => saveOne(m)} disabled={busy} style={{ padding: "4px 10px" }}>Save</button>
              <button
                onClick={() => deleteOne(m)}
                disabled={busy || existing == null}
                style={{ padding: "4px 10px", color: existing != null ? "var(--red)" : "var(--text-3)" }}
                title={existing == null ? "Nothing to delete" : "Delete this entry"}
              >
                Delete
              </button>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 16 }}>
        {toast && (
          <span style={{ fontSize: "0.8125rem", color: toast.kind === "success" ? "#22c55e" : toast.kind === "partial" ? "#fbbf24" : "#ef4444" }}>
            {toast.msg}
          </span>
        )}
        <button onClick={saveAll} disabled={busy} className="btn btn-primary">Save All Changes</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Copy METRICS array from ValuationInput.tsx into DayForm**

Open `app/web/src/pages/ValuationInput.tsx` and copy the `METRICS` array from the post-PR-#137 state into the placeholder spot in `DayForm.tsx`. The shape is identical.

- [ ] **Step 3: Build**

Run: `cd app/web && npx vite build`
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add app/web/src/components/valuation/DayForm.tsx
git commit -m "feat(web/valuation): DayForm component for per-date entry"
```

### Task B5: Refactor `ValuationInput.tsx` to be a calendar shell

**Files:**
- Modify: `app/web/src/pages/ValuationInput.tsx`

- [ ] **Step 1: Replace the page contents**

Replace the entire file content with:

```typescript
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import YearHeatmap from "../components/valuation/YearHeatmap";
import MonthGrid from "../components/valuation/MonthGrid";
import DayForm from "../components/valuation/DayForm";
import InputsTab from "../components/autoBuy/InputsTab";

type View = "year" | "month" | "day";

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function todayUtcParts(): { year: number; month: number; date: string } {
  const d = todayUtcDate();
  const [y, m] = d.split("-").map(Number);
  return { year: y, month: m - 1, date: d };
}

export default function ValuationInput() {
  const [searchParams, setSearchParams] = useSearchParams();
  const today = todayUtcParts();

  // Resolve initial view from URL params
  const initialDate = searchParams.get("date");
  const initialView = (searchParams.get("view") as View) || (initialDate ? "day" : "day");
  const [view, setView] = useState<View>(initialView);
  const [year, setYear] = useState<number>(() => {
    if (initialDate) return Number(initialDate.split("-")[0]);
    return today.year;
  });
  const [month, setMonth] = useState<number>(() => {
    if (initialDate) return Number(initialDate.split("-")[1]) - 1;
    return today.month;
  });
  const [date, setDate] = useState<string>(initialDate ?? today.date);

  // Sync state to URL
  useEffect(() => {
    const next: Record<string, string> = { view };
    if (view === "day") next.date = date;
    if (view === "month") next.date = `${year}-${String(month + 1).padStart(2, "0")}-01`;
    if (view === "year") next.date = `${year}-01-01`;
    setSearchParams(next, { replace: true });
  }, [view, year, month, date, setSearchParams]);

  const goToday = () => {
    const t = todayUtcParts();
    setYear(t.year);
    setMonth(t.month);
    setDate(t.date);
    setView("day");
  };

  return (
    <div className="page">
      <div className="page-header" style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ margin: 0 }}>Daily Valuation Inputs</h1>
          <p style={{ color: "var(--text-3)", fontSize: "0.875rem", marginTop: 4 }}>
            Browse the calendar to add, edit, or audit Glassnode metric entries by date.
          </p>
        </div>
        <button onClick={goToday} className="btn">Today</button>
      </div>

      {/* Breadcrumb */}
      <div style={{ marginBottom: 12, fontSize: "0.875rem", color: "var(--text-2)" }}>
        <button onClick={() => setView("year")} style={{ background: "none", border: "none", color: view === "year" ? "var(--text-1)" : "var(--accent)", cursor: "pointer", padding: 0, fontWeight: view === "year" ? 600 : 400 }}>{year}</button>
        {(view === "month" || view === "day") && (
          <>
            <span style={{ color: "var(--text-3)", margin: "0 6px" }}>›</span>
            <button onClick={() => setView("month")} style={{ background: "none", border: "none", color: view === "month" ? "var(--text-1)" : "var(--accent)", cursor: "pointer", padding: 0, fontWeight: view === "month" ? 600 : 400 }}>
              {new Date(year, month, 1).toLocaleString("en-US", { month: "long" })}
            </button>
          </>
        )}
        {view === "day" && (
          <>
            <span style={{ color: "var(--text-3)", margin: "0 6px" }}>›</span>
            <span style={{ color: "var(--text-1)", fontWeight: 600 }}>{date.split("-")[2]}</span>
          </>
        )}
      </div>

      {view === "year" && (
        <YearHeatmap
          year={year}
          onSelectMonth={(y, m) => { setYear(y); setMonth(m); setView("month"); }}
          onPrevYear={() => setYear((y) => y - 1)}
          onNextYear={() => setYear((y) => Math.min(y + 1, today.year))}
        />
      )}

      {view === "month" && (
        <MonthGrid
          year={year}
          month={month}
          onSelectDay={(d) => { setDate(d); setView("day"); }}
          onPrevMonth={() => {
            if (month === 0) { setYear(year - 1); setMonth(11); }
            else setMonth(month - 1);
          }}
          onNextMonth={() => {
            // Don't allow advancing past current month
            const isCurrent = year === today.year && month === today.month;
            if (isCurrent) return;
            if (month === 11) { setYear(year + 1); setMonth(0); }
            else setMonth(month + 1);
          }}
          onZoomToYear={() => setView("year")}
        />
      )}

      {view === "day" && (
        <DayForm date={date} onSaved={() => { /* no-op; DayForm refreshes itself */ }} />
      )}

      {/* Composite Model Inputs — read-only view of all 12 inputs */}
      <div style={{ marginTop: 48 }}>
        <h2 style={{ marginBottom: 16 }}>Composite Model Inputs</h2>
        <InputsTab />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify the legacy `submitValuationInputs` and `getValuationInputStatus` calls aren't being used elsewhere**

Run: `grep -rn "submitValuationInputs\|getValuationInputStatus" app/web/src`
Expected: zero hits (or hits only inside `client.ts` definitions). If references exist outside those, delete them or migrate to the new API.

- [ ] **Step 3: Build the web app**

Run: `cd app/web && npx vite build`
Expected: success.

- [ ] **Step 4: Smoke test in dev**

Run: `cd app/web && npm run dev`
Expected: Vite dev server starts.

Open `http://localhost:5173/valuation-input`. Verify:
- Page loads in day view scoped to today
- Breadcrumb shows current year › month › day
- Clicking year in breadcrumb shows year heatmap
- Clicking month in breadcrumb shows month grid
- Clicking a day cell drops to day form
- Today button always returns to today
- Future dates are disabled (greyed, non-clickable) in both year and month views

- [ ] **Step 5: Commit**

```bash
git add app/web/src/pages/ValuationInput.tsx
git commit -m "feat(web/valuation): replace flat form with year/month/day calendar shell"
```

### Task B6: Smoke test PR B end-to-end

**Files:** None. Manual verification.

- [ ] **Step 1: Sideload on Umbrel after merge**

Bump `umbrel-app.yml` and `docker-compose.yml` to v1.13.12, push to main, wait for GHA build.

- [ ] **Step 2: On the treasury node, walk the calendar**

- Visit `/valuation-input`
- Year view → click any prior month → drops to month view
- Month view → click a day with data → drops to day view, values pre-populated
- Edit one value → click Save (per-metric) → toast: success
- Click chart link → confirm Glassnode opens
- Edit two values → click Save All Changes → toast: success
- Delete an entry → confirm dialog → click OK → entry shows "no entry" in current row
- Navigate to April 27 (the dummy data day) → edit and save the corrected values

- [ ] **Step 3: Verify Worker KV reflects the changes**

After a full edit cycle, the next valuation engine cron tick (`15 0 * * *`) should publish a fresh composite using the corrected values. Use `curl https://bitcorn-onramp.ethancail.workers.dev/valuation/inputs` to verify the snapshot includes the updated values.

### Task B7: Open PR B

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feature/calendar-ui
```

- [ ] **Step 2: Open the PR**

Title: `feat(web/valuation): year/month/day calendar UI replaces flat form (v1.13.12)`

Body should describe: the calendar replaces the flat form, the URL state (`?view=...&date=...`) makes deep links work, future dates disabled, per-metric + Save All semantics, breadcrumb + Today button.

---

# PR C — Polish (optional)

**Branch:** `feature/calendar-polish`

This PR can be skipped if Cael is happy with the v1 calendar. Lands outlier warnings and "vs. last entry" inline display.

### Task C1: Outlier warning in `DayForm`

**Files:**
- Modify: `app/web/src/components/valuation/DayForm.tsx`

- [ ] **Step 1: Add an outlier-detection helper and inline display**

Right above the input field for each metric, add a small badge:

```typescript
function detectOutlier(value: number, typicalRange: string): { warn: boolean; message: string } {
  // typicalRange is "0.97 to 1.05" or "−0.5 to +10" — parse loosely
  const match = typicalRange.match(/(-?\d+\.?\d*)\s*to\s*\+?(-?\d+\.?\d*)/);
  if (!match) return { warn: false, message: "" };
  const lo = Number(match[1]);
  const hi = Number(match[2]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { warn: false, message: "" };
  if (value < lo) return { warn: true, message: `below typical range (${lo})` };
  if (value > hi) return { warn: true, message: `above typical range (${hi})` };
  return { warn: false, message: "" };
}
```

Then, for each metric row, after the input, render:

```typescript
{(() => {
  const raw = inputs[m.key];
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const o = detectOutlier(n, m.typicalRange);
  if (!o.warn) return null;
  return <span style={{ fontSize: "0.75rem", color: "#fbbf24" }}>⚠ {o.message}</span>;
})()}
```

- [ ] **Step 2: Add "vs. last entry" delta display**

Where the current value is shown (`current: 1.234`), append a `+X% vs prev` if there's a prior non-current entry. This requires a small extension to the `getValuationDay` API to also return the previous entry per metric, OR a separate `getValuationLastEntry(metric)` call. Skip if scope creeps.

- [ ] **Step 3: Build + commit**

```bash
cd app/web && npx vite build
git add app/web/src/components/valuation/DayForm.tsx
git commit -m "feat(web/valuation): outlier warnings on day form inputs"
```

### Task C2: Open PR C

- [ ] **Step 1: Push + open PR with title `feat(web/valuation): outlier warnings + UX polish`**

---

## Self-Review Checklist

- [x] **Spec coverage:** All locked-in design decisions covered: calendar replaces form, year/month/day views, full Jan–Dec single page year view with arrows, both per-metric + Save All buttons, future dates disabled, outlier warnings (PR C), schema = upsert-by-date single-timestamp.
- [x] **No placeholders:** Every step has actual code or actual command. Only the METRICS array copy in Task B4 says "copy from existing file" — that's deliberate (the array is already in the codebase post-PR #137; no need to repeat 8 lines of metadata in the plan).
- [x] **Type consistency:** `ManualMetricKey`, `ManualValues`, `DayValues`, `CalendarSummary`, `DaySubmitRequest` defined in API client, used consistently downstream. `upsertManualEntries`, `getDayValues`, `getCalendarSummary` exported from Worker `manualStore.ts` and consumed by handlers.
- [x] **HMAC signing path preserved:** All Worker writes go through the existing `VALUATION_SUBMIT_HMAC` pipeline. New GET routes don't require HMAC (they're read-only).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-28-valuation-calendar-input.md`.
