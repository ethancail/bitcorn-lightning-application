// Policy enforcement for swap operations.
// Member Loop Out is Treasury-path constrained:
//   1. Member must have sufficient local balance on their Treasury channel
//   2. Treasury must have sufficient outbound on approved external egress peers
// This is NOT an aggregate-channel check — it validates the actual swap path.

import { db } from "../db";
import { ENV } from "../config/env";
import { getLndChainBalance } from "../lightning/lnd";
import { getLoopOutTerms, getLoopInTerms } from "../lightning/loop";

export type PolicyResult = { ok: true } | { ok: false; reason: string; code: string };

// ─── Member Loop Out (withdrawal) ────────────────────────────────────────
// Path: member → treasury channel → treasury node → external egress peer → Loop server
// Both legs must have capacity.

export async function checkMemberLoopOutPolicy(params: {
  nodePubkey: string;
  amountSat: number;
  maxFeeSat?: number;
  quotedFeeSat: number;
}): Promise<PolicyResult> {
  const { amountSat, maxFeeSat, quotedFeeSat, nodePubkey } = params;

  // ── 1. Amount bounds ──────────────────────────────────────────────────
  if (amountSat < ENV.memberMinWithdrawalSat) {
    return { ok: false, reason: `Minimum withdrawal: ${ENV.memberMinWithdrawalSat.toLocaleString()} sats`, code: "below_minimum" };
  }

  // Effective max = min(config, provider terms, member channel capacity, treasury egress capacity)
  let effectiveMax = ENV.memberMaxWithdrawalSat;
  let limitingFactor = "config";

  // Provider terms
  try {
    const terms = await getLoopOutTerms();
    if (amountSat < terms.min_swap_amount) {
      return { ok: false, reason: `Below Loop minimum: ${terms.min_swap_amount.toLocaleString()} sats`, code: "below_loop_minimum" };
    }
    if (terms.max_swap_amount < effectiveMax) {
      effectiveMax = terms.max_swap_amount;
      limitingFactor = "provider_terms";
    }
  } catch {
    return { ok: false, reason: "Loop service unavailable", code: "loop_unavailable" };
  }

  // ── 2. Member Treasury channel capacity ───────────────────────────────
  // On member nodes, the treasury channel is identified by peer_pubkey = TREASURY_PUBKEY.
  // On treasury nodes running this check (e.g., for testing), we look for channels
  // to the requesting member instead.
  const treasuryPubkey = ENV.treasuryPubkey;
  const memberChannelRow = treasuryPubkey
    ? db.prepare(`
        SELECT local_balance_sat, capacity_sat, active
        FROM lnd_channels
        WHERE peer_pubkey = ? AND active = 1
        ORDER BY capacity_sat DESC
        LIMIT 1
      `).get(treasuryPubkey) as { local_balance_sat: number; capacity_sat: number; active: number } | undefined
    : undefined;

  if (!memberChannelRow) {
    return { ok: false, reason: "No active Treasury channel found", code: "no_treasury_channel" };
  }

  const memberBuffer = ENV.swapMemberRoutingBufferSat;
  const memberSpendable = Math.max(0, memberChannelRow.local_balance_sat - memberBuffer);
  const memberNeeded = amountSat + quotedFeeSat;

  if (memberSpendable < memberNeeded) {
    return {
      ok: false,
      reason: `Insufficient Treasury channel balance (${memberChannelRow.local_balance_sat.toLocaleString()} local, ${memberBuffer.toLocaleString()} buffer, need ${memberNeeded.toLocaleString()})`,
      code: "insufficient_treasury_channel",
    };
  }

  // Cap effective max by member's treasury channel spendable
  const memberRuntimeMax = memberSpendable - quotedFeeSat;
  if (memberRuntimeMax < effectiveMax) {
    effectiveMax = Math.max(0, memberRuntimeMax);
    limitingFactor = "member_treasury_channel";
  }

  // ── 3. Treasury external egress capacity ──────────────────────────────
  // Query approved egress peers from swap_egress_peers table, then check
  // treasury's outbound (local balance) on channels to those peers.
  const egressPeers = db.prepare(`
    SELECT pubkey FROM swap_egress_peers WHERE enabled = 1
  `).all() as { pubkey: string }[];

  if (egressPeers.length > 0) {
    const placeholders = egressPeers.map(() => "?").join(",");
    const egressRow = db.prepare(`
      SELECT COALESCE(SUM(local_balance_sat), 0) AS egress_local
      FROM lnd_channels
      WHERE peer_pubkey IN (${placeholders}) AND active = 1
    `).get(...egressPeers.map((p) => p.pubkey)) as { egress_local: number };

    const egressReserve = ENV.swapTreasuryEgressReserveSat;
    const egressAvailable = Math.max(0, egressRow.egress_local - egressReserve);

    if (egressAvailable < amountSat) {
      return {
        ok: false,
        reason: `Insufficient Treasury egress capacity (${egressRow.egress_local.toLocaleString()} on approved peers, ${egressReserve.toLocaleString()} reserve, need ${amountSat.toLocaleString()})`,
        code: "insufficient_egress_capacity",
      };
    }

    // Cap effective max by egress capacity
    if (egressAvailable < effectiveMax) {
      effectiveMax = egressAvailable;
      limitingFactor = "treasury_egress";
    }
  }
  // If no egress peers configured, skip this check (treasury operator hasn't set up egress peers yet)

  // ── 4. Enforce effective max ──────────────────────────────────────────
  if (amountSat > effectiveMax) {
    return {
      ok: false,
      reason: `Maximum withdrawal: ${effectiveMax.toLocaleString()} sats (limited by ${limitingFactor.replace(/_/g, " ")})`,
      code: "above_maximum",
    };
  }

  // ── 5. Fee cap ────────────────────────────────────────────────────────
  const feeLimit = maxFeeSat ?? Math.ceil(amountSat * ENV.loopMaxSwapFeePct / 100);
  if (quotedFeeSat > feeLimit) {
    return { ok: false, reason: `Quoted fee (${quotedFeeSat}) exceeds cap (${feeLimit})`, code: "fee_exceeds_cap" };
  }

  // ── 6. Daily withdrawal limit ─────────────────────────────────────────
  const dayAgo = Date.now() - 86_400_000;
  const dailyRow = db.prepare(`
    SELECT COALESCE(SUM(amount_sat), 0) AS total
    FROM swap_requests
    WHERE node_pubkey = ? AND role = 'member' AND swap_type = 'loop_out'
      AND status NOT IN ('failed', 'expired', 'blocked_policy')
      AND created_at > ?
  `).get(nodePubkey, dayAgo) as { total: number };

  if (dailyRow.total + amountSat > ENV.memberMaxDailyWithdrawalSat) {
    return {
      ok: false,
      reason: `Daily withdrawal limit exceeded (${ENV.memberMaxDailyWithdrawalSat.toLocaleString()} sats/day)`,
      code: "daily_limit_exceeded",
    };
  }

  console.log(
    `[swap-policy] member loop-out approved: ${amountSat} sats, ` +
    `effective_max=${effectiveMax}, limiting_factor=${limitingFactor}, ` +
    `member_channel_local=${memberChannelRow.local_balance_sat}, ` +
    `egress_peers=${egressPeers.length}`
  );

  return { ok: true };
}

// ─── Treasury Loop Out ───────────────────────────────────────────────────

export async function checkTreasuryLoopOutPolicy(params: {
  amountSat: number;
  quotedFeeSat: number;
}): Promise<PolicyResult> {
  const { amountSat, quotedFeeSat } = params;

  try {
    const terms = await getLoopOutTerms();
    if (amountSat < terms.min_swap_amount || amountSat > terms.max_swap_amount) {
      return { ok: false, reason: `Amount outside Loop terms (${terms.min_swap_amount}–${terms.max_swap_amount})`, code: "outside_loop_terms" };
    }
  } catch {
    return { ok: false, reason: "Loop service unavailable", code: "loop_unavailable" };
  }

  const feeLimit = Math.ceil(amountSat * ENV.loopMaxSwapFeePct / 100);
  if (quotedFeeSat > feeLimit) {
    return { ok: false, reason: `Quoted fee exceeds policy cap`, code: "fee_exceeds_cap" };
  }

  return { ok: true };
}

// ─── Treasury Loop In ────────────────────────────────────────────────────

export async function checkTreasuryLoopInPolicy(params: {
  amountSat: number;
  quotedFeeSat: number;
}): Promise<PolicyResult> {
  const { amountSat, quotedFeeSat } = params;

  try {
    const terms = await getLoopInTerms();
    if (amountSat < terms.min_swap_amount || amountSat > terms.max_swap_amount) {
      return { ok: false, reason: `Amount outside Loop In terms (${terms.min_swap_amount}–${terms.max_swap_amount})`, code: "outside_loop_terms" };
    }
  } catch {
    return { ok: false, reason: "Loop service unavailable", code: "loop_unavailable" };
  }

  // Check on-chain balance covers HTLC publish
  try {
    const { chain_balance } = await getLndChainBalance();
    if (chain_balance < amountSat) {
      return { ok: false, reason: `Insufficient on-chain balance (${chain_balance} sats available)`, code: "insufficient_onchain" };
    }
  } catch {
    return { ok: false, reason: "Unable to check on-chain balance", code: "balance_check_failed" };
  }

  const feeLimit = Math.ceil(amountSat * ENV.loopMaxSwapFeePct / 100);
  if (quotedFeeSat > feeLimit) {
    return { ok: false, reason: `Quoted fee exceeds policy cap`, code: "fee_exceeds_cap" };
  }

  return { ok: true };
}
