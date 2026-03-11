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

export class LoopOutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoopOutError";
  }
}

// ─── Single swap execution ───────────────────────────────────────────────────

/**
 * Execute a Loop Out swap through a specific channel.
 *
 * 1. Validate channel exists and is active
 * 2. Check swap amount is within Loop terms
 * 3. Check amount ≤ 50% of local balance
 * 4. Get quote and validate fees
 * 5. Check daily loss cap
 * 6. Generate on-chain address
 * 7. Initiate swap
 */
export async function executeLoopOut(params: {
  channel_id: string;
  amount_sats: number;
  max_swap_fee_sats?: number;
  max_miner_fee_sats?: number;
  conf_target?: number;
}): Promise<LoopOutResult> {
  const { channel_id, amount_sats } = params;

  if (!Number.isFinite(amount_sats) || amount_sats <= 0) {
    throw new LoopOutError("amount_sats must be a positive number");
  }

  // 1. Find channel
  const { channels } = await getLndChannels();
  const channel = channels.find((c: any) => c.id === channel_id);
  if (!channel) throw new LoopOutError(`Channel not found: ${channel_id}`);
  if (!channel.is_active)
    throw new LoopOutError(`Channel is not active: ${channel_id}`);

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
  const maxSafe = Math.floor(channel.capacity * 0.5);
  if (amount_sats > maxSafe) {
    throw new LoopOutError(
      `Amount ${amount_sats} exceeds 50% of channel capacity (${channel.capacity}). Max: ${maxSafe}`
    );
  }

  // 4. Get quote and validate fees
  const confTarget = params.conf_target ?? ENV.loopConfTarget;
  const quote = await getLoopOutQuote(amount_sats, confTarget);

  const maxSwapFee =
    params.max_swap_fee_sats ??
    Math.ceil(amount_sats * (ENV.loopMaxSwapFeePct / 100));
  const maxMinerFee = params.max_miner_fee_sats ?? ENV.loopMaxMinerFeeSats;

  if (quote.swap_fee_sat > maxSwapFee) {
    throw new LoopOutError(
      `Swap fee ${quote.swap_fee_sat} exceeds max ${maxSwapFee} sats (${ENV.loopMaxSwapFeePct}% of ${amount_sats})`
    );
  }
  if (quote.miner_fee > maxMinerFee) {
    throw new LoopOutError(
      `Miner fee ${quote.miner_fee} exceeds max ${maxMinerFee} sats`
    );
  }

  // 5. Daily loss cap
  assertDailyLossCapNotExceeded(quote.total_cost_sats);

  // 6. Generate fresh on-chain address
  const { address } = await createLndChainAddress();

  // 7. Create execution record
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
      max_swap_fee: maxSwapFee,
      max_miner_fee: maxMinerFee,
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
