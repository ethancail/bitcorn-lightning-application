/**
 * Member liquidity advisor API route handlers.
 * These run on the member node only — reading local LND channel state.
 */

import {
  classifyTreasuryChannel,
  persistClassification,
  getClassificationHistory,
  type ChannelClassification,
} from "./channelClassifier";
import { checkLoopAvailability, type LoopAvailability } from "./loopAvailability";
import { computeRecommendation, type LiquidityRecommendation } from "./recommendationEngine";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LiquidityStatusResponse {
  classification: ChannelClassification | null;
  recommendation: LiquidityRecommendation | null;
  loopAvailability: LoopAvailability;
}

export interface LiquidityHistoryResponse {
  history: ChannelClassification[];
}

// ─── Route handlers ──────────────────────────────────────────────────────────

/** GET /api/liquidity/status — current classification + recommendation. */
export async function getLiquidityStatus(): Promise<LiquidityStatusResponse> {
  const classification = classifyTreasuryChannel();
  const loopAvailability = await checkLoopAvailability();

  if (!classification) {
    return {
      classification: null,
      recommendation: null,
      loopAvailability,
    };
  }

  // Persist this classification run
  persistClassification(classification);

  const recommendation = computeRecommendation(classification, loopAvailability);

  return {
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
