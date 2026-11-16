// SUBSCRIPTION_PAYMENT_UNCREDITED — the treasury alert for deposit outputs the
// detector has left uncredited (recredit-check spec §4.4; ruling O3's
// amendment, widened by G3 to be cause-agnostic).
//
// The detector REPLACES the snapshot at the end of every scan that got past
// getUtxos; nothing else writes it. Membership is the detector's own test: a
// UTXO with ≥1 confirmation at a subscription deposit address for which
// alreadyRecorded() (both tables, detector.ts) is false after the scan's last
// credit — whatever the reason it was left. That is the same two-table
// predicate dev-safety's R6 pre-flight check mirrors.
//
// The wait is measured in CONFIRMATIONS, a chain fact relative to LND's tip, so
// an API restart does not reset it: the snapshot starts empty and the boot scan
// refills it with the same counts.
//
// ⚠ OFF UNTIL THE FIRST-RUN GATE IS ACKNOWLEDGED, by construction: before that
// every scan returns at the gate, the snapshot is never written, and this
// producer sees an empty one. That is what keeps member nodes silent. The
// producer deliberately does NOT re-check the gate; control (ix-b)(3) proves
// the gate holds through the snapshot.
//
// Pure: no I/O, so getTreasuryAlerts() calls it without a try/catch.

import type { TreasuryAlert } from "../api/treasury-alerts";

export const UNCREDITED_ALERT_TYPE = "SUBSCRIPTION_PAYMENT_UNCREDITED";
export const UNCREDITED_WARNING_CONFIRMATIONS = 6; // ≈ an hour
export const UNCREDITED_CRITICAL_CONFIRMATIONS = 144; // ≈ a day

export type UncreditedCause = "time_unavailable" | "credit_threw" | "held_behind" | "unknown";

export interface UncreditedEntry {
  /** "<txid>:<vout>" */
  outpoint: string;
  member_pubkey: string;
  /** getUtxos' confirmation_count for the output in the scan that wrote this. */
  confirmations: number;
  cause: UncreditedCause;
  /** The time-lookup failure or the credit's error message; null otherwise. */
  detail: string | null;
  /** For cause "held_behind": the outpoint it waits behind. */
  held_behind: string | null;
}

export interface UncreditedSnapshot {
  as_of: number;
  entries: UncreditedEntry[];
}

let snapshot: UncreditedSnapshot = { as_of: 0, entries: [] };

/** Detector only. Replaces, never merges. */
export function setUncreditedSnapshot(next: UncreditedSnapshot): void {
  snapshot = next;
}

export function getUncreditedSnapshot(): UncreditedSnapshot {
  return snapshot;
}

export function subscriptionCreditWaitAlert(
  current: UncreditedSnapshot,
  nowMs: number,
): TreasuryAlert | null {
  if (current.entries.length === 0) return null;
  const max = Math.max(...current.entries.map((e) => e.confirmations));
  if (max < UNCREDITED_WARNING_CONFIRMATIONS) return null;

  const count = current.entries.length;
  const outputs = [...current.entries]
    .sort((a, b) => b.confirmations - a.confirmations || (a.outpoint < b.outpoint ? -1 : 1))
    .map((e) => ({
      outpoint: e.outpoint,
      member: e.member_pubkey.slice(0, 16),
      confirmations: e.confirmations,
      cause: e.cause,
      detail: e.detail,
      held_behind: e.held_behind,
    }));

  return {
    type: UNCREDITED_ALERT_TYPE,
    // Names no cause and no remedy: the type proves neither (heading rule,
    // treasury-alerts.ts). Each output's cause is in data.
    heading: "Subscription payments not credited yet",
    severity: max >= UNCREDITED_CRITICAL_CONFIRMATIONS ? "critical" : "warning",
    message:
      `${count} confirmed subscription payment(s) at member deposit addresses are not credited yet. ` +
      `The oldest has ${max} confirmations. Each scan retries them; this alert's data names each one and why it is waiting.`,
    data: {
      count,
      oldest_confirmations: max,
      warning_at_confirmations: UNCREDITED_WARNING_CONFIRMATIONS,
      critical_at_confirmations: UNCREDITED_CRITICAL_CONFIRMATIONS,
      as_of: current.as_of,
      outputs,
    },
    at: nowMs,
  };
}
