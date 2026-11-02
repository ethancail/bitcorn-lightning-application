/**
 * Loop Out rebalance: treasury performs a submarine swap via loopd to move
 * sats off-chain → on-chain, restoring receive capacity on a channel while
 * preserving total balance (minus swap + miner fees).
 *
 * Targets "critical" channels (>85% local on treasury side).
 */

import { getLndChannels, createLndChainAddress } from "./lnd";
import {
  isLoopAvailable,
  getLoopOutTerms,
  getLoopOutQuote,
  type LoopOutQuote,
  executeLoopOutSwap,
  listLoopSwaps,
} from "./loop";
import { getLiquidityHealth } from "../api/treasury-liquidity-health";
import {
  assertDailyLossCapNotExceeded,
  DailyLossCapError,
} from "../utils/loss-cap";
import {
  createRebalanceExecution,
  updateRebalanceExecution,
  getRebalanceExecutions,
} from "../api/treasury-rebalance-executions";
import { insertRebalanceCost } from "../api/treasury-rebalance-costs";
import { ENV } from "../config/env";
import { checkLoopOutRoutes, minerFeeExceedsMargin } from "./loopOutPrechecks";

// ─── Types ───────────────────────────────────────────────────────────────────

export type LoopOutResult = {
  ok: boolean;
  swap_id: string;
  channel_id: string;
  amount_sats: number;
  swap_fee_sats: number;
  miner_fee_sats: number;
  total_cost_sats: number;
  status: "initiated" | "failed";
  on_chain_address: string;
  warning?: string;
  error?: string;
};

/** A pre-initiation refusal's own code (loop-fee-ceilings spec §4: "Each
 *  refusal is a distinct error code"). The same names as the member/admin
 *  path's SwapRefusalCode. */
export type LoopOutRefusalCode = "route_fee_over_cap" | "route_not_found" | "fee_rate_over_quote";

export class LoopOutError extends Error {
  readonly code?: LoopOutRefusalCode;
  constructor(message: string, code?: LoopOutRefusalCode) {
    super(message);
    this.name = "LoopOutError";
    this.code = code;
  }
}

// ─── Single swap execution ───────────────────────────────────────────────────

/**
 * Every check executeLoopOut runs before money moves, steps 1–6 below. Throws
 * LoopOutError (coded for the pre-initiation refusals) or DailyLossCapError;
 * returns the in-call quote whose components become the ceilings.
 *
 * Shared with the treasury quote preview, so its `acceptable` flag means
 * "execute would not refuse at this moment" (loop-fee-ceilings spec §4, B7).
 * Without a channel_id (the preview's channel is optional) steps 1 and 3 are
 * skipped and the probe is not pinned to a channel.
 *
 * 1. Validate channel exists and is active
 * 2. Check swap amount is within Loop terms
 * 3. Check amount ≤ 50% of local balance
 * 4. Get quote and sanity-check its swap fee
 * 5. Check daily loss cap
 * 6. Fee-rate check and route probe (before any money-moving loopd call)
 */
export async function checkLoopOutPreconditions(params: {
  channel_id?: string;
  amount_sats: number;
}): Promise<LoopOutQuote> {
  const { channel_id, amount_sats } = params;

  if (!Number.isFinite(amount_sats) || amount_sats <= 0) {
    throw new LoopOutError("amount_sats must be a positive number");
  }

  // 1. Find channel
  let channel: any = null;
  if (channel_id !== undefined) {
    const { channels } = await getLndChannels();
    channel = channels.find((c: any) => c.id === channel_id);
    if (!channel) throw new LoopOutError(`Channel not found: ${channel_id}`);
    if (!channel.is_active)
      throw new LoopOutError(`Channel is not active: ${channel_id}`);
  }

  // 2. Check Loop terms
  const terms = await getLoopOutTerms();
  if (amount_sats < terms.min_swap_amount) {
    throw new LoopOutError(
      `Amount ${amount_sats} below Loop minimum ${terms.min_swap_amount} sats`
    );
  }
  if (amount_sats > terms.max_swap_amount) {
    throw new LoopOutError(
      `Amount ${amount_sats} above Loop maximum ${terms.max_swap_amount} sats`
    );
  }

  // 3. Safety: never swap more than 50% of channel capacity
  if (channel) {
    const maxSafe = Math.floor(channel.capacity * 0.5);
    if (amount_sats > maxSafe) {
      throw new LoopOutError(
        `Amount ${amount_sats} exceeds 50% of channel capacity (${channel.capacity}). Max: ${maxSafe}`
      );
    }
  }

  // 4. Get quote and sanity-check it. The 15% stays only as this policy
  // sanity check on the quote (F5); the ceilings sent are the quote itself.
  const confTarget = ENV.loopConfTarget;
  const quote = await getLoopOutQuote(amount_sats, confTarget);

  const sanityMaxSwapFee = Math.ceil(amount_sats * (ENV.loopMaxSwapFeePct / 100));
  if (quote.swap_fee_sat > sanityMaxSwapFee) {
    throw new LoopOutError(
      `Swap fee ${quote.swap_fee_sat} exceeds max ${sanityMaxSwapFee} sats (${ENV.loopMaxSwapFeePct}% of ${amount_sats})`
    );
  }

  // 5. Daily loss cap
  assertDailyLossCapNotExceeded(quote.total_cost_sats);

  // 6a. Fee-rate check: a fresh quote's miner fee against this call's quote
  // plus the margin. ⚠ CLOSE TO VACUOUS ON PATH C, kept on purpose (B14): the
  // quote it is checked against was taken seconds ago in this same call, so
  // it can only catch a fee spike inside that window. On path C the route
  // probe below is the real protection.
  const fresh = await getLoopOutQuote(amount_sats, confTarget);
  if (minerFeeExceedsMargin(fresh.miner_fee, quote.miner_fee)) {
    throw new LoopOutError(
      `Miner fee rose from ${quote.miner_fee} to ${fresh.miner_fee} sats, above the ${ENV.loopMinerFeeMarginPct}% margin`,
      "fee_rate_over_quote"
    );
  }

  // 6b. Route probe, over this channel: the quote's swap_payment_dest, then
  // the configured Loop servers; refuse over the cap or if neither routes.
  const route = await checkLoopOutRoutes({
    swapPaymentDest: quote.swap_payment_dest,
    amountSat: amount_sats,
    prepaySat: quote.prepay_amt_sat,
    outgoingChannel: channel_id,
  });
  if (!route.ok) {
    if (route.reason === "no_route") {
      throw new LoopOutError(
        `No route to the Loop server for ${amount_sats} sats${channel_id ? ` over ${channel_id}` : ""} (${route.checked.length} checked)`,
        "route_not_found"
      );
    }
    throw new LoopOutError(
      `Probed routing fee over the cap: swap ${route.swapRouteFeeSat}/${route.swapCapSat}, prepay ${route.prepayRouteFeeSat}/${route.prepayCapSat} sats (${route.branch} ${route.target})`,
      "route_fee_over_cap"
    );
  }
  // Which probe branch ran, for the audit trail (spec §10, post-deploy (4)).
  console.log("[rebalance-loop] Loop Out route probed:", {
    channel_id: channel_id ?? null,
    branch: route.branch,
    target: route.target,
    swap_route_fee_sat: route.swapRouteFeeSat,
    prepay_route_fee_sat: route.prepayRouteFeeSat,
  });

  return quote;
}

/**
 * Execute a Loop Out swap through a specific channel.
 *
 * 1–6. checkLoopOutPreconditions (above)
 * 7. Generate on-chain address
 * 8. Initiate swap, with ceilings from the step-4 quote
 *
 * Takes no ceiling overrides and no conf_target: every ceiling comes from the
 * in-call quote, and the sweep targets ENV.loopConfTarget (loop-fee-ceilings
 * spec §4 C1–C3, F6, ruling 1).
 */
export async function executeLoopOut(params: {
  channel_id: string;
  amount_sats: number;
}): Promise<LoopOutResult> {
  const { channel_id, amount_sats } = params;
  const quote = await checkLoopOutPreconditions({ channel_id, amount_sats });
  const confTarget = ENV.loopConfTarget;

  // 7. Generate fresh on-chain address
  const { address } = await createLndChainAddress();

  // 8. Create execution record
  const execId = createRebalanceExecution({
    type: "loop_out",
    tokens: amount_sats,
    outgoing_channel: channel_id,
    incoming_channel: channel_id, // same channel — submarine swap
    max_fee_sats: quote.total_cost_sats,
  });

  try {
    const swapResult = await executeLoopOutSwap({
      amt: amount_sats,
      dest: address,
      outgoing_chan_set: [channel_id],
      // Every ceiling is this call's quote (F1, F3, F6).
      max_swap_fee: quote.swap_fee_sat,
      max_miner_fee: quote.miner_fee,
      max_prepay_amt: quote.prepay_amt_sat,
      sweep_conf_target: confTarget,
    });

    updateRebalanceExecution(
      execId,
      "submitted",
      swapResult.swap_hash,
      null,
      null
    );

    // Record estimated cost (actual cost updated by monitorLoopSwaps)
    insertRebalanceCost(
      "loop_out",
      amount_sats,
      quote.total_cost_sats,
      channel_id
    );

    return {
      ok: true,
      swap_id: swapResult.id,
      channel_id,
      amount_sats,
      swap_fee_sats: quote.swap_fee_sat,
      miner_fee_sats: quote.miner_fee,
      total_cost_sats: quote.total_cost_sats,
      status: "initiated",
      on_chain_address: address,
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    updateRebalanceExecution(execId, "failed", null, null, msg);
    return {
      ok: false,
      swap_id: "",
      channel_id,
      amount_sats,
      swap_fee_sats: 0,
      miner_fee_sats: 0,
      total_cost_sats: 0,
      status: "failed",
      on_chain_address: address,
      error: msg,
    };
  }
}

// ─── Auto-select and execute ─────────────────────────────────────────────────

export type AutoLoopOutResult = {
  ok: boolean;
  results: LoopOutResult[];
  skipped: Array<{ channel_id: string; reason: string }>;
};

/**
 * Auto-rebalance critical channels via Loop Out.
 * Targets channels with >85% local ratio (critical classification).
 */
export async function autoLoopOutRebalance(): Promise<AutoLoopOutResult> {
  const health = getLiquidityHealth();

  const criticalChannels = health
    .filter((h) => h.is_active && h.health_classification === "critical")
    .sort((a, b) => b.imbalance_ratio - a.imbalance_ratio); // worst first

  if (criticalChannels.length === 0) {
    return { ok: true, results: [], skipped: [] };
  }

  // Pre-check daily loss cap
  assertDailyLossCapNotExceeded(0);

  // Get Loop terms once for bounds checking
  const terms = await getLoopOutTerms();

  // Find in-flight Loop Out executions to avoid double-swapping
  const executions = getRebalanceExecutions(100);
  const inFlightChannels = new Set(
    executions
      .filter(
        (e) =>
          e.type === "loop_out" &&
          (e.status === "requested" || e.status === "submitted")
      )
      .map((e) => e.outgoing_channel)
  );

  const results: LoopOutResult[] = [];
  const skipped: Array<{ channel_id: string; reason: string }> = [];

  for (const ch of criticalChannels) {
    // Skip channels with in-flight swaps
    if (inFlightChannels.has(ch.channel_id)) {
      skipped.push({
        channel_id: ch.channel_id,
        reason: "In-flight Loop Out swap already exists",
      });
      continue;
    }

    // Calculate target: push toward 50% local ratio
    const targetLocal = Math.floor(ch.capacity_sats * 0.5);
    const excess = ch.local_sats - targetLocal;

    // Clamp to Loop terms and minimum
    const amount = Math.min(
      terms.max_swap_amount,
      Math.max(ENV.loopMinRebalanceSats, excess)
    );

    if (amount < terms.min_swap_amount) {
      skipped.push({
        channel_id: ch.channel_id,
        reason: `Amount ${amount} below Loop minimum ${terms.min_swap_amount}`,
      });
      continue;
    }

    if (amount < ENV.loopMinRebalanceSats) {
      skipped.push({
        channel_id: ch.channel_id,
        reason: `Amount ${amount} below configured minimum ${ENV.loopMinRebalanceSats}`,
      });
      continue;
    }

    // Safety: skip if amount exceeds 50% of channel capacity
    const maxSafe = Math.floor(ch.capacity_sats * 0.5);
    if (amount > maxSafe) {
      skipped.push({
        channel_id: ch.channel_id,
        reason: `Amount ${amount} exceeds 50% of capacity ${ch.capacity_sats}`,
      });
      continue;
    }

    try {
      const result = await executeLoopOut({
        channel_id: ch.channel_id,
        amount_sats: amount,
      });
      results.push(result);
    } catch (err: any) {
      if (err instanceof DailyLossCapError) {
        skipped.push({
          channel_id: ch.channel_id,
          reason: "Daily loss cap reached — halting auto-rebalance",
        });
        break;
      }
      if (err instanceof LoopOutError) {
        skipped.push({ channel_id: ch.channel_id, reason: err.message });
        continue;
      }
      skipped.push({
        channel_id: ch.channel_id,
        reason: err?.message ?? String(err),
      });
    }
  }

  return { ok: true, results, skipped };
}

// ─── Swap monitoring ─────────────────────────────────────────────────────────

/**
 * Check loopd for swap status updates and sync with our execution records.
 * Call periodically (e.g. from the scheduler) to track in-flight swaps.
 */
export async function monitorLoopSwaps(): Promise<void> {
  const swaps = await listLoopSwaps();
  const executions = getRebalanceExecutions(200);

  // Match submitted executions to Loop swaps by payment_hash
  const inFlight = executions.filter(
    (e) => e.type === "loop_out" && e.status === "submitted" && e.payment_hash
  );

  for (const exec of inFlight) {
    const swap = swaps.find((s) => s.id === exec.payment_hash);
    if (!swap) continue;

    if (swap.state === "SUCCESS") {
      const actualCost =
        swap.cost_server + swap.cost_onchain + swap.cost_offchain;
      updateRebalanceExecution(
        exec.id,
        "succeeded",
        exec.payment_hash,
        actualCost,
        null
      );
    } else if (swap.state === "FAILED") {
      updateRebalanceExecution(
        exec.id,
        "failed",
        exec.payment_hash,
        null,
        "Loop swap failed"
      );
    }
    // Other states (INITIATED, PREIMAGE_REVEALED, HTLC_PUBLISHED) — still in progress
  }
}
