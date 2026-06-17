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

/** The five canonical auto-pay alert types (spec §5). */
export type AutoPayAlertType =
  | "AUTOPAY_INSUFFICIENT_FUNDS"
  | "AUTOPAY_LND_UNAVAILABLE"
  | "AUTOPAY_PAYMENT_FAILED"
  | "AUTOPAY_FEE_ESTIMATE_FAILED"
  | "AUTOPAY_SUCCEEDED";

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
};

/** The four warning (failure) types — the recoverable set that auto-clears on
 *  a subsequent successful pay. AUTOPAY_SUCCEEDED is deliberately excluded. */
const WARNING_TYPES: AutoPayAlertType[] = [
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
 * Map a PayFromNodeError to its alert type, or null for the two deferral
 * cases (spec §5). `status_unavailable` (treasury unreachable) and
 * `payment_in_flight` (a send already running) are transient and member-
 * unactionable — they raise NO alert and simply retry on a later tick.
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
    case "status_unavailable":
    case "payment_in_flight":
      return null;
  }
}

/** Severity for an alert type, read from the single source of truth. */
export function severityForAlertType(type: AutoPayAlertType): AutoPayAlertSeverity {
  return SEVERITY_BY_TYPE[type];
}

/** True for the four warning types (they clear on the next successful pay);
 *  false for AUTOPAY_SUCCEEDED (its lifecycle is time/episode-based). */
export function shouldAutoClear(type: AutoPayAlertType): boolean {
  return SEVERITY_BY_TYPE[type] === "warning";
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
 * On a successful auto-pay, every active warning alert flips to resolved. The
 * AUTOPAY_SUCCEEDED row is NOT a resolution target (shouldAutoClear=false) —
 * it is created separately and lives on its own time/episode lifecycle.
 */
export function resolveOnSuccess(
  activeAlerts: AutoPayActiveAlertRow[],
): AutoPayAlertResolution[] {
  const warning = new Set<string>(WARNING_TYPES);
  return activeAlerts
    .filter((a) => a.status === "active" && warning.has(a.type))
    .map((a) => ({ alertId: a.id }));
}
