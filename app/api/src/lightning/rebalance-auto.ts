/**
 * Auto channel selection for circular rebalance: pick best outgoing (donor) and
 * incoming (receiver) by liquidity scores, with different peers and viability checks.
 */

import { getLndChannels } from "./lnd";
import {
  snapshotChannelLiquidity,
  assertRebalancePairIsViable,
} from "../utils/rebalance-liquidity";
import { ENV } from "../config/env";

export type AutoRebalanceSelection = {
  outgoing_channel: string;
  incoming_channel: string;
  outgoing_partner: string;
  incoming_partner: string;
  outgoing_score_ppm: number;
  incoming_score_ppm: number;
};

/**
 * Picks a viable (outgoing, incoming) pair for circular rebalance:
 * - Outgoing: highest local_ratio_ppm among active channels with enough local_available.
 * - Incoming: highest remote_ratio_ppm among active channels with enough remote_available.
 * - Enforces different channel ids and different partner_public_key (no same-peer loop).
 * - Runs assertRebalancePairIsViable as final gate.
 */
export async function pickAutoRebalancePair(args: {
  tokens: number;
  maxFeeSats: number;
}): Promise<AutoRebalanceSelection> {
  const { channels } = await getLndChannels();
  const buffer = ENV.rebalanceSafetyBufferSats;

  const active = channels.filter((c) => c.is_active);

  const outgoingCandidates = active
    .map((c) => ({ ch: c, snap: snapshotChannelLiquidity(c) }))
    .filter(
      (x) =>
        x.snap.local_available >= args.tokens + args.maxFeeSats + buffer
    )
    .sort((a, b) => b.snap.local_ratio_ppm - a.snap.local_ratio_ppm);

  const incomingCandidates = active
    .map((c) => ({ ch: c, snap: snapshotChannelLiquidity(c) }))
    .filter((x) => x.snap.remote_available >= args.tokens + buffer)
    .sort((a, b) => b.snap.remote_ratio_ppm - a.snap.remote_ratio_ppm);

  for (const out of outgoingCandidates) {
    for (const inc of incomingCandidates) {
      if (out.ch.id === inc.ch.id) continue;
      if (out.ch.partner_public_key === inc.ch.partner_public_key) continue;

      try {
        assertRebalancePairIsViable({
          outgoing: out.snap,
          incoming: inc.snap,
          tokens: args.tokens,
          maxFeeSats: args.maxFeeSats,
        });
      } catch {
        continue;
      }

      return {
        outgoing_channel: out.ch.id,
        incoming_channel: inc.ch.id,
        outgoing_partner: out.ch.partner_public_key,
        incoming_partner: inc.ch.partner_public_key,
        outgoing_score_ppm: out.snap.local_ratio_ppm,
        incoming_score_ppm: inc.snap.remote_ratio_ppm,
      };
    }
  }

  throw new Error(
    "No viable channel pair found for auto rebalance (check liquidity thresholds / balances)"
  );
}
