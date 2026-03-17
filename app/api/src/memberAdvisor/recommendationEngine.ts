/**
 * Recommendation engine — given a channel classification and loop availability,
 * computes the recommended action with a suggested amount that brings the
 * channel back to the target midpoint.
 *
 * Actions:
 *   none                    — channel is healthy
 *   loop_out                — send-heavy, Loop Out feasible
 *   loop_in                 — receive-heavy, Loop In feasible
 *   channel_resize_required — channel is undersized for Bitcorn payment flow
 *   manual_recovery         — Loop unavailable/uneconomical, member must act
 *
 * Members are responsible for their own spoke-channel replenishment.
 * Treasury does not normally refill member channels with its own funds.
 */

import { db } from "../db";
import type { ChannelClassification } from "./channelClassifier";
import type { LoopAvailability } from "./loopAvailability";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RecommendedAction =
  | "none"
  | "loop_out"
  | "loop_in"
  | "channel_resize_required"
  | "manual_recovery";

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
  minChannelCapacitySat: number;
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
    minChannelCapacitySat: row?.min_channel_capacity_sat ?? 500_000,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(sats: number): string {
  return sats.toLocaleString();
}

// ─── Recommendation ──────────────────────────────────────────────────────────

export function computeRecommendation(
  classification: ChannelClassification,
  loopAvailability: LoopAvailability
): LiquidityRecommendation {
  const now = Date.now();
  const cfg = getConfig();

  // ── Healthy — no action ────────────────────────────────────────────────
  if (classification.state === "healthy") {
    const undersized = classification.capacitySat < cfg.minChannelCapacitySat;
    return {
      action: "none",
      suggestedAmountSats: null,
      projectedMemberLocalPct: null,
      reason: undersized
        ? `Channel is balanced but may be undersized for expected Bitcorn payment flow (${fmt(classification.capacitySat)} sats). ` +
          `Consider opening a larger channel (${fmt(cfg.minChannelCapacitySat)}+ sats).`
        : "Channel is balanced — good capacity to send and receive.",
      urgency: "none",
      loopAvailable: loopAvailability.loopDaemonRunning,
      generatedAt: now,
    };
  }

  // ── Channel undersized? ────────────────────────────────────────────────
  // Bitcorn policy minimum drives this — not Loop's technical minimum.
  const loopMinSats = 250_000; // Loop protocol minimum
  const channelUndersized = classification.capacitySat < cfg.minChannelCapacitySat;

  if (channelUndersized) {
    const isSpendDepleted =
      classification.state === "receive_heavy" ||
      classification.state === "receive_exhausted";

    return {
      action: "channel_resize_required",
      suggestedAmountSats: null,
      projectedMemberLocalPct: null,
      reason: isSpendDepleted
        ? `Spending capacity is critically low. This channel (${fmt(classification.capacitySat)} sats) ` +
          `is too small for practical Bitcorn usage and below the recommended minimum ` +
          `(${fmt(cfg.minChannelCapacitySat)} sats). Open a larger channel to restore reliable spending capacity.`
        : `Receiving capacity is low. This channel (${fmt(classification.capacitySat)} sats) ` +
          `is below the recommended minimum (${fmt(cfg.minChannelCapacitySat)} sats). ` +
          `Open a larger channel to restore reliable receiving capacity.`,
      urgency: classification.urgency,
      loopAvailable: false,
      generatedAt: now,
    };
  }

  // ── Send-heavy states → Loop Out or manual recovery ────────────────────
  if (classification.state === "send_heavy" || classification.state === "send_saturated") {
    const targetSat = Math.round(classification.capacitySat * cfg.targetMidPct);
    let amount = classification.memberLocalSat - targetSat;

    const stateLabel = classification.state === "send_saturated"
      ? "Receiving capacity is critically low"
      : "Receiving capacity is getting low";

    const loopOutMinSats = loopAvailability.loopOutTerms?.minSats ?? loopMinSats;
    const loopOutFeasible = loopAvailability.loopOutAvailable &&
      classification.capacitySat >= loopOutMinSats;

    if (loopOutFeasible && loopAvailability.loopOutTerms) {
      amount = Math.max(amount, loopAvailability.loopOutTerms.minSats);
      amount = Math.min(amount, loopAvailability.loopOutTerms.maxSats);
      amount = Math.min(amount, cfg.maxLoopSats);
      amount = Math.min(amount, classification.memberLocalSat - cfg.floorSats);

      if (amount <= 0 || amount > classification.memberLocalSat - cfg.floorSats) {
        return {
          action: "manual_recovery",
          suggestedAmountSats: null,
          projectedMemberLocalPct: null,
          reason:
            `${stateLabel}, but available balance is too small for a Loop Out. ` +
            "Send a payment to free up inbound capacity.",
          urgency: classification.urgency,
          loopAvailable: true,
          generatedAt: now,
        };
      }

      const projectedLocal = classification.memberLocalSat - amount;
      const projectedPct = classification.capacitySat > 0
        ? projectedLocal / classification.capacitySat : 0;

      return {
        action: "loop_out",
        suggestedAmountSats: amount,
        projectedMemberLocalPct: Math.round(projectedPct * 10000) / 100,
        reason:
          `${stateLabel}. Loop Out withdraws Lightning balance to your Bitcoin wallet ` +
          `and restores your ability to receive.`,
        urgency: classification.urgency,
        loopAvailable: true,
        generatedAt: now,
      };
    }

    // Loop Out not available — manual recovery
    const noLoopReason = !loopAvailability.loopDaemonRunning
      ? "Loop is not installed on this node."
      : "Loop Out is not available.";

    return {
      action: "manual_recovery",
      suggestedAmountSats: null,
      projectedMemberLocalPct: null,
      reason:
        `${stateLabel}. Send a payment to free up inbound capacity. ${noLoopReason}`,
      urgency: classification.urgency,
      loopAvailable: false,
      generatedAt: now,
    };
  }

  // ── Receive-heavy states → Loop In or manual recovery ──────────────────
  if (classification.state === "receive_heavy" || classification.state === "receive_exhausted") {
    const targetSat = Math.round(classification.capacitySat * cfg.targetMidPct);
    let amount = targetSat - classification.memberLocalSat;

    const stateLabel = classification.state === "receive_exhausted"
      ? "Spending capacity is critically low"
      : "Spending capacity is getting low";

    const loopInMinSats = loopAvailability.loopInTerms?.minSats ?? loopMinSats;
    const loopInFeasible = loopAvailability.loopInAvailable &&
      classification.capacitySat >= loopInMinSats;

    if (loopInFeasible && loopAvailability.loopInTerms) {
      amount = Math.max(amount, loopAvailability.loopInTerms.minSats);
      amount = Math.min(amount, loopAvailability.loopInTerms.maxSats);
      amount = Math.min(amount, cfg.maxLoopSats);

      const projectedLocal = classification.memberLocalSat + amount;
      const projectedPct = classification.capacitySat > 0
        ? projectedLocal / classification.capacitySat : 0;

      return {
        action: "loop_in",
        suggestedAmountSats: amount,
        projectedMemberLocalPct: Math.round(projectedPct * 10000) / 100,
        reason:
          `${stateLabel}. Loop In converts on-chain Bitcoin into Lightning balance ` +
          `and restores your ability to pay.`,
        urgency: classification.urgency,
        loopAvailable: true,
        generatedAt: now,
      };
    }

    // Loop In not available — manual recovery
    const noLoopReason = !loopAvailability.loopDaemonRunning
      ? "Loop is not installed on this node."
      : "Loop In is not available.";

    return {
      action: "manual_recovery",
      suggestedAmountSats: null,
      projectedMemberLocalPct: null,
      reason:
        `${stateLabel}. To continue sending, add funds manually or open a larger channel. ${noLoopReason}`,
      urgency: classification.urgency,
      loopAvailable: false,
      generatedAt: now,
    };
  }

  // Fallback
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
