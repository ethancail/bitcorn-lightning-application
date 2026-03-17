/**
 * Member advisor scheduler — runs every 15 minutes on member nodes only.
 * Classifies the treasury channel and persists the classification.
 * No execution — just detection and recording for the UI to display.
 */

import { getNodeInfo } from "../api/read";
import { classifyTreasuryChannel, persistClassification } from "./channelClassifier";
import { ENV } from "../config/env";

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

    if (ENV.debug) {
      console.log(
        `[member-advisor] ${classification.state} (${(classification.memberLocalPct * 100).toFixed(1)}% local, ` +
        `urgency: ${classification.urgency}, consecutive: ${classification.consecutiveNonHealthyRuns})`
      );
    }
  } catch (err: any) {
    console.error("[member-advisor] classification failed:", err?.message);
  }
}

// ─── Start / stop ────────────────────────────────────────────────────────────

export function startMemberAdvisorScheduler(): void {
  // Run on all nodes — the runOnce() guard skips treasury/external.
  // This way, if a node transitions to member role dynamically, it picks up.
  console.log("[member-advisor] starting scheduler (15-min interval, member nodes only)");

  // Run once on startup (after a short delay to let sync complete)
  setTimeout(runOnce, 5_000);

  intervalHandle = setInterval(runOnce, 900_000); // 15 minutes
}

export function stopMemberAdvisorScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
