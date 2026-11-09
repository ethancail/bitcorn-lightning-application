// Subscription auto-pay alerts — pure decision logic.
//
// Implements specs/2026-06-12-subscription-auto-pay-implementation.md §5.
// Mirrors the Phase 2 auto-buy alert contract (autoBuy/alerts.ts):
// deterministic, no I/O. The scheduler observes a classified failure or a
// success, builds a signal, asks these functions what to do, and performs
// the DB write itself (see autoPayAlertStore.ts). Keeping this pure is what
// makes it unit-testable in isolation without a DB or LND (§9, A1 posture).
//
// Deliberate divergence from autoBuy/alerts.ts: the severity domain here is
// ('info','warning'), NOT ('warning','critical'). A failed renewal is
// action-required but never catastrophic given the long grace runway, and
// auto-pay carries an info-level success notification. Do not "align" this
// to the auto-buy CHECK.

import type { PayFromNodeError } from "./payFromNode";

/** The seven canonical auto-pay alert types: the five of the auto-pay spec
 *  §5, plus the two the pay-from-node guards report (pay-from-node spec §3.6,
 *  §4.2, §4.3; ruled 2026-11-05). */
export type AutoPayAlertType =
  | "AUTOPAY_INSUFFICIENT_FUNDS"
  | "AUTOPAY_LND_UNAVAILABLE"
  | "AUTOPAY_PAYMENT_FAILED"
  | "AUTOPAY_FEE_ESTIMATE_FAILED"
  | "AUTOPAY_SUCCEEDED"
  // An earlier payment has not been credited after the hold time; auto-pay
  // stays held by the settlement marker.
  | "AUTOPAY_SETTLEMENT_OVERDUE"
  // Auto-pay refused by the price ceiling: the price is above the last
  // acknowledged one, or none was ever acknowledged (context.reason says
  // which).
  | "AUTOPAY_PRICE_NOT_ACKNOWLEDGED";

/** Auto-pay emits info (success) or warning (failure) only — never critical. */
export type AutoPayAlertSeverity = "info" | "warning";

/** Severity owned here as the single source of truth (spec §5) so type and
 *  severity can never drift — the scheduler/store never pass severity in. */
export const SEVERITY_BY_TYPE: Record<AutoPayAlertType, AutoPayAlertSeverity> = {
  AUTOPAY_INSUFFICIENT_FUNDS: "warning",
  AUTOPAY_LND_UNAVAILABLE: "warning",
  AUTOPAY_PAYMENT_FAILED: "warning",
  AUTOPAY_FEE_ESTIMATE_FAILED: "warning",
  AUTOPAY_SUCCEEDED: "info",
  AUTOPAY_SETTLEMENT_OVERDUE: "warning",
  AUTOPAY_PRICE_NOT_ACKNOWLEDGED: "warning",
};

/** The four SEND-FAILURE types — the recoverable set that auto-clears on a
 *  subsequent successful pay, and the only types that feed the trigger's
 *  failure backoff and pause (autoPayTrigger.ts). AUTOPAY_SUCCEEDED is
 *  excluded, and so are the two guard types: they report a hold the marker or
 *  the ceiling already enforces, are raised once per cause, and resolve when
 *  their cause clears (pay-from-node spec §4.3, ruled 2026-11-05). */
export const SEND_FAILURE_TYPES: AutoPayAlertType[] = [
  "AUTOPAY_INSUFFICIENT_FUNDS",
  "AUTOPAY_LND_UNAVAILABLE",
  "AUTOPAY_PAYMENT_FAILED",
  "AUTOPAY_FEE_ESTIMATE_FAILED",
];

/** The minimal shape of an existing alert the decision functions read. The
 *  store reads full rows; only these fields drive create-or-dedup, auto-clear,
 *  and the trigger's cooldown/backoff math (updated_at, consecutive_count). */
export interface AutoPayActiveAlertRow {
  id: number;
  type: string;
  status: string;
  consecutive_count: number;
  updated_at: number; // epoch seconds
}

/** A normalised signal built by the scheduler. Severity is NOT carried — it is
 *  derived from `type` via SEVERITY_BY_TYPE. */
export interface AutoPaySignal {
  type: AutoPayAlertType;
  context: Record<string, unknown>;
}

/** What the scheduler should do in response to a signal. */
export type AutoPayAlertIntent =
  | {
      action: "create";
      type: AutoPayAlertType;
      severity: AutoPayAlertSeverity;
      context: Record<string, unknown>;
    }
  | { action: "increment"; alertId: number; context: Record<string, unknown> }
  | { action: "noop" };

/** An active alert the scheduler should resolve in response to a success. */
export interface AutoPayAlertResolution {
  alertId: number;
}

// ───────────────────────────────────────────────────────────────────────
// classifyAutoPayError
// ───────────────────────────────────────────────────────────────────────

/**
 * Map a PayFromNodeError to its alert type, or null for a deferral (spec §5).
 * `status_unavailable` (treasury unreachable) and `payment_in_flight` (a send
 * already running) are transient and member-unactionable — they raise NO
 * alert and simply retry on a later tick. `settlement_pending` is the
 * settlement marker's silent deferral until the hold time; past it the
 * refusal is `settlement_overdue`, which alerts (pay-from-node spec §3.6).
 * The two price-ceiling refusals share one alert type, told apart by its
 * context's reason. `pay_target_changed` and `repeat_unacknowledged` arise
 * only on the manual path.
 */
export function classifyAutoPayError(error: PayFromNodeError): AutoPayAlertType | null {
  switch (error) {
    case "insufficient_funds":
      return "AUTOPAY_INSUFFICIENT_FUNDS";
    case "lnd_unavailable":
      return "AUTOPAY_LND_UNAVAILABLE";
    case "send_failed":
      return "AUTOPAY_PAYMENT_FAILED";
    case "fee_estimate_failed":
      return "AUTOPAY_FEE_ESTIMATE_FAILED";
    case "settlement_overdue":
      return "AUTOPAY_SETTLEMENT_OVERDUE";
    case "price_above_acknowledged":
    case "price_unacknowledged":
      return "AUTOPAY_PRICE_NOT_ACKNOWLEDGED";
    case "status_unavailable":
    // A status without a numeric paid_through (ruled 2026-11-09): a refusal
    // on the same silent-deferral path, no new alert type; the scheduler logs it.
    case "status_incomplete":
    case "payment_in_flight":
    case "settlement_pending":
    case "pay_target_changed":
    case "repeat_unacknowledged":
      return null;
  }
}

// ───────────────────────────────────────────────────────────────────────
// The guard alerts' causes (pay-from-node spec §4.3, ruled 2026-11-05)
// ───────────────────────────────────────────────────────────────────────

/** The two alert types that are raised once per cause and resolve when their
 *  cause clears, rather than deduping by type and clearing on success. */
export const CAUSE_ALERT_TYPES: AutoPayAlertType[] = [
  "AUTOPAY_SETTLEMENT_OVERDUE",
  "AUTOPAY_PRICE_NOT_ACKNOWLEDGED",
];

export function isCauseAlertType(type: string): boolean {
  return (CAUSE_ALERT_TYPES as string[]).includes(type);
}

export type PriceAlertReason = "price_above_acknowledged" | "no_acknowledged_price";

/** The overdue alert's cause is the marker it names. */
export function overdueCauseKey(markerId: number): string {
  return `marker:${markerId}`;
}

/** The price alert's cause is (reason, current price, acknowledged price). */
export function priceCauseKey(
  reason: PriceAlertReason,
  currentPrice: number,
  acknowledgedPrice: number | null,
): string {
  return `${reason}|${currentPrice}|${acknowledgedPrice ?? "null"}`;
}

/** The price cause that holds right now, or null when the price is at or
 *  below the acknowledged one (no cause). */
export function currentPriceCauseKey(
  currentPrice: number,
  acknowledgedPrice: number | null,
): string | null {
  if (acknowledgedPrice == null) {
    return priceCauseKey("no_acknowledged_price", currentPrice, null);
  }
  if (currentPrice > acknowledgedPrice) {
    return priceCauseKey("price_above_acknowledged", currentPrice, acknowledgedPrice);
  }
  return null;
}

/** A stored row of a cause type, as the decisions below read it. */
export interface CauseAlertRow {
  id: number;
  type: string;
  status: string;
  cause_key: string | null;
}

/**
 * Raised once per cause: create only when no row of this type — active,
 * dismissed or resolved — already carries this cause key. Unlike
 * decideAutoPayAlert, a dismissed row DOES suppress a new one (otherwise a
 * dismissed alert would return on the next 60s tick while its cause holds),
 * and an active row is not incremented.
 */
export function decideCauseAlert(
  type: AutoPayAlertType,
  causeKey: string,
  rowsOfType: CauseAlertRow[],
): "create" | "noop" {
  return rowsOfType.some((r) => r.type === type && r.cause_key === causeKey)
    ? "noop"
    : "create";
}

/** Each resolves when its cause clears: the active rows of a cause type whose
 *  cause key is no longer among the live ones. */
export function causeAlertsToResolve(
  activeRowsOfType: CauseAlertRow[],
  liveCauseKeys: Set<string>,
): AutoPayAlertResolution[] {
  return activeRowsOfType
    .filter((r) => r.status === "active" && !(r.cause_key != null && liveCauseKeys.has(r.cause_key)))
    .map((r) => ({ alertId: r.id }));
}

/** Severity for an alert type, read from the single source of truth. */
export function severityForAlertType(type: AutoPayAlertType): AutoPayAlertSeverity {
  return SEVERITY_BY_TYPE[type];
}

/** True for the four send-failure types (they clear on the next successful
 *  pay); false for AUTOPAY_SUCCEEDED (its lifecycle is time/episode-based) and
 *  for the two guard types (they resolve when their cause clears). */
export function shouldAutoClear(type: AutoPayAlertType): boolean {
  return SEND_FAILURE_TYPES.includes(type);
}

// ───────────────────────────────────────────────────────────────────────
// decideAutoPayAlert — create-or-dedup (spec §5 lifecycle)
// ───────────────────────────────────────────────────────────────────────

/**
 * If an `active` alert of the same `type` exists → increment it; otherwise →
 * create a fresh active row. A dismissed/resolved alert of the same type does
 * NOT suppress a new create — a recurrence after dismissal opens a fresh row.
 * Returns `noop` for a null signal (the classifier's defer cases).
 */
export function decideAutoPayAlert(
  signal: AutoPaySignal | null,
  activeAlerts: AutoPayActiveAlertRow[],
): AutoPayAlertIntent {
  if (!signal) return { action: "noop" };

  const existing = activeAlerts.find(
    (a) => a.type === signal.type && a.status === "active",
  );
  if (existing) {
    return { action: "increment", alertId: existing.id, context: signal.context };
  }
  return {
    action: "create",
    type: signal.type,
    severity: SEVERITY_BY_TYPE[signal.type],
    context: signal.context,
  };
}

// ───────────────────────────────────────────────────────────────────────
// resolveOnSuccess — auto-clear active warnings (spec §5)
// ───────────────────────────────────────────────────────────────────────

/**
 * On a successful auto-pay, every active send-failure alert flips to resolved.
 * The AUTOPAY_SUCCEEDED row is NOT a resolution target (shouldAutoClear=false) —
 * it is created separately and lives on its own time/episode lifecycle — and
 * neither are the two guard types, which resolve when their cause clears.
 */
export function resolveOnSuccess(
  activeAlerts: AutoPayActiveAlertRow[],
): AutoPayAlertResolution[] {
  const warning = new Set<string>(SEND_FAILURE_TYPES);
  return activeAlerts
    .filter((a) => a.status === "active" && warning.has(a.type))
    .map((a) => ({ alertId: a.id }));
}
