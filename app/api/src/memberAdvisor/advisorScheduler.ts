/**
 * Member advisor scheduler — runs every 15 minutes on member nodes only.
 * Classifies the treasury channel and persists the classification.
 * No execution — just detection and recording for the UI to display.
 */

import { getNodeInfo } from "../api/read";
import { classifyTreasuryChannel, persistClassification, pruneClassifications } from "./channelClassifier";
import { ENV } from "../config/env";
import {
  maybeCheckCertExpiry,
  resetCertExpiryCheckState,
} from "../lightning/certExpiryCheck";

// ─── State ───────────────────────────────────────────────────────────────────

let intervalHandle: ReturnType<typeof setInterval> | null = null;

// ─── Single run ──────────────────────────────────────────────────────────────

function runOnce(): void {
  try {
    const node = getNodeInfo();

    // Only run on member nodes (not treasury, not external)
    if (!node || node.node_role === "treasury") return;

    const classification = classifyTreasuryChannel();
    if (!classification) return;

    persistClassification(classification);

    // Retention: drop classification rows older than the window (idempotent;
    // one tiny DELETE per 15-min run). See pruneClassifications for rationale.
    const pruned = pruneClassifications();

    if (ENV.debug) {
      console.log(
        `[member-advisor] ${classification.state} (${(classification.memberLocalPct * 100).toFixed(1)}% local, ` +
        `urgency: ${classification.urgency}, consecutive: ${classification.consecutiveNonHealthyRuns})` +
        (pruned > 0 ? ` — pruned ${pruned} old rows` : "")
      );
    }
  } catch (err: any) {
    console.error("[member-advisor] classification failed:", err?.message);
  }
}

// ─── Start / stop ────────────────────────────────────────────────────────────

/**
 * One scheduler tick: the member-only classification, plus the role-agnostic
 * cert-expiry check.
 *
 * ⚠ THE CERT CHECK IS CALLED BESIDE runOnce(), NOT INSIDE IT. runOnce returns
 * early for treasury nodes (see its guard above), and a certificate expires the
 * same way on every role — placing the check inside would have silently skipped
 * the treasury. Its own day-scale rate limit means it does real work on roughly
 * one tick in 96; the rest are a timestamp comparison.
 *
 * maybeCheckCertExpiry never throws (every filesystem and parse outcome is a
 * result), and runOnce has its own try/catch, so neither can stop the other.
 */
function tick(): void {
  runOnce();
  maybeCheckCertExpiry(Date.now());
}

export function startMemberAdvisorScheduler(): void {
  // Run on all nodes — the runOnce() guard skips treasury/external, and the
  // cert check deliberately applies to every role.
  console.log(
    "[member-advisor] starting scheduler (15-min interval; channel classification " +
      "on member nodes, TLS cert-expiry check on all roles once a day)",
  );

  // Run once on startup (after a short delay to let sync complete)
  setTimeout(tick, 5_000);

  intervalHandle = setInterval(tick, 900_000); // 15 minutes
}

export function stopMemberAdvisorScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  // A stopped scheduler leaves no state behind, so a restart re-checks the cert
  // immediately rather than inheriting a stale rate-limit timestamp.
  resetCertExpiryCheckState();
}
