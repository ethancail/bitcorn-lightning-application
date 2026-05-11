// First-run acknowledgement gate.
//
// Path B (V8 fallback): no separate subscription xpub is generated, so
// there is no seed to back up. The gate instead exists so the operator
// deliberately opts into the logical-only segregation model — once
// acknowledged, member subscription addresses can be allocated and
// detection begins.
//
// Address allocation must call `assertFirstRunAcknowledged()` before
// invoking the LND chain-address RPC. The acknowledgement is a single
// timestamp on `subscription_policy` (added by migration 037).

import { db } from "../db";

/** Thrown when address derivation is attempted before operator ack. */
export class FirstRunNotAcknowledgedError extends Error {
  constructor() {
    super(
      "Subscription first-run acknowledgement required. " +
      "POST /api/admin/subscription/acknowledge-first-run as the treasury operator."
    );
    this.name = "FirstRunNotAcknowledgedError";
  }
}

export function isFirstRunAcknowledged(): boolean {
  const row = db
    .prepare("SELECT first_run_acknowledged_at FROM subscription_policy WHERE id = 1")
    .get() as { first_run_acknowledged_at: number | null } | undefined;
  return row?.first_run_acknowledged_at != null;
}

export function assertFirstRunAcknowledged(): void {
  if (!isFirstRunAcknowledged()) throw new FirstRunNotAcknowledgedError();
}

/**
 * Records the operator's acknowledgement. Idempotent — re-acknowledging
 * does not overwrite the original timestamp; callers can rely on
 * `getFirstRunAcknowledgedAt()` returning the original moment.
 */
export function acknowledgeFirstRun(): { acknowledged_at: number } {
  const existing = db
    .prepare("SELECT first_run_acknowledged_at FROM subscription_policy WHERE id = 1")
    .get() as { first_run_acknowledged_at: number | null } | undefined;
  if (existing?.first_run_acknowledged_at != null) {
    return { acknowledged_at: existing.first_run_acknowledged_at };
  }
  const now = Date.now();
  db.prepare(
    "UPDATE subscription_policy SET first_run_acknowledged_at = ?, updated_at = ? WHERE id = 1"
  ).run(now, now);
  return { acknowledged_at: now };
}

export function getFirstRunAcknowledgedAt(): number | null {
  const row = db
    .prepare("SELECT first_run_acknowledged_at FROM subscription_policy WHERE id = 1")
    .get() as { first_run_acknowledged_at: number | null } | undefined;
  return row?.first_run_acknowledged_at ?? null;
}
