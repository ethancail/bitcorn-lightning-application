/**
 * Member liquidity advisor API route handlers.
 * These run on the member node only — reading local LND channel state.
 */

import {
  classifyTreasuryChannel,
  getAdvisorConfig,
  getClassificationHistory,
  type ChannelClassification,
  type ChannelRole,
} from "./channelClassifier";
import { checkLoopAvailability, type LoopAvailability } from "./loopAvailability";
import { computeRecommendation, type LiquidityRecommendation } from "./recommendationEngine";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LiquidityStatusResponse {
  /**
   * The member's DECLARED role, as stored (PATCH /api/liquidity/config),
   * whether or not the treasury channel is active (SH9). `classification`
   * is null while that channel is inactive, so a role read only from
   * classification.channelRole vanished then and the shell fell back to the
   * farmer nav. Same value as classification.channelRole when that exists.
   */
  channelRole: ChannelRole;
  classification: ChannelClassification | null;
  recommendation: LiquidityRecommendation | null;
  loopAvailability: LoopAvailability;
}

export interface LiquidityHistoryResponse {
  history: ChannelClassification[];
}

// ─── Route handlers ──────────────────────────────────────────────────────────

/** GET /api/liquidity/status — current classification + recommendation.
 *
 *  READ-ONLY by design (counter-defect fix, 2026-07-09): this handler computes
 *  a fresh classification for display but does NOT persist it. Persisting here
 *  made every poll of this endpoint advance consecutiveNonHealthyRuns — the
 *  member shell polls every 15s, so the "3 consecutive runs" escalation to
 *  channel_upgrade (designed for the 15-MINUTE scheduler cadence, i.e. ~45 min
 *  of sustained depletion — see advisorScheduler.ts header) fired within ~45
 *  seconds, giving depleted members wrong open-a-bigger-channel advice. The
 *  15-min scheduler (advisorScheduler.ts runOnce) is the ONLY persist site.
 */
export async function getLiquidityStatus(): Promise<LiquidityStatusResponse> {
  const classification = classifyTreasuryChannel();
  const loopAvailability = await checkLoopAvailability();
  const channelRole = getAdvisorConfig().channelRole;

  if (!classification) {
    return {
      channelRole,
      classification: null,
      recommendation: null,
      loopAvailability,
    };
  }

  const recommendation = computeRecommendation(classification, loopAvailability);

  return {
    channelRole,
    classification,
    recommendation,
    loopAvailability,
  };
}

/** GET /api/liquidity/history — classification history for trend display. */
export function getLiquidityHistory(channelId: string, limit?: number): LiquidityHistoryResponse {
  const history = getClassificationHistory(channelId, limit ?? 20);
  return { history };
}
