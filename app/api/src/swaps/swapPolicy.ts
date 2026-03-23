// Policy enforcement for swap operations.
// Checks limits, balances, and fee caps before allowing swap initiation.

import { db } from "../db";
import { ENV } from "../config/env";
import { getLndChainBalance } from "../lightning/lnd";
import { getLoopOutTerms, getLoopInTerms } from "../lightning/loop";

export type PolicyResult = { ok: true } | { ok: false; reason: string; code: string };

// ─── Member Loop Out (withdrawal) ────────────────────────────────────────

export async function checkMemberLoopOutPolicy(params: {
  nodePubkey: string;
  amountSat: number;
  maxFeeSat?: number;
  quotedFeeSat: number;
}): Promise<PolicyResult> {
  const { amountSat, maxFeeSat, quotedFeeSat, nodePubkey } = params;

  // Amount bounds — effective max is the minimum of config, provider terms, and runtime caps
  if (amountSat < ENV.memberMinWithdrawalSat) {
    return { ok: false, reason: `Minimum withdrawal: ${ENV.memberMinWithdrawalSat.toLocaleString()} sats`, code: "below_minimum" };
  }

  let effectiveMax = ENV.memberMaxWithdrawalSat;
  try {
    const terms = await getLoopOutTerms();
    if (amountSat < terms.min_swap_amount) {
      return { ok: false, reason: `Below Loop minimum: ${terms.min_swap_amount.toLocaleString()} sats`, code: "below_loop_minimum" };
    }
    effectiveMax = Math.min(effectiveMax, terms.max_swap_amount);
  } catch {
    return { ok: false, reason: "Loop service unavailable", code: "loop_unavailable" };
  }

  if (amountSat > effectiveMax) {
    return { ok: false, reason: `Maximum withdrawal: ${effectiveMax.toLocaleString()} sats`, code: "above_maximum" };
  }

  // Fee cap
  const feeLimit = maxFeeSat ?? Math.ceil(amountSat * ENV.loopMaxSwapFeePct / 100);
  if (quotedFeeSat > feeLimit) {
    return { ok: false, reason: `Quoted fee (${quotedFeeSat}) exceeds cap (${feeLimit})`, code: "fee_exceeds_cap" };
  }

  // Daily withdrawal limit
  const dayAgo = Date.now() - 86_400_000;
  const row = db.prepare(`
    SELECT COALESCE(SUM(amount_sat), 0) AS total
    FROM swap_requests
    WHERE node_pubkey = ? AND role = 'member' AND swap_type = 'loop_out'
      AND status NOT IN ('failed', 'expired', 'blocked_policy')
      AND created_at > ?
  `).get(nodePubkey, dayAgo) as { total: number };

  if (row.total + amountSat > ENV.memberMaxDailyWithdrawalSat) {
    return {
      ok: false,
      reason: `Daily withdrawal limit exceeded (${ENV.memberMaxDailyWithdrawalSat.toLocaleString()} sats/day)`,
      code: "daily_limit_exceeded",
    };
  }

  // Spendable Lightning balance — sum of local balance in active channels.
  // This is more conservative than LND's aggregate; it reflects what can actually route.
  const balRow = db.prepare(`
    SELECT COALESCE(SUM(local_balance_sat), 0) AS spendable
    FROM lnd_channels WHERE active = 1
  `).get() as { spendable: number };

  // Need amount + estimated fee to be covered by spendable balance
  const totalNeeded = amountSat + quotedFeeSat;
  if (balRow.spendable < totalNeeded) {
    return {
      ok: false,
      reason: `Insufficient Lightning balance (${balRow.spendable.toLocaleString()} spendable, need ${totalNeeded.toLocaleString()})`,
      code: "insufficient_balance",
    };
  }

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
