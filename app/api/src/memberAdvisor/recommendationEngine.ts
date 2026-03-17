/**
 * Recommendation engine — given a channel classification and loop availability,
 * computes the recommended action (loop_out, loop_in, or none) with a
 * suggested amount that brings the channel back to the target midpoint.
 */

import { db } from "../db";
import type { ChannelClassification } from "./channelClassifier";
import type { LoopAvailability } from "./loopAvailability";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RecommendedAction = "none" | "loop_out" | "loop_in";

export interface LiquidityRecommendation {
  action: RecommendedAction;
  suggestedAmountSats: number | null;
  projectedMemberLocalPct: number | null;
  reason: string;
  urgency: "none" | "low" | "medium" | "high";
  loopAvailable: boolean;
  generatedAt: number;
}

// ─── Config ──────────────────────────────────────────────────────────────────

interface RecommendationConfig {
  targetMidPct: number;
  minLoopSats: number;
  maxLoopSats: number;
  floorSats: number;
}

function getConfig(): RecommendationConfig {
  const row = db
    .prepare("SELECT * FROM member_liquidity_advisor_config WHERE id = 1")
    .get() as any;

  return {
    targetMidPct: row?.target_mid_pct ?? 0.50,
    minLoopSats: row?.min_loop_sats ?? 50_000,
    maxLoopSats: row?.max_loop_sats ?? 2_000_000,
    floorSats: row?.floor_sats ?? 10_000,
  };
}

// ─── Recommendation ──────────────────────────────────────────────────────────

export function computeRecommendation(
  classification: ChannelClassification,
  loopAvailability: LoopAvailability
): LiquidityRecommendation {
  const now = Date.now();
  const cfg = getConfig();

  // Healthy — no action needed
  if (classification.state === "healthy") {
    return {
      action: "none",
      suggestedAmountSats: null,
      projectedMemberLocalPct: null,
      reason: "Channel is balanced — good capacity to send and receive.",
      urgency: "none",
      loopAvailable: loopAvailability.loopDaemonRunning,
      generatedAt: now,
    };
  }

  // Send-heavy states (member-local too high) → recommend Loop Out
  if (classification.state === "send_heavy" || classification.state === "send_saturated") {
    const targetSat = Math.round(classification.capacitySat * cfg.targetMidPct);
    let amount = classification.memberLocalSat - targetSat;

    // Clamp to Loop terms if available
    if (loopAvailability.loopOutAvailable && loopAvailability.loopOutTerms) {
      amount = Math.max(amount, loopAvailability.loopOutTerms.minSats);
      amount = Math.min(amount, loopAvailability.loopOutTerms.maxSats);
    } else {
      amount = Math.max(amount, cfg.minLoopSats);
    }

    // Cap at max loop sats
    amount = Math.min(amount, cfg.maxLoopSats);

    // Never drain below floor
    amount = Math.min(amount, classification.memberLocalSat - cfg.floorSats);

    // If amount is too small after capping, still suggest it but note it
    if (amount < cfg.minLoopSats) {
      amount = cfg.minLoopSats;
    }

    // Can't exceed what we have
    if (amount > classification.memberLocalSat - cfg.floorSats) {
      return {
        action: "loop_out",
        suggestedAmountSats: null,
        projectedMemberLocalPct: null,
        reason:
          "Receiving capacity is low but available balance is too small for a Loop Out. " +
          "Consider sending a payment to free up inbound capacity.",
        urgency: classification.urgency,
        loopAvailable: loopAvailability.loopOutAvailable,
        generatedAt: now,
      };
    }

    const projectedLocal = classification.memberLocalSat - amount;
    const projectedPct = classification.capacitySat > 0
      ? projectedLocal / classification.capacitySat
      : 0;

    const stateLabel = classification.state === "send_saturated"
      ? "Receiving capacity is critically low"
      : "Receiving capacity is getting low";

    return {
      action: "loop_out",
      suggestedAmountSats: amount,
      projectedMemberLocalPct: Math.round(projectedPct * 10000) / 100,
      reason:
        `${stateLabel}. Loop Out withdraws Lightning balance to your Bitcoin wallet ` +
        `and restores your ability to receive.`,
      urgency: classification.urgency,
      loopAvailable: loopAvailability.loopOutAvailable,
      generatedAt: now,
    };
  }

  // Receive-heavy states (member-local too low) → recommend Loop In
  if (classification.state === "receive_heavy" || classification.state === "receive_exhausted") {
    const targetSat = Math.round(classification.capacitySat * cfg.targetMidPct);
    let amount = targetSat - classification.memberLocalSat;

    // Clamp to Loop In terms if available
    if (loopAvailability.loopInAvailable && loopAvailability.loopInTerms) {
      amount = Math.max(amount, loopAvailability.loopInTerms.minSats);
      amount = Math.min(amount, loopAvailability.loopInTerms.maxSats);
    } else {
      amount = Math.max(amount, cfg.minLoopSats);
    }

    amount = Math.min(amount, cfg.maxLoopSats);

    const projectedLocal = classification.memberLocalSat + amount;
    const projectedPct = classification.capacitySat > 0
      ? projectedLocal / classification.capacitySat
      : 0;

    const stateLabel = classification.state === "receive_exhausted"
      ? "Spending capacity is critically low"
      : "Spending capacity is getting low";

    return {
      action: "loop_in",
      suggestedAmountSats: amount,
      projectedMemberLocalPct: Math.round(projectedPct * 10000) / 100,
      reason:
        `${stateLabel}. Loop In converts on-chain Bitcoin into Lightning balance ` +
        `and restores your ability to pay.`,
      urgency: classification.urgency,
      loopAvailable: loopAvailability.loopInAvailable,
      generatedAt: now,
    };
  }

  // Fallback (shouldn't happen)
  return {
    action: "none",
    suggestedAmountSats: null,
    projectedMemberLocalPct: null,
    reason: "Unable to determine recommendation.",
    urgency: "none",
    loopAvailable: loopAvailability.loopDaemonRunning,
    generatedAt: now,
  };
}
