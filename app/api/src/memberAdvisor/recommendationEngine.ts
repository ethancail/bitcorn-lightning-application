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
    reason: highLocal
      ? `Your channel is ${localPctDisplay}% on your side. If you are a merchant, this means you have ` +
        `outbound capacity to send. If you are a farmer, this means your channel is filling up. ` +
        `Set your channel role in Settings for accurate recommendations.`
      : `Your channel is ${localPctDisplay}% on your side. If you are a merchant, your outbound ` +
        `capacity is getting low. If you are a farmer, you have room to receive. ` +
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
        `to avoid frequent outbound depletion.`
      : `Your channel has depleted repeatedly (${c.consecutiveNonHealthyRuns} consecutive runs). ` +
        `This suggests the channel is too small for your payment needs. ` +
        `Open a larger channel instead of repeatedly topping up.`;
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
      reason: "Outbound capacity is healthy — ready to send payments.",
      urgency: "none",
      loopAvailable: loop.loopDaemonRunning,
      generatedAt: now,
    };
  }

  // ── Low outbound (local < 30%) → Loop In ──────────────────────────────
  const depleted = localPct < 0.15;
  const stateLabel = depleted
    ? "Outbound capacity nearly exhausted"
    : "Your channel is running low on outbound capacity";

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
      reason:
        `${stateLabel}. Loop In restores your ability to keep sending payments ` +
        `by adding Lightning liquidity to your node.`,
      urgency: depleted ? "high" : c.urgency,
      loopAvailable: true,
      generatedAt: now,
    };
  }

  // Loop In not available — manual recovery
  const noLoopReason = !loop.loopDaemonRunning
    ? "Loop is not installed on this node."
    : "Loop In is not available.";

  return {
    action: "manual_recovery",
    suggestedAmountSats: null,
    projectedMemberLocalPct: null,
    reason:
      `${stateLabel}. To restore outbound capacity, install Loop and use Loop In, ` +
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
        `to receive larger or more frequent earnings with less liquidity pressure.`
      : `Your channel has filled up repeatedly (${c.consecutiveNonHealthyRuns} consecutive runs). ` +
        `This suggests the channel is too small for your earnings flow. ` +
        `Open a larger channel instead of frequently withdrawing.`;
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
      reason: "Receiving capacity is healthy — ready to earn.",
      urgency: "none",
      loopAvailable: loop.loopDaemonRunning,
      generatedAt: now,
    };
  }

  // ── Getting full / full (local > 70%) → Loop Out ──────────────────────
  const full = localPct >= 0.85;
  const stateLabel = full
    ? "Receiving capacity is critically low"
    : "Receiving capacity is getting low";

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
          `${stateLabel}, but available balance is too small for a Loop Out. ` +
          "Send a payment to free up receiving capacity.",
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
      reason:
        `${stateLabel}. Loop Out withdraws Lightning balance to your Bitcoin wallet ` +
        `and restores your ability to receive earnings.`,
      urgency: full ? "high" : c.urgency,
      loopAvailable: true,
      generatedAt: now,
    };
  }

  // Loop Out not available — manual recovery
  const noLoopReason = !loop.loopDaemonRunning
    ? "Loop is not installed on this node."
    : "Loop Out is not available.";

  return {
    action: "manual_recovery",
    suggestedAmountSats: null,
    projectedMemberLocalPct: null,
    reason:
      `${stateLabel}. Withdraw earnings via the Withdraw Bitcoin page or ` +
      `send a payment to free up capacity. ${noLoopReason}`,
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
