// The effective member swap limits, read rather than hard-coded (drive-mode
// spec P1 item 6, §3.3; D1.8).
//
// Per direction: the stricter of Bitcorn's env limits and loopd's live terms —
// the minimum is the larger of the two minimums, the maximum the smaller of the
// two maximums — exactly the bounds checkMemberLoopOutPolicy and
// checkMemberLoopInPolicy enforce (swapPolicy.ts §1–2), so a UI that offers
// these figures offers nothing the policy refuses for bounds. With loopd
// unreachable, the env limits alone, and loop_available: false.
//
// The daily remaining amount counts the member's swaps of the last 24 hours in
// the same statuses the policy counts.

import { db } from "../db";
import { ENV } from "../config/env";
import { getLoopInTerms, getLoopOutTerms } from "../lightning/loop";
import { getHubChannel } from "../lightning/hubChannel";
import { capacityOf } from "../lightning/capacity";
import { getLndChainBalance, getLndChainFeeRate } from "../lightning/lnd";

export { effectiveLimits, envLimits, type SwapDirection, type LoopTermsLike } from "./effectiveLimits";
import { effectiveLimits, envLimits, type SwapDirection, type LoopTermsLike } from "./effectiveLimits";

function dailyUsed(nodePubkey: string, direction: SwapDirection): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_sat), 0) AS total
    FROM swap_requests
    WHERE node_pubkey = ? AND role = 'member' AND swap_type = ?
      AND status NOT IN ('failed', 'expired', 'blocked_policy')
      AND created_at > ?
  `).get(nodePubkey, direction, Date.now() - 86_400_000) as { total: number };
  return row.total;
}

// ─── Top Up's on-chain rule (drive-mode P1 item 8; R16(9), R18(10)) ─────────
//
//   needed on-chain = amount + reserve + HTLC fee + anchor reserve
//
// The 50,000 reserve (MEMBER_ONCHAIN_RESERVE_SAT) is ADDED to the fee and the
// anchor reserve, not replaced by them (R18(10)). loopd publishes the HTLC from
// lnd's wallet and pays its fee on top of the amount, and lnd refuses a send
// that would leave less than its anchor reserve (Q1).

/** lnd's per-anchor-channel wallet reserve and its cap
 *  (lnwallet.AnchorChanReservedValue, MaxAnchorChanReservedValue). */
export const ANCHOR_RESERVE_PER_CHANNEL_SAT = 10_000;
export const ANCHOR_RESERVE_MAX_SAT = 100_000;

/** The HTLC publish transaction's assumed vsize, for the fee estimate at
 *  check time: two P2WPKH inputs (2 × 68), the P2TR HTLC output (43) and a
 *  P2WPKH change output (31), plus 10.5 overhead ≈ 221 vB. Conservative past
 *  the one-input case (subscription/payFromNode.ts uses 150 for that). Only
 *  the pre-quote check and the stated floor use it: after the quote, and at
 *  execute, loopd's quoted HTLC fee replaces it (R18(10)). */
export const TOPUP_HTLC_TX_VBYTES = 221;

/** ln-service commitment types whose channels carry anchor outputs: lnd's
 *  CommitmentType.HasAnchors (anchors, script-enforced lease, simple
 *  taproot). */
const ANCHOR_TYPES = ["anchor", "anchor_with_lease_constraint", "simplified_taproot"];

/** Anchor channels as lnd counts them for its wallet reserve: PUBLIC channels
 *  with anchors — lnd skips private ones (lnwallet/wallet.go
 *  CurrentNumAnchorChans). Pending opens, which lnd also counts, are not in
 *  lnd_channels. */
export function countAnchorChannels(): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM lnd_channels
    WHERE private = 0 AND commitment_type IN (${ANCHOR_TYPES.map(() => "?").join(",")})
  `).get(...ANCHOR_TYPES) as { n: number };
  return row.n;
}

export type LoopInOnchainRule = {
  reserve_sats: number;
  anchor_channels: number;
  anchor_reserve_sats: number;
  /** null when the fee is the stored quote's, not an estimate. */
  fee_rate_sat_per_vbyte: number | null;
  htlc_tx_vbytes: number | null;
  estimated_htlc_fee_sats: number;
};

/**
 * The rule's parts. With minerFeeSat (the stored or fresh quote's HTLC fee),
 * that fee; without, lnd's fee rate at loopd's conf target × the assumed vsize.
 * Throws if lnd cannot give a fee rate.
 */
export async function loopInOnchainRule(minerFeeSat?: number): Promise<LoopInOnchainRule> {
  const anchors = countAnchorChannels();
  const anchorReserve = Math.min(anchors * ANCHOR_RESERVE_PER_CHANNEL_SAT, ANCHOR_RESERVE_MAX_SAT);
  const base = { reserve_sats: ENV.memberOnchainReserveSat, anchor_channels: anchors, anchor_reserve_sats: anchorReserve };
  if (minerFeeSat !== undefined) {
    return { ...base, fee_rate_sat_per_vbyte: null, htlc_tx_vbytes: null, estimated_htlc_fee_sats: minerFeeSat };
  }
  const { tokens_per_vbyte } = await getLndChainFeeRate(ENV.loopConfTarget);
  return {
    ...base,
    fee_rate_sat_per_vbyte: tokens_per_vbyte,
    htlc_tx_vbytes: TOPUP_HTLC_TX_VBYTES,
    estimated_htlc_fee_sats: Math.ceil(tokens_per_vbyte * TOPUP_HTLC_TX_VBYTES),
  };
}

/** Everything but the amount: what must stay in the wallet beside it. */
export function onchainOverhead(rule: LoopInOnchainRule): number {
  return rule.reserve_sats + rule.estimated_htlc_fee_sats + rule.anchor_reserve_sats;
}

export type DirectionLimits = {
  min_sats: number;
  max_sats: number;
  daily_max_sats: number;
  daily_remaining_sats: number;
};

export type AlwaysStays = {
  total_sats: number;
  reserve_sats: number;
  fee_headroom_sats: number;
  swap_buffer_sats: number;
};

export type MemberSwapLimits = {
  loop_available: boolean;
  loop_out: DirectionLimits & {
    /** The most a withdrawal can be right now and pass the pre-quote policy
     *  (drive-mode P1 item 7): the effective maximum, today's remaining daily
     *  amount, and the hub channel's room to send (capacity.ts, headroom-aware
     *  for a funder, R23(i)) less the swap-only buffer (R18(6), R24) — the same
     *  arithmetic as checkMemberLoopOutPolicy with no fee.
     *  Below min_sats, nothing can be withdrawn now. The quote's fee is not in
     *  it: an amount within one fee of it can still be refused by the fee phase
     *  after the quote (the plan's stated residual), before any swap starts. */
    available_now_sats: number;
    /** What always stays in the connection, whatever the limits (drive-mode
     *  P2 item 16; R11(4), Withdraw's "Why not all of it?"): the local balance
     *  less what the policy lets a withdrawal take from the channel (room to
     *  send less the swap buffer, as available_now_sats). Its parts sum to it:
     *  the connection reserve, lnd's fee headroom (a funder's, R23(i)), and the
     *  swap buffer (capped at room to send). Null with no hub channel.
     *  Read-only: the policy is unchanged. */
    always_stays: AlwaysStays | null;
  };
  loop_in: DirectionLimits & {
    /** The rule Top Up follows (drive-mode P1 item 8), or null when lnd could
     *  not give the balance or the fee rate. */
    onchain_rule: LoopInOnchainRule | null;
    /** The wallet balance the minimum top-up needs: min + the rule's overhead. */
    onchain_floor_sats: number | null;
    /** The most a top-up can be right now under the rule, the effective
     *  maximum and today's remaining amount; below min_sats, none can. */
    available_now_sats: number | null;
  };
};

async function loopInNow(limits: DirectionLimits) {
  try {
    const [rule, { chain_balance }] = await Promise.all([loopInOnchainRule(), getLndChainBalance()]);
    const overhead = onchainOverhead(rule);
    return {
      onchain_rule: rule,
      onchain_floor_sats: limits.min_sats + overhead,
      available_now_sats: Math.max(0, Math.min(limits.max_sats, limits.daily_remaining_sats, chain_balance - overhead)),
    };
  } catch {
    return { onchain_rule: null, onchain_floor_sats: null, available_now_sats: null };
  }
}

async function termsOrNull(fetch: () => Promise<LoopTermsLike>): Promise<LoopTermsLike | null> {
  try {
    return await fetch();
  } catch {
    return null;
  }
}

/** The local balance less what a withdrawal may take from the channel, split
 *  into parts that sum to it. room ≤ local − reserve always (capacity.ts), so
 *  the headroom is never negative. */
function alwaysStays(local: number, reserve: number, roomToSend: number, hubSpendable: number): AlwaysStays {
  const total = local - hubSpendable;
  const reserve_sats = Math.min(local, reserve);
  const swap_buffer_sats = Math.min(ENV.swapMemberRoutingBufferSat, roomToSend);
  return { total_sats: total, reserve_sats, fee_headroom_sats: total - reserve_sats - swap_buffer_sats, swap_buffer_sats };
}

export async function getMemberSwapLimits(nodePubkey: string): Promise<MemberSwapLimits> {
  const [outTerms, inTerms] = await Promise.all([termsOrNull(getLoopOutTerms), termsOrNull(getLoopInTerms)]);
  const direction = (d: SwapDirection, terms: LoopTermsLike | null): DirectionLimits => {
    const daily = envLimits(d).daily;
    return {
      ...effectiveLimits(d, terms),
      daily_max_sats: daily,
      daily_remaining_sats: Math.max(0, daily - dailyUsed(nodePubkey, d)),
    };
  };
  const loopOut = direction("loop_out", outTerms);
  const loopIn = direction("loop_in", inTerms);
  const hub = getHubChannel();
  const cap = hub ? capacityOf(hub) : null;
  const hubSpendable = cap ? Math.max(0, cap.room_to_send_sats - ENV.swapMemberRoutingBufferSat) : 0;
  return {
    loop_available: outTerms != null && inTerms != null,
    loop_out: {
      ...loopOut,
      available_now_sats: Math.max(0, Math.min(loopOut.max_sats, loopOut.daily_remaining_sats, hubSpendable)),
      always_stays: hub && cap ? alwaysStays(hub.local_balance_sat, cap.local_reserve_sats, cap.room_to_send_sats, hubSpendable) : null,
    },
    loop_in: { ...loopIn, ...(await loopInNow(loopIn)) },
  };
}
