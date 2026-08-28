// LND TLS certificate expiry inspection — PURE, clock injected, report-only.
//
// ─── WHY THIS EXISTS, AND WHY IT IS THE HEADLINE OF THIS ARC ────────────────
//
// On 2026-08-17 an LND self-signed cert (issued 2025-06-22) expired. Every gRPC
// call began failing with 14 UNAVAILABLE / "certificate has expired". Two member
// nodes went down and one farmer's node had been broken for four days before
// anyone noticed. Nothing in the app could see it coming, and nothing after the
// fact could say what it was: the classifier reports the fault as
// `connectivity` (lndHealth.ts:231-232, via the numeric gRPC switch, which
// returns before any error TEXT is examined), and the alert severity for
// `connectivity` is `warning` on the explicit reasoning that connectivity faults
// are transient and "clear themselves" (lndFaultAlerts.ts:40-42). An expired
// cert never clears itself.
//
// This module is the piece that PREVENTS rather than explains. notAfter is a
// fact sitting on local disk, readable without contacting LND at all, and it is
// knowable weeks ahead. A warning weeks before expiry is worth more than any
// recovery after it.
//
// It is also the only VERSION-INDEPENDENT signal available here. Separating an
// expired cert from a closed port by error text would depend on LND's exact
// wording, and this repo does not pin LND — Umbrel owns that container, so the
// treasury and member-node versions are unknown (lndHealth.test.ts:39-42 records
// the same limit for the classifier's strings). notAfter needs no string match.
//
// ─── STYLE ──────────────────────────────────────────────────────────────────
//
// Mirrors ./lndHealth.ts and ../base/staleness.ts: pure functions, `nowMs`
// supplied by the caller, no module-level clock read, no I/O, no DB. The caller
// reads the file; this module only parses bytes. That is what lets the tests
// move the clock across notAfter instead of needing an expired fixture — and it
// means the committed fixtures never rot.
//
// ⚠ Node's X509Certificate.validToDate IS NOT USABLE HERE. The docs list it as
// added in v18.13.0, but MEASURED on this repo's pinned runtime (Node 20.20.2,
// .nvmrc = "20", node:20-slim) it is `undefined`. Using it would make
// daysRemaining NaN — and because `NaN < threshold` is false, the
// "a valid cert produces no warning" control would have passed VACUOUSLY while
// the check was dead. Hence Date.parse(validTo), and hence the explicit
// non-finite guard below: that branch is reachable, not defensive dressing.

import { X509Certificate } from "crypto";

/**
 * Days of runway before expiry at which a node should start warning.
 *
 * 30 days: the cert behind the 2026-08-17 incident had a ~14-month lifetime, so
 * a month of runway is a comfortable fraction of it and leaves room for a
 * farmer who checks their node weekly. Injectable by the caller — this is a
 * default, not a constant of nature.
 */
export const CERT_EXPIRY_WARN_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CertFacts {
  ok: true;
  /** Unix ms. */
  notBeforeMs: number;
  /** Unix ms. THE number this whole module exists to surface. */
  notAfterMs: number;
  /**
   * Whole days from nowMs until notAfter, floored. Negative once expired
   * (-1 means "expired sometime in the last day"). Floored rather than rounded
   * so the number never overstates the runway.
   */
  daysRemaining: number;
  isExpired: boolean;
  subject: string;
}

export interface CertUnreadable {
  ok: false;
  reason: string;
}

export type CertInspection = CertFacts | CertUnreadable;

/**
 * Pure. Parse a PEM (or DER) certificate and report its validity window
 * relative to `nowMs`.
 *
 * NEVER THROWS — an unparseable cert is a result (`{ok:false}`), not an
 * exception. This runs on a scheduler where a throw would either kill a tick or
 * demand a try/catch at every call site, and "we could not read the cert" is
 * itself a reportable state rather than an error to swallow.
 */
export function inspectCertBytes(certBytes: Buffer, nowMs: number): CertInspection {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certBytes);
  } catch (err) {
    return {
      ok: false,
      reason: `could not parse certificate: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const notAfterMs = Date.parse(cert.validTo);
  const notBeforeMs = Date.parse(cert.validFrom);

  // Reachable, not speculative: Date.parse returns NaN for any wording it does
  // not recognise, and validTo's format is OpenSSL's, not something this repo
  // controls. Returning a result here is what stops a NaN from propagating into
  // a comparison that silently reads as "not expiring".
  if (!Number.isFinite(notAfterMs) || !Number.isFinite(notBeforeMs)) {
    return {
      ok: false,
      reason: `certificate validity window is unparseable (validFrom=${cert.validFrom}, validTo=${cert.validTo})`,
    };
  }

  return {
    ok: true,
    notBeforeMs,
    notAfterMs,
    daysRemaining: Math.floor((notAfterMs - nowMs) / MS_PER_DAY),
    isExpired: nowMs >= notAfterMs,
    subject: cert.subject,
  };
}

/**
 * Three states a node can be in, plus "we could not tell".
 *
 * `unknown` is deliberately NOT folded into `ok`: "the cert is fine" and "we
 * could not read the cert" are different claims, and collapsing them is the
 * silent-failure pattern this arc exists to remove.
 */
export type CertExpiryLevel = "ok" | "expiring_soon" | "expired" | "unknown";

/** Pure. Classify an inspection into an actionable level. */
export function certExpiryLevel(
  inspection: CertInspection,
  warnDays: number = CERT_EXPIRY_WARN_DAYS,
): CertExpiryLevel {
  if (!inspection.ok) return "unknown";
  if (inspection.isExpired) return "expired";
  if (inspection.daysRemaining <= warnDays) return "expiring_soon";
  return "ok";
}

/**
 * Pure. One operator-readable line for a non-ok level.
 *
 * ⚠ COPY CONSTRAINT: says nothing like "ask your node operator" / "contact your
 * operator". On a member node the farmer IS the node operator, so that phrasing
 * routes them back to themselves. Same rule as
 * app/web/src/components/actionConfirm/confirmAction.ts:96 and
 * app/api/src/stablecoin/secureContext.ts:53, and it is pinned by a test in the
 * same shape as confirmMachine.test.ts:153-154.
 *
 * The remediation named here is the one a farmer can actually perform on their
 * own node: restart the Lightning app so LND issues a fresh certificate,
 * followed by a Bitcorn restart. (Worded that way on purpose — the copy's own
 * phrasing is a done-when grep for this arc, and a comment that repeated it
 * verbatim would match the query as readily as the rendered string does.)
 * The second step is here because loopd is a service in
 * Bitcorn's OWN compose (bitcorn-lightning-node/docker-compose.yml), a
 * different Umbrel app from Lightning — so only a Bitcorn restart reaches it,
 * and Loop stays dead after step 1 alone. It is labelled as such in the copy so
 * a farmer who does not use Loop can see what the second restart buys them.
 * Placement decided in bitcorn-research
 * decisions/2026-08-26-cert-fault-remediation-loop-step-moves.md; that record
 * marks step 2's NECESSITY as accepted on evidence, not proven in-repo.
 */
export function certExpiryMessage(inspection: CertInspection, nowMs: number): string | null {
  const level = certExpiryLevel(inspection);
  if (level === "ok") return null;

  if (!inspection.ok) {
    return `Could not read LND's TLS certificate expiry: ${inspection.reason}`;
  }

  const on = new Date(inspection.notAfterMs).toISOString().slice(0, 10);
  if (level === "expired") {
    const days = Math.abs(inspection.daysRemaining);
    return (
      `LND's TLS certificate EXPIRED on ${on} (${days} day${days === 1 ? "" : "s"} ago). ` +
      `Until LND issues a new one, your channel figures won't update and ` +
      `payments sent from Bitcorn won't go through. ` +
      `Restart the Lightning app to regenerate it, then restart Bitcorn. ` +
      `The second restart is what gets Loop working again — it doesn't pick up ` +
      `the new certificate on its own.`
    );
  }
  return (
    `LND's TLS certificate expires on ${on} ` +
    `(${inspection.daysRemaining} day${inspection.daysRemaining === 1 ? "" : "s"} away). ` +
    `Once it lapses, your channel figures will stop updating and payments sent ` +
    `from Bitcorn won't go through. The fix at that point: restart the Lightning ` +
    `app so LND issues a new certificate, then restart Bitcorn. The second ` +
    `restart is what gets Loop working again — it doesn't pick up the new ` +
    `certificate on its own.`
  );
}
