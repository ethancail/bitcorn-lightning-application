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
  // Uses the single largest active Treasury channel only (not summed).
  // In the Bitcorn hub-and-spoke model, members are leaf nodes with one
  // canonical Treasury channel. If multiple exist, the largest is used
  // as the most likely routing path.
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
  // Only checked on the treasury node. Member nodes don't have direct channels
  // to egress peers — the treasury handles egress routing. Members only need
  // sufficient balance on their treasury channel (checked above).
  const nodeInfo = db.prepare("SELECT node_role FROM lnd_node_info WHERE id = 1").get() as
    { node_role: string } | undefined;
  const isTreasuryNode = nodeInfo?.node_role === "treasury";

  const egressPeers = isTreasuryNode
    ? db.prepare(`SELECT pubkey FROM swap_egress_peers WHERE enabled = 1`).all() as { pubkey: string }[]
    : [];

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

// Treasury-initiated Loop In — removed from active architecture (v1.7.1).
// Treasury maintains inbound via Loop OUT on external channels.
// This function is retained for reference; member-side Loop In uses
// checkMemberLoopInPolicy() below.
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

// ─── Member Loop In (refill) ────────────────────────────────────────────
// Path: Loop server → [public network] → treasury (external channel) → merchant
// Preflight probes this route before allowing the on-chain HTLC commit.

export async function checkMemberLoopInPolicy(params: {
  nodePubkey: string;
  amountSat: number;
  quotedFeeSat?: number; // omit for pre-quote (phase 1); provide for post-quote (phase 2)
}): Promise<PolicyResult> {
  const { amountSat, quotedFeeSat, nodePubkey } = params;

  // ── 1. Amount bounds ──────────────────────────────────────────────────
  if (amountSat < ENV.memberMinRefillSat) {
    return { ok: false, reason: `Minimum refill: ${ENV.memberMinRefillSat.toLocaleString()} sats`, code: "below_minimum" };
  }
  if (amountSat > ENV.memberMaxRefillSat) {
    return { ok: false, reason: `Maximum refill: ${ENV.memberMaxRefillSat.toLocaleString()} sats`, code: "above_maximum" };
  }

  // ── 2. Provider terms ─────────────────────────────────────────────────
  try {
    const terms = await getLoopInTerms();
    if (amountSat < terms.min_swap_amount) {
      return { ok: false, reason: `Below Loop In minimum: ${terms.min_swap_amount.toLocaleString()} sats`, code: "below_loop_minimum" };
    }
    if (amountSat > terms.max_swap_amount) {
      return { ok: false, reason: `Above Loop In maximum: ${terms.max_swap_amount.toLocaleString()} sats`, code: "above_loop_maximum" };
    }
  } catch {
    return { ok: false, reason: "Loop service unavailable", code: "loop_unavailable" };
  }

  // ── 3. On-chain balance ───────────────────────────────────────────────
  try {
    const { chain_balance } = await getLndChainBalance();
    const reserve = ENV.memberOnchainReserveSat;
    const needed = amountSat + reserve;
    if (chain_balance < needed) {
      return {
        ok: false,
        reason: `Insufficient on-chain balance (${chain_balance.toLocaleString()} available, need ${needed.toLocaleString()} including ${reserve.toLocaleString()} reserve)`,
        code: "insufficient_onchain",
      };
    }
  } catch {
    return { ok: false, reason: "Unable to check on-chain balance", code: "balance_check_failed" };
  }

  // ── 4. Route probe (preflight) ────────────────────────────────────────
  const { probeRouteToLoopServer } = await import("../lightning/lnd");
  const probe = await probeRouteToLoopServer(nodePubkey, amountSat);
  if (!probe.routable) {
    return {
      ok: false,
      reason: "No route available from Loop server to your node. Treasury may lack inbound capacity on external channels. Try a smaller amount or check back shortly.",
      code: "route_unavailable",
    };
  }

  // ── 5. Daily refill cap ───────────────────────────────────────────────
  const dayAgo = Date.now() - 86_400_000;
  const dailyRow = db.prepare(`
    SELECT COALESCE(SUM(amount_sat), 0) AS total
    FROM swap_requests
    WHERE node_pubkey = ? AND role = 'member' AND swap_type = 'loop_in'
      AND status NOT IN ('failed', 'expired', 'blocked_policy')
      AND created_at > ?
  `).get(nodePubkey, dayAgo) as { total: number };

  if (dailyRow.total + amountSat > ENV.memberMaxDailyRefillSat) {
    return {
      ok: false,
      reason: `Daily refill limit exceeded (${ENV.memberMaxDailyRefillSat.toLocaleString()} sats/day)`,
      code: "daily_limit_exceeded",
    };
  }

  // ── 6. Fee cap (phase 2 only — requires quoted fee) ───────────────────
  if (quotedFeeSat !== undefined) {
    const feeLimit = Math.ceil(amountSat * ENV.loopMaxSwapFeePct / 100);
    if (quotedFeeSat > feeLimit) {
      return { ok: false, reason: `Quoted fee (${quotedFeeSat.toLocaleString()}) exceeds cap (${feeLimit.toLocaleString()})`, code: "fee_exceeds_cap" };
    }
  }

  console.log(
    `[swap-policy] member loop-in approved: ${amountSat} sats, ` +
    `daily_total=${dailyRow.total}, route_via=${probe.serverPubkey?.slice(0, 12)}`
  );

  return { ok: true };
}
