// Client for the Worker's GET /daybreak/edition — the Daybreak member read
// (spec §3.4.2). Used by the member-reachable proxy GET /api/daybreak/edition.
//
// Worker-side: subscriber-base scope — any valid entitlement token, payment or
// full. Routes through workerFetch(), which attaches this node's own cached
// token and retries once on a 401 expired/bad_signature.
//
// ─── IT KEEPS THE REASON (ruled 2026-09-24) ─────────────────────────────
//
// Discriminated like autoBuy/valuationClient.ts (which is another arc's and is
// neither imported nor edited here), with the one difference the ruling names:
// valuationClient folds every non-401/403 failure into `upstream_error`, which
// drops the Worker's own 503 reason. Here a Worker 503 carrying a reason code is
// its own outcome, and the code travels to the member. And it is not the
// /api/commodity-prices pattern, which collapses every non-OK into one 502.
//
//   auth_missing        Worker 401 `missing` — this node holds no token.
//   auth_invalid        any other Worker 401 (expired, bad_signature, …) that
//                       survived workerFetch's one refresh-and-retry.
//   scope_insufficient  Worker 403 `scope_insufficient`.
//   worker_unavailable  Worker 503 with a reason CODE — e.g. its own
//                       `daybreak_read_failed`, or `service_unconfigured`.
//   upstream_error      any other non-OK, with its status. Includes a 503 whose
//                       `error` is not a code, and a 403 that is not the gate's.
//   invalid_worker_response  a 200 whose body is not JSON.
//   worker_unreachable  network failure reaching the Worker.
//   worker_not_configured   COINBASE_WORKER_URL unset on this node.
//
// CODES ONLY: no Worker `detail` and no transport message is carried in a
// result. Both go to the log. No cache: every call reaches the Worker.

import { workerFetch, WorkerFetchError } from "../lib/workerFetch";

const EDITION_PATH = "/daybreak/edition";

// What a relayed reason may look like: a short snake_case code, never prose.
const REASON_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export type DaybreakFetchError =
  | { kind: "auth_missing" }
  | { kind: "auth_invalid" }
  | { kind: "scope_insufficient" }
  | { kind: "worker_unavailable"; reason: string }
  | { kind: "upstream_error"; status: number }
  | { kind: "invalid_worker_response" }
  | { kind: "worker_unreachable" }
  | { kind: "worker_not_configured" };

export type DaybreakFetchResult =
  | { ok: true; value: unknown }
  | { ok: false; error: DaybreakFetchError };

async function classifyWorkerFailure(res: Response): Promise<DaybreakFetchError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; detail?: unknown } | null;
  const reason = typeof body?.error === "string" ? body.error : "";
  console.error(
    `[daybreak] ${EDITION_PATH} → HTTP ${res.status}` +
      (reason ? ` error=${reason}` : "") +
      (body?.detail !== undefined ? ` detail=${String(body.detail)}` : ""),
  );
  if (res.status === 401) return reason === "missing" ? { kind: "auth_missing" } : { kind: "auth_invalid" };
  if (res.status === 403 && reason === "scope_insufficient") return { kind: "scope_insufficient" };
  if (res.status === 503 && REASON_CODE.test(reason)) return { kind: "worker_unavailable", reason };
  return { kind: "upstream_error", status: res.status };
}

export async function fetchDaybreakEdition(): Promise<DaybreakFetchResult> {
  let res: Response;
  try {
    res = await workerFetch(EDITION_PATH);
  } catch (err) {
    if (err instanceof WorkerFetchError && err.reason === "not_configured") {
      return { ok: false, error: { kind: "worker_not_configured" } };
    }
    console.error(`[daybreak] ${EDITION_PATH} transport error:`, err instanceof Error ? err.message : String(err));
    return { ok: false, error: { kind: "worker_unreachable" } };
  }

  if (!res.ok) return { ok: false, error: await classifyWorkerFailure(res) };

  try {
    return { ok: true, value: await res.json() };
  } catch (err) {
    console.error(`[daybreak] ${EDITION_PATH} returned 200 with a non-JSON body:`, err instanceof Error ? err.message : String(err));
    return { ok: false, error: { kind: "invalid_worker_response" } };
  }
}

/** Maps a failure to the proxy's HTTP status and body. Codes only. */
export function mapDaybreakErrorToHttp(error: DaybreakFetchError): {
  status: number;
  body: { error: string; reason?: string; status?: number };
} {
  switch (error.kind) {
    case "auth_missing":
      return { status: 401, body: { error: "auth_missing" } };
    case "auth_invalid":
      return { status: 401, body: { error: "auth_invalid" } };
    case "scope_insufficient":
      return { status: 403, body: { error: "scope_insufficient" } };
    case "worker_unavailable":
      return { status: 503, body: { error: "worker_unavailable", reason: error.reason } };
    case "upstream_error":
      return { status: 502, body: { error: "upstream_error", status: error.status } };
    case "invalid_worker_response":
      return { status: 502, body: { error: "invalid_worker_response" } };
    case "worker_unreachable":
      return { status: 503, body: { error: "worker_unreachable" } };
    case "worker_not_configured":
      return { status: 503, body: { error: "worker_not_configured" } };
  }
}
