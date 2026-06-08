// Auto-Buy failure alerts (Phase 2) — pure decision logic.
//
// Implements specs/2026-06-05-currency-adaptive-autobuy-phase-2.md §6.
// Mirrors the Phase 1 contract (currency.ts): deterministic, no I/O. The
// scheduler observes a failure/success at the point where it is already
// classified, builds a normalised signal, asks these functions what to do,
// and performs the DB write itself (see alertStore.ts). Keeping this pure is
// what makes it unit-testable in isolation (§7) without a DB or Coinbase.

/** The five canonical alert types (spec §2). The AUTOBUY_ prefix keeps these
 *  distinct from the computed TreasuryAlert types. */
export type AlertType =
  | "AUTOBUY_INSUFFICIENT_FUNDS"
  | "AUTOBUY_AUTH_FAILURE"
  | "AUTOBUY_RATE_LIMITED"
  | "AUTOBUY_ORDER_FAILED"
  | "AUTOBUY_SWEEP_FAILED";

/** Phase 2 emits warning or critical only — never info, even though the
 *  shared AlertSeverity vocabulary allows it (spec §1). */
export type AlertSeverity = "warning" | "critical";

/** Classification of a failed Coinbase interaction. */
export type CoinbaseErrorClass = "auth" | "rate_limit" | "other";

/** Severity is owned here as the single source of truth (spec §2). The
 *  scheduler does not pass severity in — it is derived from the type so the
 *  two can never drift. */
export const SEVERITY_BY_TYPE: Record<AlertType, AlertSeverity> = {
  AUTOBUY_INSUFFICIENT_FUNDS: "warning",
  AUTOBUY_AUTH_FAILURE: "critical",
  AUTOBUY_RATE_LIMITED: "warning",
  AUTOBUY_ORDER_FAILED: "warning",
  AUTOBUY_SWEEP_FAILED: "critical",
};

/** The minimal shape of an existing active alert the decision functions need.
 *  The store reads full rows; only these fields drive the create-or-dedup and
 *  auto-clear decisions. */
export interface ActiveAlertRow {
  id: number;
  type: string;
  status: string;
  consecutive_count: number;
}

/** A normalised failure observation built by the scheduler. `severity` is NOT
 *  carried here — it is derived from `type` via SEVERITY_BY_TYPE. */
export interface FailureSignal {
  type: AlertType;
  latestRunId?: number | null;
  context: Record<string, unknown>;
}

/** What the scheduler should do in response to a failure signal. */
export type AlertIntent =
  | {
      action: "create";
      type: AlertType;
      severity: AlertSeverity;
      latestRunId: number | null;
      context: Record<string, unknown>;
    }
  | {
      action: "increment";
      alertId: number;
      latestRunId: number | null;
      context: Record<string, unknown>;
    }
  | { action: "noop" };

/** An active alert the scheduler should resolve in response to a success. */
export interface AlertResolution {
  alertId: number;
}

/** Success events that auto-clear matching active alerts (spec §3). */
export type SuccessKind = "buy" | "api_ok" | "sweep";

// ───────────────────────────────────────────────────────────────────────
// classifyCoinbaseError
// ───────────────────────────────────────────────────────────────────────

/**
 * Single source of truth for mapping a failed Coinbase interaction to a
 * scenario class (spec §6). Used to route placement/poll failures whose only
 * signal is a free-text error_message + HTTP status:
 *   - 401 / 403            → auth        (credentials rejected)
 *   - 429 and any 5xx      → rate_limit  (throttle / outage, transient)
 *   - everything else      → other       (incl. status 0 timeout/abort/network,
 *                                          400, 404, non-JSON, empty text)
 *
 * Note (spec §6, OQ10): the listAccounts non-auth branch raises RATE_LIMITED
 * directly without this classifier — it is already known to be non-auth there.
 * This classifier only runs on the placement/poll paths.
 */
export function classifyCoinbaseError(httpStatus: number, _errorText: string): CoinbaseErrorClass {
  if (httpStatus === 401 || httpStatus === 403) return "auth";
  if (httpStatus === 429) return "rate_limit";
  if (httpStatus >= 500 && httpStatus <= 599) return "rate_limit";
  return "other";
}

// ───────────────────────────────────────────────────────────────────────
// decideAlertForFailure
// ───────────────────────────────────────────────────────────────────────

/**
 * Apply the shared create-or-dedup rule (spec §2):
 *   - if an `active` alert of the same `type` exists → increment it;
 *   - otherwise → create a new active row.
 * A `dismissed` or `resolved` alert of the same type does NOT suppress a new
 * create — a recurrence after dismissal opens a fresh active row (§3).
 *
 * Returns `noop` when `signal` is null — the scheduler passes null for the
 * excluded outcomes (skipped_stale_data / skipped_zero_multiplier /
 * skipped_cap_hit / success states), which must raise nothing (§2, §7).
 */
export function decideAlertForFailure(
  signal: FailureSignal | null,
  activeAlerts: ActiveAlertRow[],
): AlertIntent {
  if (!signal) return { action: "noop" };

  const existing = activeAlerts.find(
    (a) => a.type === signal.type && a.status === "active",
  );
  const latestRunId = signal.latestRunId ?? null;

  if (existing) {
    return {
      action: "increment",
      alertId: existing.id,
      latestRunId,
      context: signal.context,
    };
  }

  return {
    action: "create",
    type: signal.type,
    severity: SEVERITY_BY_TYPE[signal.type],
    latestRunId,
    context: signal.context,
  };
}

// ───────────────────────────────────────────────────────────────────────
// updateAlertOnSuccess
// ───────────────────────────────────────────────────────────────────────

/** Which active alert types each success event clears (spec §3 auto-clear
 *  table). Kept separate per type so a `buy` does not clear auth/rate-limit
 *  (those clear on the prior `api_ok` from the same tick's listAccounts). */
const RESOLVES_BY_SUCCESS: Record<SuccessKind, AlertType[]> = {
  buy: ["AUTOBUY_INSUFFICIENT_FUNDS", "AUTOBUY_ORDER_FAILED"],
  api_ok: ["AUTOBUY_AUTH_FAILURE", "AUTOBUY_RATE_LIMITED"],
  sweep: ["AUTOBUY_SWEEP_FAILED"],
};

/**
 * Given a success event and the current active alerts, return the alert ids to
 * resolve (spec §3). Idempotent at the call site: resolving an absent/already-
 * resolved alert is a no-op (this returns only ids of currently-active rows
 * whose type matches the success).
 */
export function updateAlertOnSuccess(
  successKind: SuccessKind,
  activeAlerts: ActiveAlertRow[],
): AlertResolution[] {
  const types = RESOLVES_BY_SUCCESS[successKind] ?? [];
  if (types.length === 0) return [];
  const typeSet = new Set<string>(types);
  return activeAlerts
    .filter((a) => a.status === "active" && typeSet.has(a.type))
    .map((a) => ({ alertId: a.id }));
}

// ───────────────────────────────────────────────────────────────────────
// mergeContext
// ───────────────────────────────────────────────────────────────────────

/**
 * Shallow-merge a new context over an existing context_json string (used on
 * the increment path so the active row always reflects the latest occurrence,
 * spec §1/§2). Null-safe: a missing/invalid existing JSON is treated as {}.
 */
export function mergeContext(
  existingJson: string | null | undefined,
  newContext: Record<string, unknown>,
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (existingJson) {
    try {
      const parsed = JSON.parse(existingJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // invalid JSON → treat as empty base
    }
  }
  return { ...base, ...newContext };
}
