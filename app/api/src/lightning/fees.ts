import { updateRoutingFees, getChannels } from "ln-service";
import { getLndClient } from "./lnd";
// These three call ln-service DIRECTLY off getLndClient()'s handle rather than
// through an lnd.ts wrapper, so they do not inherit the wrappers' deadlines and
// have to bind their own. Fee policy is bounded rather than held: it moves no
// funds, and a fee that failed to apply is self-evident on the next read.
import { withDeadline, LND_FAST_CALL_TIMEOUT_MS } from "./callDeadline";
import { ENV } from "../config/env";
import { ChannelFeeAdjustment } from "../api/treasury-dynamic-fees";

export async function applyTreasuryFeePolicy(
  base_fee_msat: number,
  fee_rate_ppm: number
): Promise<void> {
  const { lnd } = getLndClient();
  const base_fee_mtokens = String(base_fee_msat);

  if (ENV.debug) {
    console.log("[treasury] applying fee policy:", {
      base_fee_msat,
      fee_rate_ppm,
    });
  }

  await withDeadline(
    "applyTreasuryFeePolicy",
    () => updateRoutingFees({
      lnd,
      base_fee_mtokens,
      fee_rate: fee_rate_ppm,
    }),
    LND_FAST_CALL_TIMEOUT_MS,
  );
}

export type DynamicFeeResult = {
  channel_id: string;
  applied: boolean;
  target_fee_rate_ppm?: number;
  error?: string;
};

/**
 * Applies per-channel fee rates to LND based on pre-computed adjustments.
 * Fetches live channels to resolve transaction_id/transaction_vout for targeting.
 */
export async function applyDynamicFees(
  adjustments: ChannelFeeAdjustment[]
): Promise<DynamicFeeResult[]> {
  const { lnd } = getLndClient();
  const { channels } = await withDeadline(
    "applyDynamicFees:getChannels",
    () => getChannels({ lnd }),
    LND_FAST_CALL_TIMEOUT_MS,
  );

  // Map compact channel_id → funding outpoint for per-channel targeting
  const channelMap = new Map(
    channels.map(c => [c.id, { transaction_id: c.transaction_id, transaction_vout: c.transaction_vout }])
  );

  const results: DynamicFeeResult[] = [];

  for (const adj of adjustments) {
    const outpoint = channelMap.get(adj.channel_id);

    if (!outpoint) {
      results.push({ channel_id: adj.channel_id, applied: false, error: "channel_not_found_in_lnd" });
      continue;
    }

    try {
      // ⚠ PER CHANNEL, NOT PER RUN. This is inside the adjustment loop, so the
      // worst case is adjustments.length × the deadline. Bounding the RUN is
      // the same deferred per-operation budget as the sync tick's.
      await withDeadline(
        `applyDynamicFees:${adj.channel_id}`,
        () => updateRoutingFees({
          lnd,
          transaction_id: outpoint.transaction_id,
          transaction_vout: outpoint.transaction_vout,
          fee_rate: adj.target_fee_rate_ppm,
        }),
        LND_FAST_CALL_TIMEOUT_MS,
      );

      if (ENV.debug) {
        console.log(`[fees] set channel ${adj.channel_id} → ${adj.target_fee_rate_ppm} ppm (${adj.health_classification})`);
      }

      results.push({ channel_id: adj.channel_id, applied: true, target_fee_rate_ppm: adj.target_fee_rate_ppm });
    } catch (err: any) {
      results.push({ channel_id: adj.channel_id, applied: false, error: err?.message ?? "unknown_error" });
    }
  }

  return results;
}
