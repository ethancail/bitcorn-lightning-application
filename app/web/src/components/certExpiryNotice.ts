// Whether to tell the farmer their LND certificate is running out, and in what
// register. Derived, not inlined — same shape as ./channelStaleness.ts.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// On 2026-08-17 an LND self-signed cert expired. Every gRPC call began failing,
// two member nodes went down, and one farmer's node had been broken for four
// days before anyone noticed. v1.18.7 shipped the detection — the API now reads
// notAfter off local disk once a day and can classify it weeks ahead — but on a
// member node it reported to the LOG ONLY. The alert surface that consumes it,
// /api/treasury/alerts, is gated by assertTreasury(node_role), so a farmer's own
// node could see its cert dying and had nowhere to say so.
//
// This is the display half. The API sends the level and the sentence; this
// decides whether the farmer sees it and how loudly.
//
// ─── THE COPY IS THE API's, DELIBERATELY ────────────────────────────────────
//
// No remediation prose is written here. The shipped strings (certExpiry.ts:157-
// 180) are ONE STEP — "Restart the Lightning app to regenerate it." — and they
// name Bitcorn nowhere. That is the property that has to survive, and the way
// to make it survive is to have exactly one place where those sentences exist.
// Re-authoring them here would fork them the first time either side changed.
//
// ⚠ COPY CONSTRAINT: nothing rendered here may say "ask your node operator" or
// "contact your operator". On a member node the farmer IS the node operator, so
// that phrasing routes them back to themselves. Same rule as
// ./channelStaleness.ts:21-25, ./actionConfirm/confirmAction.ts:96 and
// ../stablecoin/secureContext.ts:53, pinned by a test in the same shape as
// ./actionConfirm/confirmAction.test.ts:160-170 — including that file's
// anti-vacuity check, so the ban list cannot all be wrong and pass silently.
//
// ⚠ AND IT MUST READ CORRECTLY TO SOMEONE WHOSE NODE IS FINE. This ships as a
// release and members update by clicking, so it lands on a large majority of
// healthy nodes. For them this returns null and the dashboard is pixel-identical
// to before. Pinned by a paired control: mutating the `ok` return to always
// render turns the healthy-node test red.

/**
 * Days of runway at which the DASHBOARD starts warning.
 *
 * ⚠ ONE CONSTANT, ONE FILE — so narrowing the dashboard's threshold is a
 * one-line change here rather than an API change plus a redeploy.
 *
 * It defaults to the API's own CERT_EXPIRY_WARN_DAYS (certExpiry.ts:53), so out
 * of the box this re-derives exactly what the API already classified and
 * changes nothing. Lowering it makes the dashboard QUIETER than the API — the
 * API keeps classifying at 30 days for the log and the treasury alert path,
 * while the farmer's banner holds off. Raising it above the API's threshold
 * does nothing: the API never sends `expiring_soon` earlier than its own 30, so
 * this can narrow the window but cannot widen it.
 */
export const CERT_EXPIRY_WARN_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type CertExpiryLevel = "ok" | "expiring_soon" | "expired" | "unknown";

/** The `cert_expiry` field of /api/member/stats. */
export interface CertExpiryInput {
  level: CertExpiryLevel;
  message: string | null;
  not_after_ms: number | null;
}

export interface CertExpiryNotice {
  severity: "warning" | "critical";
  text: string;
}

/**
 * Pure. Decide whether to say anything about the certificate's expiry.
 *
 * Returns null when there is nothing to say. `nowMs` is injected by the caller,
 * matching ./channelStaleness.ts and ./freshness.ts — this module reads no
 * clock and touches no filesystem.
 */
export function certExpiryNotice(
  cert: CertExpiryInput | null | undefined,
  nowMs: number,
  warnDays: number = CERT_EXPIRY_WARN_DAYS,
): CertExpiryNotice | null {
  // Not loaded yet, or the API's own read threw. Either way we know nothing,
  // and a dashboard that has not finished loading must not accuse the node of
  // anything. Silence is the honest default here, not a fallback.
  if (!cert) return null;

  // The overwhelmingly common case, and the one that has to stay silent.
  if (cert.level === "ok") return null;

  // ⚠ `unknown` IS SUPPRESSED HERE, AND ONLY HERE. The API keeps it distinct
  // from `ok` on purpose and must go on doing so — "the cert is fine" and "we
  // could not read the cert" are different claims. But it is the wrong thing to
  // put in front of a farmer:
  //
  //   · Its string is a raw errno ("ENOENT: no such file or directory, open
  //     '/lnd/tls.cert'"), which is the jargon register
  //     ../stablecoin/secureContext.test.ts:37-41 bans from member copy.
  //   · It names no remediation, because there is none to name.
  //   · On a node with no Lightning app installed it is the PERMANENT steady
  //     state — /lnd is simply not there — so surfacing it would put an
  //     unfixable warning on that node forever. That is precisely the
  //     healthy-node harm this arc's copy constraint exists to prevent.
  //
  // The signal is not lost: it still reaches the log and still travels on the
  // wire, so a future surface can consume it without an API change.
  if (cert.level === "unknown") return null;

  // Non-ok levels always carry a sentence (certExpiry.ts:161-179). If one ever
  // does not, there is nothing to render and inventing prose here would fork
  // the copy this module deliberately does not own.
  if (!cert.message) return null;

  // Already lapsed. Lightning calls are failing right now and will keep failing
  // until LND issues a new certificate — nothing about this clears on its own,
  // which is exactly why the treasury path escalates the same state from
  // warning to critical (lndFaultAlerts.ts:137-153).
  if (cert.level === "expired") {
    return { severity: "critical", text: cert.message };
  }

  // ── expiring_soon ──
  //
  // Re-derive the runway from not_after_ms rather than trusting the level
  // alone, so `warnDays` above is a real threshold and not decoration. Floored,
  // matching certExpiry.ts:118, so the number never overstates the runway.
  if (cert.not_after_ms != null) {
    const daysRemaining = Math.floor((cert.not_after_ms - nowMs) / MS_PER_DAY);
    if (daysRemaining > warnDays) return null;
  }

  return { severity: "warning", text: cert.message };
}
