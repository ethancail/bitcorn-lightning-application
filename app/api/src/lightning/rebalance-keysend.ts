/**
 * Keysend push rebalance: treasury pushes sats directly to a member node
 * on the existing channel. No invoice, no routing through third parties.
 *
 * Only effective for "critical" channels (>85% local on treasury side).
 * Pushing to outbound_starved channels worsens the imbalance.
 */

import { getLndChannels, keysendPush } from "./lnd";
import { getLiquidityHealth } from "../api/treasury-liquidity-health";
import { assertDailyLossCapNotExceeded, DailyLossCapError } from "../utils/loss-cap";
import { createRebalanceExecution, updateRebalanceExecution } from "../api/treasury-rebalance-executions";
import { insertRebalanceCost } from "../api/treasury-rebalance-costs";
import { db } from "../db";

/** Safety bounds */
const MIN_PUSH_SATS = 10_000;
const MAX_PUSH_SATS = 100_000;
const MAX_LOCAL_RATIO = 0.50; // never push more than 50% of local balance

export type KeysendRebalanceResult = {
  channel_id: string;
  peer_pubkey: string;
  amount_sats: number;
  fee_paid_sats: number;
  payment_hash: string;
  status: "succeeded" | "failed";
  warning?: string;
  error?: string;
};

export class KeysendRebalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeysendRebalanceError";
  }
}

/**
 * Execute a keysend push to a specific channel.
 *
 * @param channel_id - The channel to push sats through
 * @param amount_sats - Amount to push
 * @param max_fee_sats - Maximum fee (default 0 — direct peer, no routing)
 */
export async function executeKeysendRebalance(params: {
  channel_id: string;
  amount_sats: number;
  max_fee_sats?: number;
}): Promise<KeysendRebalanceResult> {
  const { channel_id, amount_sats, max_fee_sats = 0 } = params;

  if (!Number.isFinite(amount_sats) || amount_sats <= 0) {
    throw new KeysendRebalanceError("amount_sats must be a positive number");
  }
  if (amount_sats < MIN_PUSH_SATS) {
    throw new KeysendRebalanceError(`amount_sats must be at least ${MIN_PUSH_SATS} sats`);
  }
  if (amount_sats > MAX_PUSH_SATS) {
    throw new KeysendRebalanceError(`amount_sats must not exceed ${MAX_PUSH_SATS} sats`);
  }

  // Find the channel in LND
  const { channels } = await getLndChannels();
  const channel = channels.find((c) => c.id === channel_id);
  if (!channel) {
    throw new KeysendRebalanceError(`Channel not found: ${channel_id}`);
  }
  if (!channel.is_active) {
    throw new KeysendRebalanceError(`Channel is not active: ${channel_id}`);
  }

  // Safety: never push more than 50% of local balance
  const maxSafe = Math.floor(channel.local_balance * MAX_LOCAL_RATIO);
  if (amount_sats > maxSafe) {
    throw new KeysendRebalanceError(
      `amount_sats (${amount_sats}) exceeds 50% of local balance (${channel.local_balance}). Max safe: ${maxSafe}`
    );
  }

  // Check health classification for warning
  const health = getLiquidityHealth();
  const channelHealth = health.find((h) => h.channel_id === channel_id);
  const warning =
    channelHealth && channelHealth.health_classification !== "critical"
      ? `Channel is ${channelHealth.health_classification}, not critical. Keysend push is most effective on critical channels (>85% local).`
      : undefined;

  // Daily loss cap
  assertDailyLossCapNotExceeded(max_fee_sats);

  // Create execution record
  const execId = createRebalanceExecution({
    type: "keysend",
    tokens: amount_sats,
    outgoing_channel: channel_id,
    incoming_channel: channel_id, // same channel — direct push
    max_fee_sats,
  });

  try {
    updateRebalanceExecution(execId, "submitted");

    const result = await keysendPush({
      destination: channel.partner_public_key,
      tokens: amount_sats,
      max_fee: max_fee_sats,
      outgoing_channel: channel_id,
    });

    const feePaid = result.fee ?? 0;
    updateRebalanceExecution(execId, "succeeded", result.id, feePaid, null);

    if (feePaid > 0) {
      insertRebalanceCost("keysend", amount_sats, feePaid, channel_id);
    }

    // Clear keysend-disabled flag on success (peer may have re-enabled)
    db.prepare(
      `UPDATE member_keysend_status SET keysend_disabled = 0, last_checked_at = ? WHERE peer_pubkey = ?`
    ).run(Date.now(), channel.partner_public_key);

    return {
      channel_id,
      peer_pubkey: channel.partner_public_key,
      amount_sats,
      fee_paid_sats: feePaid,
      payment_hash: result.id,
      status: "succeeded",
      warning,
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    updateRebalanceExecution(execId, "failed", null, null, msg);

    // Detect keysend-disabled specifically
    if (msg.includes("PaymentRejectedByDestination") || msg.includes("rejected by destination")) {
      db.prepare(
        `INSERT INTO member_keysend_status (peer_pubkey, keysend_disabled, last_failure_at, failure_message)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(peer_pubkey) DO UPDATE SET
           keysend_disabled = 1, last_failure_at = excluded.last_failure_at, failure_message = excluded.failure_message`
      ).run(channel.partner_public_key, Date.now(), msg);
    }

    return {
      channel_id,
      peer_pubkey: channel.partner_public_key,
      amount_sats,
      fee_paid_sats: 0,
      payment_hash: "",
      status: "failed",
      error: msg,
      warning,
    };
  }
}

/**
 * Auto-rebalance all critical channels via keysend push.
 * Targets channels with >85% local ratio. Pushes enough to bring each
 * toward 50% local ratio, bounded by MIN/MAX push limits.
 */
export async function autoKeysendRebalance(): Promise<{
  ok: boolean;
  results: KeysendRebalanceResult[];
}> {
  const health = getLiquidityHealth();

  const criticalChannels = health
    .filter((h) => h.is_active && h.health_classification === "critical")
    .sort((a, b) => b.imbalance_ratio - a.imbalance_ratio); // worst first

  if (criticalChannels.length === 0) {
    return { ok: true, results: [] };
  }

  // Check daily loss cap once before processing
  assertDailyLossCapNotExceeded(0);

  const results: KeysendRebalanceResult[] = [];

  for (const ch of criticalChannels) {
    // Skip peers with keysend disabled within last 24 hours
    const keysendStatus = db.prepare(
      `SELECT keysend_disabled, last_failure_at FROM member_keysend_status WHERE peer_pubkey = ?`
    ).get(ch.peer_pubkey) as { keysend_disabled: number; last_failure_at: number } | undefined;

    if (keysendStatus?.keysend_disabled && (Date.now() - keysendStatus.last_failure_at) < 86_400_000) {
      results.push({
        channel_id: ch.channel_id,
        peer_pubkey: ch.peer_pubkey,
        amount_sats: 0,
        fee_paid_sats: 0,
        payment_hash: "",
        status: "failed",
        error: "Skipped — peer has keysend disabled. Will retry in 24h.",
      });
      continue;
    }

    // Calculate amount to bring toward 50% local ratio
    const targetLocal = Math.floor(ch.capacity_sats * 0.5);
    const excess = ch.local_sats - targetLocal;
    const pushAmount = Math.min(MAX_PUSH_SATS, Math.max(MIN_PUSH_SATS, excess));

    // Safety: skip if calculated amount is below minimum
    if (pushAmount < MIN_PUSH_SATS) continue;

    // Safety: skip if push would exceed 50% of local
    const maxSafe = Math.floor(ch.local_sats * MAX_LOCAL_RATIO);
    if (pushAmount > maxSafe) continue;

    try {
      const result = await executeKeysendRebalance({
        channel_id: ch.channel_id,
        amount_sats: pushAmount,
        max_fee_sats: 0,
      });
      results.push(result);
    } catch (err: any) {
      // DailyLossCapError halts the entire auto run
      if (err instanceof DailyLossCapError) {
        break;
      }
      // Other errors: record and continue to next channel
      results.push({
        channel_id: ch.channel_id,
        peer_pubkey: ch.peer_pubkey,
        amount_sats: pushAmount,
        fee_paid_sats: 0,
        payment_hash: "",
        status: "failed",
        error: err?.message ?? String(err),
      });
    }
  }

  return { ok: true, results };
}
