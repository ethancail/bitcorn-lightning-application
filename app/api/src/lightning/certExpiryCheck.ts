// The day-scale cert-expiry check: rate limit, inspect, report.
//
// ─── WHY THIS IS NOT IN advisorScheduler.ts ─────────────────────────────────
//
// The scheduler is the natural HOME for the cadence (member-side, already
// running, already has a startup delay and try/catch logging), but it imports
// getNodeInfo from ../api/read, which imports ../db, and db/index.ts:14 does
// `export const db = new Database(DB_PATH)` at MODULE SCOPE. So anything that
// imports the scheduler opens SQLite and loads better-sqlite3's native
// bindings. Keeping the logic here means its tests need no vi.mock("../db")
// (the workaround channelClassifier.test.ts:17 needs) and create no store.
//
// The scheduler keeps the wiring; this keeps the decision.
//
// ─── ROLE-AGNOSTIC, DELIBERATELY ────────────────────────────────────────────
//
// A certificate expires the same way on a treasury node, a member node and an
// external node, so this consults no node_role and takes no node argument.
// That matters concretely: advisorScheduler's runOnce() returns early for
// treasury nodes (advisorScheduler.ts:22), so a check placed INSIDE it would
// silently skip the treasury. It is called beside runOnce, not within it.
//
// ─── WHY A DAY, AND WHY AN IN-MODULE TIMESTAMP ──────────────────────────────
//
// A cert's notAfter does not move, so re-reading it every 15 minutes buys
// nothing; once a day is ample for a warning measured in weeks. The guard is an
// in-module timestamp rather than a persisted column: no migration, and a
// restart re-checking immediately is DESIRED rather than a defect — a restart is
// exactly when an operator wants to know. `nowMs` is injected, so nothing here
// reads the clock.
//
// ⚠ RESIDUAL, NAMED. On a member node this currently reports to the LOG ONLY.
// The treasury alert path does light up (api/lndFaultAlerts.ts escalates a
// connectivity fault whose cert has lapsed), but a member node has no
// member-facing surface to carry this message — fault detection is treasury-only
// (/api/node/lnd-probe and /api/treasury/alerts are both assertTreasury-gated,
// index.ts:3018-3025 and :1994-1997). Giving the farmer this message on their
// own dashboard is the NEXT piece of this arc, not an optional extra.

import { readLocalCertExpiry } from "./readCertExpiry";
import { certExpiryLevel, certExpiryMessage, type CertExpiryLevel } from "./certExpiry";

/** Once a day. notAfter does not move; a weeks-ahead warning needs no tighter loop. */
export const CERT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastCheckAtMs: number | null = null;

export interface CertCheckOutcome {
  /** false = rate-limited this tick, nothing was read. */
  ran: boolean;
  /** null when rate-limited. */
  level: CertExpiryLevel | null;
  /** null when rate-limited, or when the cert is healthy (level "ok"). */
  message: string | null;
}

/**
 * Inspect the local cert at most once per CERT_CHECK_INTERVAL_MS.
 *
 * Never throws — readLocalCertExpiry turns every filesystem and parse outcome
 * into a result. Logs only when there is something to say: a healthy cert
 * produces no output at all, which is what keeps this quiet on the overwhelming
 * majority of nodes that update into this release with nothing wrong.
 */
export function maybeCheckCertExpiry(nowMs: number): CertCheckOutcome {
  if (lastCheckAtMs !== null && nowMs - lastCheckAtMs < CERT_CHECK_INTERVAL_MS) {
    return { ran: false, level: null, message: null };
  }
  lastCheckAtMs = nowMs;

  const inspection = readLocalCertExpiry(nowMs);
  const level = certExpiryLevel(inspection);
  const message = certExpiryMessage(inspection, nowMs);

  if (message) {
    // One greppable prefix, and the level in the line so `expired` and
    // `expiring_soon` are distinguishable without parsing the sentence.
    const log = level === "expired" ? console.error : console.warn;
    log(`[lnd-cert] ${level}: ${message}`);
  }

  return { ran: true, level, message };
}

/**
 * Clear the rate-limit timestamp. Test seam — the same role
 * `_challengeAuthInternals` (subscription/challengeAuth.ts:142) plays, and what
 * stopMemberAdvisorScheduler() calls so a stopped scheduler leaves no state
 * behind.
 */
export function resetCertExpiryCheckState(): void {
  lastCheckAtMs = null;
}
