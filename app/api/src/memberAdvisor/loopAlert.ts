/**
 * The member-facing "Loop unavailable" alert, one per swap direction
 * (drive-mode P2, item 6; spec D2.3; R27(2)).
 *
 * Pure. Rendered API-SIDE so `LoopAvailability.unavailableReason` stays
 * API-internal, as decisions/2026-09-02-loop-unavailability-classification-
 * taxonomy-and-copy.md D2(b) requires (kept by R27(2)): the web reads only the
 * sentence and the action's label, never the reason. Served by
 * GET /api/liquidity/status as `loopAlert`.
 *
 * ─── THE FOUR CASES (D2's "three DAEMON states, FOUR COPY cases") ───────────
 *
 *   daemon down, credentials_absent   → its own sentence, per direction
 *   daemon down, unreachable          → its own sentence, per direction
 *   daemon up, Loop Out terms failed  → loop_out only
 *   daemon up, Loop In terms failed   → loop_in only
 *   available                         → null
 *
 * A direction is named because a single alert cannot say which of Withdraw
 * (Loop Out) or Top Up (Loop In) is unavailable; the dashboard shows the one
 * for the member's role, Withdraw and Top Up each show their own.
 *
 * ─── WHAT EACH CASE MAY SAY (D3) ────────────────────────────────────────────
 *
 * `unreachable` asserts no cause and names NO remediation: an expired or
 * rotated LND certificate lands here, and the cert notice on the same page owns
 * that fault's cause and its two-restart fix. Naming a Bitcorn restart here
 * would contradict it. Its one action is to check again (R27(12)).
 * `credentials_absent` says "still setting up" rather than a permanent claim:
 * loopd regenerates its credentials on start, so a healthy node passes through
 * this state on every restart.
 * The two terms-failed sentences are the ones the engine already ships
 * (recommendationEngine.ts), unchanged by D2's own ruling.
 * No daemon internals and no transport vocabulary in any case; pinned by
 * loopAlert.test.ts.
 */

import type { LoopAvailability } from "./loopAvailability";

export type LoopDirection = "loop_out" | "loop_in";

export interface LoopAlert {
  /** One sentence, the whole fix (C6). */
  text: string;
  /** The one action. Each re-reads GET /api/liquidity/status. */
  action: { label: "Check again" | "Try again" };
}

export interface LoopAlerts {
  loop_out: LoopAlert | null;
  loop_in: LoopAlert | null;
}

/** The member-facing name of each direction's page. */
const PAGE: Record<LoopDirection, string> = { loop_out: "Withdraw", loop_in: "Top Up" };

const TERMS_FAILED: Record<LoopDirection, string> = {
  loop_out: "Withdrawals are currently unavailable.",
  loop_in: "Top Up is currently unavailable.",
};

export function loopAlertFor(loop: LoopAvailability, direction: LoopDirection): LoopAlert | null {
  if (!loop.loopDaemonRunning) {
    // `?? "unreachable"`: the same total fallback as loopAvailability.ts —
    // the catch-all state, and the one that asserts nothing.
    const reason = loop.unavailableReason ?? "unreachable";
    if (reason === "credentials_absent") {
      return {
        text:
          `Loop is still setting up on this node, so ${PAGE[direction]} isn't available yet. ` +
          `If this lasts more than 10 minutes, restart Bitcorn.`,
        action: { label: "Check again" },
      };
    }
    return {
      text: `Loop isn't responding right now, so ${PAGE[direction]} isn't available.`,
      action: { label: "Check again" },
    };
  }
  const available = direction === "loop_out" ? loop.loopOutAvailable : loop.loopInAvailable;
  if (available) return null;
  return { text: TERMS_FAILED[direction], action: { label: "Try again" } };
}

export function loopAlertsFor(loop: LoopAvailability): LoopAlerts {
  return { loop_out: loopAlertFor(loop, "loop_out"), loop_in: loopAlertFor(loop, "loop_in") };
}
