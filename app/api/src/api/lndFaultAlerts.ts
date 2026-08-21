// Turns an LND probe report into treasury alerts. PURE — no DB, no gRPC, no
// clock read, no I/O. `nowMs` is supplied by the caller, exactly as
// lightning/lndHealth.ts does it.
//
// WHY A SEPARATE MODULE. treasury-alerts.ts is a live capital-facing surface and
// this arc is report-only, so its production signature does not change and it
// gains no dependency-injection seam. The classification therefore lives here,
// where it can be tested directly against the classifier's real 0.20.0-beta
// captures with nothing mocked. treasury-alerts.ts gets a thin call, and the
// mocked wiring test covers only that seam.
//
// ─── WHAT THIS EXISTS TO FIX ────────────────────────────────────────────────
//
// treasury-alerts.ts's on-chain reserve check was wrapped in
// `catch { /* LND unavailable — skip reserve check */ }`. Two defects, both
// MEASURED against the unmodified function before this was written:
//
//   (a) An LND fault produced no alert of any kind. The classifier could
//       separate auth from permission on identical gRPC 2; this surface emitted
//       nothing for either, so they were equally invisible.
//   (b) ONCHAIN_RESERVE_BREACHED / _NEAR simply vanished, leaving the returned
//       array BYTE-IDENTICAL to a comfortably-funded treasury. A capital
//       guardrail read healthy because it was silent, not because it passed.
//       That is the more dangerous of the two, so it gets its own alert type
//       rather than being folded into the fault alert.
//
// ─── SEVERITY, AND WHY THESE SIX MAP THE WAY THEY DO ────────────────────────
//
// The six kinds are not equally actionable at 2am, which is the only time the
// mapping matters.
//
//   auth / permission / files_absent -> CRITICAL. None self-heal. A rejected,
//     under-scoped, or absent credential needs a human, and `permission` is
//     specifically the state that silently freezes lnd_channels while
//     /api/node/balances still returns 200.
//   malformed -> WARNING. Real but ambiguous: it is also the classifier's
//     unrecognised-fault fallback (lndHealth.ts:251-252), so it can mean "a
//     wording no rule matched" rather than a definite fault. Escalating an
//     unknown teaches the operator to ignore criticals.
//   connectivity -> WARNING. The one genuinely transient kind: a restarting
//     LND, a container bounce, a brief network blip all land here and clear
//     themselves.
//   ok -> no alert.
//
// ⚠ KNOWN UNDER-WEIGHTING, RECORDED DELIBERATELY. A WEDGED-but-connected LND
// also surfaces as `connectivity` — that is the documented cost of bounding the
// probe by a deadline instead of adding a seventh kind (see
// lightning/lndProbeRoute.ts). A permanently wedged LND is as serious as a
// broken credential, and this mapping calls it a warning. The remedy is the
// SEVENTH KIND deliberately deferred from this arc, not a severity escalation
// that would also fire on every container bounce — alert fatigue on a surface
// with exactly one human consumer is the worse failure. The distinction remains
// readable in `detail`, which carries ETIMEDOUT for the wedged case.
//
// ⚠ `info` IS NOT USED, AND THAT IS NOT AN OVERSIGHT.
// app/web/src/pages/Dashboard.tsx renders only `critical` and `warning`
// (`activeAlerts` filter), so an `info` alert is INVISIBLE to the only human
// who consumes this surface. Mapping any LND fault to `info` would ship a
// signal nobody sees — this arc's own defect, one layer up.

import type { LndFaultKind, LndHealthReport } from "../lightning/lndHealth";
import type { AlertSeverity, TreasuryAlert } from "./treasury-alerts";
import type { CertInspection } from "../lightning/certExpiry";

/** Alert type emitted when at least one scope reports a non-ok kind. */
export const LND_FAULT_ALERT = "LND_FAULT";

/**
 * Alert type emitted whenever the on-chain reserve check could not run.
 * DISTINCT from LND_FAULT on purpose: the fault is WHY the check is missing,
 * this is WHAT that costs. A consumer must be able to tell "reserve is fine"
 * from "nobody checked" without inspecting the fault.
 */
export const RESERVE_CHECK_SKIPPED_ALERT = "ONCHAIN_RESERVE_CHECK_SKIPPED";

/** null = emits no alert. See the reasoning block above for each choice. */
export const SEVERITY_BY_KIND: Record<LndFaultKind, AlertSeverity | null> = {
  ok: null,
  auth: "critical",
  permission: "critical",
  files_absent: "critical",
  malformed: "warning",
  connectivity: "warning",
};

const SEVERITY_RANK: Record<AlertSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

/**
 * Pure. Highest severity among the faulted scopes.
 *
 * NOTE ON WHAT THIS IS AND IS NOT. TreasuryAlert carries exactly one `severity`
 * field and this arc does not reshape it, so one value has to be chosen for
 * display. That is a DISPLAY PRIORITY, not an aggregate verdict: every scope's
 * kind stays individually readable in `data.scopes`, including the ok ones, so
 * the partial case (onchain alive, offchain lost) is still visible. The thing
 * this arc refuses to do is collapse the KINDS.
 */
function worstSeverity(kinds: LndFaultKind[]): AlertSeverity {
  let worst: AlertSeverity = "warning";
  for (const kind of kinds) {
    const sev = SEVERITY_BY_KIND[kind];
    if (sev && SEVERITY_RANK[sev] > SEVERITY_RANK[worst]) worst = sev;
  }
  return worst;
}

/**
 * Pure. An expired TLS certificate turns a `connectivity` fault from transient
 * into permanent, so it changes the severity — and the CLASSIFIER IS NOT THE
 * PLACE TO FIX THAT.
 *
 * WHY HERE AND NOT IN classifyLndError. An expired cert arrives as gRPC 14
 * UNAVAILABLE, which the classifier resolves at its NUMERIC switch
 * (lndHealth.ts:231-232) and returns from before the error TEXT is ever read —
 * so `certificate has expired` is never examined. Making the classifier read it
 * would mean inverting its documented numeric-wins-over-text invariant
 * (lndHealth.ts:200-204) for one gRPC code, and separating the cases by wording
 * would bind us to LND's exact strings on a dependency this repo does not pin.
 *
 * The alert PRODUCER is the right seam because it is where severity is decided,
 * and because the disk fact is available here without any LND call at all.
 * SEVERITY_BY_KIND above justifies `connectivity -> warning` on transience —
 * "a restarting LND, a container bounce, a brief network blip all land here and
 * clear themselves". A lapsed cert is precisely the case where that reasoning
 * does not hold, and notAfter in the past is precisely the proof that it does
 * not. So the map stays correct and this composes on top of it.
 *
 * ⚠ Requires `connectivity` among the faulted kinds. An expired cert with no
 * connectivity fault is not a thing this can observe (the calls would be
 * failing), and escalating on the cert alone would fire on a healthy node whose
 * cert simply happens to be old — a false critical.
 */
function certEscalation(
  kinds: LndFaultKind[],
  certExpiry: CertInspection | null | undefined,
): { severity: AlertSeverity; note: string } | null {
  if (!kinds.includes("connectivity")) return null;
  if (!certExpiry || !certExpiry.ok || !certExpiry.isExpired) return null;

  const on = new Date(certExpiry.notAfterMs).toISOString().slice(0, 10);
  const days = Math.abs(certExpiry.daysRemaining);
  return {
    severity: "critical",
    note:
      ` — NOT TRANSIENT: LND's TLS certificate EXPIRED on ${on} ` +
      `(${days} day${days === 1 ? "" : "s"} ago), so this will not clear on its own. ` +
      `Restart the Lightning app so LND issues a new certificate.`,
  };
}

/**
 * Pure. Build the alerts for a reserve check that could not run.
 *
 * Called ONLY from treasury-alerts.ts's reserve catch site, so the skipped
 * signal is unconditional: reaching here means the guardrail did not run,
 * whatever the probe subsequently found.
 *
 * Returns up to two alerts:
 *   - RESERVE_CHECK_SKIPPED_ALERT, always.
 *   - LND_FAULT_ALERT, only when a scope actually reports a fault.
 *
 * The probe covering ALL THREE scopes is the point (arc decision 2): the
 * reserve call alone uses onchain:read, and one scope cannot distinguish a
 * narrowed credential from a broken one.
 */
export function lndFaultAlerts(
  report: LndHealthReport,
  nowMs: number,
  opts: {
    minOnchainReserveSats: number;
    /**
     * The local tls.cert's validity window, if the caller could read it.
     * OPTIONAL, and absent means "no escalation" — so every existing caller and
     * every existing test keeps its current severities unchanged. See
     * certEscalation above for why this fact lives here rather than in the
     * classifier.
     */
    certExpiry?: CertInspection | null;
  },
): TreasuryAlert[] {
  const faulted = report.scopes.filter((s) => s.kind !== "ok");
  const kinds = [...new Set(faulted.map((s) => s.kind))].sort();

  const alerts: TreasuryAlert[] = [];

  // ── The guardrail did not run. Always. ──
  alerts.push({
    type: RESERVE_CHECK_SKIPPED_ALERT,
    severity: "critical",
    message: faulted.length
      ? `On-chain reserve check DID NOT RUN — LND fault (${kinds.join(", ")}). ` +
        `The ${opts.minOnchainReserveSats} sat floor is unverified; this is not a passing check.`
      : `On-chain reserve check DID NOT RUN, but the follow-up probe found no fault ` +
        `— likely transient. The ${opts.minOnchainReserveSats} sat floor is unverified for this cycle.`,
    data: {
      min_reserve_sats: opts.minOnchainReserveSats,
      reason: faulted.length ? "lnd_fault" : "transient",
      kinds,
      checked_at: report.checked_at,
    },
    at: nowMs,
  });

  // ── The fault itself, carrying the KIND per scope. ──
  if (faulted.length > 0) {
    const base = worstSeverity(faulted.map((s) => s.kind));
    const escalation = certEscalation(kinds, opts.certExpiry);
    // max(), not override: an `auth` fault is already critical and must not be
    // walked back by a cert that happens to be fine.
    const severity =
      escalation && SEVERITY_RANK[escalation.severity] > SEVERITY_RANK[base]
        ? escalation.severity
        : base;

    alerts.push({
      type: LND_FAULT_ALERT,
      severity,
      message:
        `LND fault: ` +
        faulted.map((s) => `${s.scope} ${s.kind}`).join(", ") +
        (report.files_present ? "" : " (tls.cert and/or macaroon absent on disk)") +
        (escalation ? escalation.note : ""),
      data: {
        kinds,
        // Present only when the caller supplied it. `null` distinguishes
        // "read the cert, it is fine" from "did not look".
        cert_expiry:
          opts.certExpiry === undefined
            ? undefined
            : opts.certExpiry && opts.certExpiry.ok
              ? {
                  not_after_ms: opts.certExpiry.notAfterMs,
                  days_remaining: opts.certExpiry.daysRemaining,
                  is_expired: opts.certExpiry.isExpired,
                }
              : null,
        // All three scopes, not just the faulted ones — the partial case is
        // only legible if the healthy scopes are visible alongside the broken.
        scopes: report.scopes,
        files_present: report.files_present,
        probe_calls_attempted: report.probe_calls_attempted,
        checked_at: report.checked_at,
      },
      at: nowMs,
    });
  }

  return alerts;
}
