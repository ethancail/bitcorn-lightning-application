/**
 * Role-aware recommendation engine.
 *
 * Given a channel classification (objective balance data + channel role)
 * and loop availability, computes the recommended action.
 *
 * Decision model by role:
 *
 *   MERCHANT (send-first channel — member funded, sends payments through treasury)
 *     healthy:              outbound capacity sufficient, no action
 *     low outbound:         member local < 30%, recommend Loop In
 *     depleted:             member local < 15%, recommend Loop In urgently
 *     structurally undersized: capacity below recommended OR repeated exhaustion → upgrade
 *
 *   FARMER (receive-first channel — earns through treasury)
 *     healthy:              receiving capacity sufficient, no action
 *     getting full:         member local > 70%, recommend Loop Out
 *     full:                 member local > 85%, recommend Loop Out urgently
 *     structurally undersized: capacity below recommended OR repeated filling → upgrade
 *
 *   UNKNOWN (role not yet set)
 *     Generic balanced guidance — prompts user to set their role.
 *
 * Important: Loop In does NOT directly edit the channel. It adds Lightning
 * liquidity from outside, restoring the merchant's ability to keep sending.
 * Close/reopen is NOT the standard maintenance path — only for structural undersizing.
 */

import { db } from "../db";
import type { ChannelClassification, ChannelRole } from "./channelClassifier";
import type { LoopAvailability } from "./loopAvailability";

// ─── Types ───────────────────────────────────────────────────────────────────

export type RecommendedAction =
  | "none"
  | "loop_out"
  | "loop_in"
  | "channel_upgrade"
  | "manual_recovery"
  | "set_role";

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
  merchantRecommendedCapacitySat: number;
  farmerRecommendedCapacitySat: number;
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
    merchantRecommendedCapacitySat: row?.merchant_recommended_capacity_sat ?? 2_000_000,
    farmerRecommendedCapacitySat: row?.farmer_recommended_capacity_sat ?? 1_000_000,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(sats: number): string {
  return sats.toLocaleString();
}

/**
 * Human phrase for how long the channel has stayed non-healthy.
 *
 * consecutiveNonHealthyRuns advances once per 15-minute scheduler run (the
 * only persist site — see advisorScheduler.ts and the 2026-07-09 counter
 * fix), so runs ≈ runs × 15 minutes of sustained state. Members shouldn't
 * read "N consecutive runs" (scheduler jargon); they get a duration. The
 * "more than a day" cap keeps legacy inflated counters (rows written before
 * the counter fix) from rendering absurd durations.
 */
export function describeSustainedRuns(runs: number): string {
  const minutes = runs * 15;
  if (minutes <= 60) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"}`;
  return "more than a day";
}

const LOOP_PROTOCOL_MIN = 250_000;

// ─── Role: UNKNOWN ──────────────────────────────────────────────────────────

function recommendUnknown(
  c: ChannelClassification,
  _loop: LoopAvailability,
  _cfg: RecommendationConfig,
): LiquidityRecommendation {
  const now = Date.now();

  if (c.state === "healthy") {
    return {
      action: "set_role",
      suggestedAmountSats: null,
      projectedMemberLocalPct: null,
      reason:
        "Channel is balanced. Set your channel role (merchant or farmer) in Settings " +
        "to get tailored liquidity recommendations.",
      urgency: "none",
      loopAvailable: false,
      generatedAt: now,
    };
  }

  // Non-healthy but no role — still prompt to set role with context
  const localPctDisplay = Math.round(c.memberLocalPct * 100);
  const highLocal = c.memberLocalPct >= 0.70;
  return {
    action: "set_role",
    suggestedAmountSats: null,
    projectedMemberLocalPct: null,
    // Member-facing copy per decisions/2026-07-09-ui-vocabulary-canonical-terms.md
    // (F2 pass): plain language, no "outbound capacity" on member surfaces.
    reason: highLocal
      ? `Your channel is ${localPctDisplay}% on your side. If you are a merchant, that means ` +
        `plenty of room to send. If you are a farmer, your channel is filling up. ` +
        `Set your channel role in Settings for accurate recommendations.`
      : `Your channel is ${localPctDisplay}% on your side. If you are a merchant, your room ` +
        `to send is getting low. If you are a farmer, you have room to receive. ` +
        `Set your channel role in Settings for accurate recommendations.`,
    urgency: c.urgency,
    loopAvailable: false,
    generatedAt: now,
  };
}

// ─── Role: MERCHANT ─────────────────────────────────────────────────────────

function recommendMerchant(
  c: ChannelClassification,
  loop: LoopAvailability,
  cfg: RecommendationConfig,
): LiquidityRecommendation {
  const now = Date.now();
  const localPct = c.memberLocalPct;

  // ── Structurally undersized? ──────────────────────────────────────────
  // Capacity below recommended minimum OR repeated depletion (3+ exhaustion runs)
  const undersized = c.capacitySat < cfg.merchantRecommendedCapacitySat;
  const repeatedDepletion = c.consecutiveNonHealthyRuns >= 3 &&
    (c.state === "receive_heavy" || c.state === "receive_exhausted");

  if (undersized || repeatedDepletion) {
    const reason = undersized
      ? `Your channel (${fmt(c.capacitySat)} sats) is below the recommended merchant ` +
        `minimum of ${fmt(cfg.merchantRecommendedCapacitySat)} sats. Open a larger channel ` +
        `to avoid running low on sending balance so often.`
      : `Your sending balance has stayed low for ${describeSustainedRuns(c.consecutiveNonHealthyRuns)}. ` +
        `This usually means the channel is too small for your payment volume. ` +
        `Consider opening a larger channel instead of topping up repeatedly.`;
    return {
      action: "channel_upgrade",
      suggestedAmountSats: cfg.merchantRecommendedCapacitySat,
      projectedMemberLocalPct: null,
      reason,
      urgency: c.urgency === "none" ? "low" : c.urgency,
      loopAvailable: false,
      generatedAt: now,
    };
  }

  // ── Healthy — outbound capacity sufficient ────────────────────────────
  // For merchants, send_heavy/send_saturated (high local) is GOOD — they have outbound.
  // healthy + send_heavy + send_saturated are all fine for merchants.
  if (localPct >= 0.30) {
    return {
      action: "none",
      suggestedAmountSats: null,
      projectedMemberLocalPct: null,
      reason: "Your sending balance is healthy — ready to pay.",
      urgency: "none",
      loopAvailable: loop.loopDaemonRunning,
      generatedAt: now,
    };
  }

  // ── Low outbound (local < 30%) → Loop In ──────────────────────────────
  const depleted = localPct < 0.15;
  const stateLabel = depleted
    ? "You're almost out of sending balance"
    : "Your sending balance is running low";

  const targetSat = Math.round(c.capacitySat * cfg.targetMidPct);
  let amount = targetSat - c.memberLocalSat;

  const loopInMinSats = loop.loopInTerms?.minSats ?? LOOP_PROTOCOL_MIN;
  const loopInFeasible = loop.loopInAvailable && c.capacitySat >= loopInMinSats;

  if (loopInFeasible && loop.loopInTerms) {
    amount = Math.max(amount, loop.loopInTerms.minSats);
    amount = Math.min(amount, loop.loopInTerms.maxSats);
    amount = Math.min(amount, cfg.maxLoopSats);

    const projectedLocal = c.memberLocalSat + amount;
    const projectedPct = c.capacitySat > 0 ? projectedLocal / c.capacitySat : 0;

    return {
      action: "loop_in",
      suggestedAmountSats: amount,
      projectedMemberLocalPct: Math.round(projectedPct * 10000) / 100,
      // "Top Up" = the canonical merchant name for Loop In (Knot 2).
      reason:
        `${stateLabel}. Top up to keep paying — it moves funds from your ` +
        `Bitcoin balance into your channel.`,
      urgency: depleted ? "high" : c.urgency,
      loopAvailable: true,
      generatedAt: now,
    };
  }

  // Loop In not available — manual recovery
  const noLoopReason = !loop.loopDaemonRunning
    ? "Loop is not installed on this node."
    : "Top Up is currently unavailable.";

  return {
    action: "manual_recovery",
    suggestedAmountSats: null,
    projectedMemberLocalPct: null,
    reason:
      `${stateLabel}. To restore your ability to pay, install Loop and use Top Up, ` +
      `or open a new channel. ${noLoopReason}`,
    urgency: depleted ? "high" : c.urgency,
    loopAvailable: false,
    generatedAt: now,
  };
}

// ─── Role: FARMER ───────────────────────────────────────────────────────────

function recommendFarmer(
  c: ChannelClassification,
  loop: LoopAvailability,
  cfg: RecommendationConfig,
): LiquidityRecommendation {
  const now = Date.now();
  const localPct = c.memberLocalPct;

  // ── Structurally undersized? ──────────────────────────────────────────
  const undersized = c.capacitySat < cfg.farmerRecommendedCapacitySat;
  const repeatedFilling = c.consecutiveNonHealthyRuns >= 3 &&
    (c.state === "send_heavy" || c.state === "send_saturated");

  if (undersized || repeatedFilling) {
    const reason = undersized
      ? `Your channel (${fmt(c.capacitySat)} sats) is below the recommended farmer ` +
        `minimum of ${fmt(cfg.farmerRecommendedCapacitySat)} sats. Open a larger channel ` +
        `to receive larger or more frequent earnings without filling up.`
      : `Your channel has been full or nearly full for ${describeSustainedRuns(c.consecutiveNonHealthyRuns)}. ` +
        `This usually means it's too small for your earnings flow. ` +
        `Consider opening a larger channel instead of withdrawing frequently.`;
    return {
      action: "channel_upgrade",
      suggestedAmountSats: cfg.farmerRecommendedCapacitySat,
      projectedMemberLocalPct: null,
      reason,
      urgency: c.urgency === "none" ? "low" : c.urgency,
      loopAvailable: false,
      generatedAt: now,
    };
  }

  // ── Healthy — receiving capacity sufficient ───────────────────────────
  // For farmers, receive_heavy/receive_exhausted (low local) is GOOD — room to earn.
  // healthy + receive_heavy + receive_exhausted are all fine for farmers.
  if (localPct <= 0.70) {
    return {
      action: "none",
      suggestedAmountSats: null,
      projectedMemberLocalPct: null,
      reason: "You have room to receive — ready to earn.",
      urgency: "none",
      loopAvailable: loop.loopDaemonRunning,
      generatedAt: now,
    };
  }

  // ── Getting full / full (local > 70%) → Loop Out ──────────────────────
  const full = localPct >= 0.85;
  const stateLabel = full
    ? "Your channel is nearly full — almost no room left to receive"
    : "Your channel is filling up";

  const targetSat = Math.round(c.capacitySat * cfg.targetMidPct);
  let amount = c.memberLocalSat - targetSat;

  const loopOutMinSats = loop.loopOutTerms?.minSats ?? LOOP_PROTOCOL_MIN;
  const loopOutFeasible = loop.loopOutAvailable && c.capacitySat >= loopOutMinSats;

  if (loopOutFeasible && loop.loopOutTerms) {
    amount = Math.max(amount, loop.loopOutTerms.minSats);
    amount = Math.min(amount, loop.loopOutTerms.maxSats);
    amount = Math.min(amount, cfg.maxLoopSats);
    amount = Math.min(amount, c.memberLocalSat - cfg.floorSats);

    if (amount <= 0 || amount > c.memberLocalSat - cfg.floorSats) {
      return {
        action: "manual_recovery",
        suggestedAmountSats: null,
        projectedMemberLocalPct: null,
        reason:
          `${stateLabel}, but your balance is too small to withdraw. ` +
          "Send a payment to make room to receive.",
        urgency: full ? "high" : c.urgency,
        loopAvailable: true,
        generatedAt: now,
      };
    }

    const projectedLocal = c.memberLocalSat - amount;
    const projectedPct = c.capacitySat > 0 ? projectedLocal / c.capacitySat : 0;

    return {
      action: "loop_out",
      suggestedAmountSats: amount,
      projectedMemberLocalPct: Math.round(projectedPct * 10000) / 100,
      // "Withdraw" = the canonical farmer name for Loop Out (Knot 2).
      reason:
        `${stateLabel}. Withdraw to move earnings to your Bitcoin balance ` +
        `and make room to receive more.`,
      urgency: full ? "high" : c.urgency,
      loopAvailable: true,
      generatedAt: now,
    };
  }

  // Loop Out not available — manual recovery
  const noLoopReason = !loop.loopDaemonRunning
    ? "Loop is not installed on this node."
    : "Withdrawals are currently unavailable.";

  return {
    action: "manual_recovery",
    suggestedAmountSats: null,
    projectedMemberLocalPct: null,
    reason:
      `${stateLabel}. Withdraw earnings from the Withdraw page, or ` +
      `send a payment to make room. ${noLoopReason}`,
    urgency: full ? "high" : c.urgency,
    loopAvailable: false,
    generatedAt: now,
  };
}

// ─── Main dispatch ──────────────────────────────────────────────────────────

export function computeRecommendation(
  classification: ChannelClassification,
  loopAvailability: LoopAvailability,
): LiquidityRecommendation {
  const cfg = getConfig();

  switch (classification.channelRole) {
    case "merchant":
      return recommendMerchant(classification, loopAvailability, cfg);
    case "farmer":
      return recommendFarmer(classification, loopAvailability, cfg);
    default:
      return recommendUnknown(classification, loopAvailability, cfg);
  }
}
