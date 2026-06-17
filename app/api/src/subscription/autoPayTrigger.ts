// Subscription auto-pay trigger — pure decision logic.
//
// Implements specs/2026-06-12-subscription-auto-pay-implementation.md §3 plus
// the Gate-1 settlement-cooldown addition (the re-fire / double-send guard).
//
// The scheduler does the I/O (fetch status, read profile + alerts) and reduces
// the result to this narrowed input; this function is a deterministic, DB-free
// state machine over it (A1 posture, §9). It is LEVEL-triggered: condition is
// "observed IN a recoverable-lapsed tier", not "transitioned to one", so a node
// that booted already lapsed still fires.
//
// Returns one of:
//   - "fire"  — attempt the auto-pay now.
//   - "skip"  — nothing to do (not applicable / not enabled / tier needs no
//               action). The browser banners still surface the state.
//   - "defer" — would fire, but a guard holds it: a send is in flight, a recent
//               success is still settling, or a failure is cooling down / paused.
//               Re-evaluated on the next tick, all within the grace runway.

import { SEVERITY_BY_TYPE, type AutoPayActiveAlertRow, type AutoPayAlertType } from "./autoPayAlerts";

/** The tier values the trigger reasons over. `null` = status not applicable. */
export type AutoPayTier =
  | "prepay"
  | "current"
  | "worker_lapsed"
  | "routing_lapsed"
  | "close_due"
  | null;

/** The recoverable-lapsed set auto-pay fires on (Gate-1 recommendation A,
 *  operator-confirmed): all three are recoverable by one single-cycle pay. */
const RECOVERABLE_LAPSED = new Set<string>([
  "worker_lapsed",
  "routing_lapsed",
  "close_due",
]);

export interface ShouldAutoPayInput {
  /** current_tier when status.applicable, else null. */
  tier: AutoPayTier;
  /** member_profile.auto_pay_enabled. */
  autoPayEnabled: boolean;
  /** payFromNode.isSendInFlight() at evaluation time. */
  sendInFlight: boolean;
  /** This member's auto-pay alerts (active + recent), for cooldown/backoff. */
  activeAlerts: AutoPayActiveAlertRow[];
  /** Current time, epoch SECONDS (matches alert updated_at units). */
  nowSec: number;
  /** Don't re-fire within this many seconds of a recorded success (§ Gate-1). */
  settlementCooldownSec: number;
  /** Don't re-attempt within this many seconds of the last failure. */
  failureBackoffSec: number;
  /** Stop attempting once a warning alert reaches this consecutive_count. */
  failurePauseThreshold: number;
}

export type AutoPayDecision = "fire" | "skip" | "defer";

function isWarning(type: string): boolean {
  return SEVERITY_BY_TYPE[type as AutoPayAlertType] === "warning";
}

export function shouldAutoPay(input: ShouldAutoPayInput): AutoPayDecision {
  // ── Skip conditions (genuinely nothing to do) ──
  if (!input.autoPayEnabled) return "skip";
  if (input.tier == null || !RECOVERABLE_LAPSED.has(input.tier)) return "skip";

  // ── Defer conditions (would fire, but a guard holds) ──
  if (input.sendInFlight) return "defer";

  // Settlement cooldown: a recent successful pay is still awaiting on-chain
  // confirmation + treasury crediting (detector requires conf >= 1). Without
  // this, a level-triggered tick would re-send every cycle until the first
  // block — the double-send window. Reuses the SUCCEEDED row's updated_at as
  // the "recently paid" marker (no extra column).
  const recentSuccess = input.activeAlerts.some(
    (a) =>
      a.type === "AUTOPAY_SUCCEEDED" &&
      a.status === "active" &&
      input.nowSec - a.updated_at < input.settlementCooldownSec,
  );
  if (recentSuccess) return "defer";

  // Failure backoff + auto-pause, reusing the warning row's own
  // consecutive_count / updated_at as the backoff state (§5).
  const activeWarnings = input.activeAlerts.filter(
    (a) => a.status === "active" && isWarning(a.type),
  );
  const paused = activeWarnings.some(
    (a) => a.consecutive_count >= input.failurePauseThreshold,
  );
  if (paused) return "defer";
  const coolingDown = activeWarnings.some(
    (a) => input.nowSec - a.updated_at < input.failureBackoffSec,
  );
  if (coolingDown) return "defer";

  return "fire";
}
