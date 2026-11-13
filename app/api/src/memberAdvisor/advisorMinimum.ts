// The advisor's "recommended minimum" connection size — the ONE formula's
// (transfers/minimumConnection.ts), not 032's stored 2,000,000 / 1,000,000
// (drive-mode P3; R16(6), R17(3), R19(6), R40(2)).
//
// 032 seeded merchant_recommended_capacity_sat and
// farmer_recommended_capacity_sat into every node's advisor row, and a seeded
// value outranks a code default — so changing defaults would have done
// nothing. The engine stops reading those columns; this computes the size
// live from:
//   the member's strategy (Manual only → Save on fees', R21(1); R19(6): the
//     size for the strategy they are on), and fee-limit rail (Q)
//   the cached BTC/USD rate (F, Q's dollar cap)
//   Loop's effective minimum for the role's direction, from the advisor's
//     own loop terms (S_min)
//   the classified channel's commitment fee and type (H, C)
// null when a term has no value (no rate, no synced commitment fee): then no
// size claim is made, and only the repeated-depletion/filling check can
// recommend a bigger connection.

import { db } from "../db";
import { getBtcUsd } from "../price/btcUsdCache";
import { effectiveLimits, type LoopTermsLike } from "../swaps/effectiveLimits";
import { minimumConnection } from "../transfers/minimumConnection";
import { effectiveTransferSettings } from "../transfers/transferSettings";
import type { ChannelClassification } from "./channelClassifier";
import type { LoopAvailability } from "./loopAvailability";

function termsOf(t: { minSats: number; maxSats: number } | null | undefined): LoopTermsLike | null {
  return t ? { min_swap_amount: t.minSats, max_swap_amount: t.maxSats } : null;
}

export function advisorMinimumSats(
  role: "farmer" | "merchant",
  c: ChannelClassification,
  loop: LoopAvailability,
): number | null {
  const settings = effectiveTransferSettings();
  const ch = db.prepare("SELECT commit_fee_sat, commitment_type FROM lnd_channels WHERE channel_id = ?").get(c.channelId) as
    | { commit_fee_sat: number | null; commitment_type: string | null }
    | undefined;
  const direction = role === "farmer" ? "loop_out" : "loop_in";
  const terms = termsOf(role === "farmer" ? loop.loopOutTerms : loop.loopInTerms);
  return minimumConnection({
    role,
    strategy: settings.strategy,
    usdPerBtc: getBtcUsd().usd,
    loopMinSats: effectiveLimits(direction, terms).min_sats,
    commitFeeSats: ch?.commit_fee_sat ?? null,
    commitmentType: ch?.commitment_type ?? null,
    feeLimitUsdCents: settings.fee_limit_usd_cents,
  })?.sats ?? null;
}
