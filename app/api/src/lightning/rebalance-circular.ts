/**
 * Circular rebalance: treasury pays itself via a forced path (outgoing_channel → … → incoming_channel)
 * to shift local/remote balances. Treasury-only; validates channels and liquidity before executing.
 */

import {
  getLndChannels,
  getLndIdentity,
  createLndInvoice,
  getLndRouteToDestination,
  payLndViaRoutes,
} from "./lnd";
import { createRebalanceExecution, updateRebalanceExecution } from "../api/treasury-rebalance-executions";
import { insertRebalanceCost } from "../api/treasury-rebalance-costs";

const RESERVE_SATS = 1000;

/** Compact numeric channel id (lncli-style) to ln-service format (blockxindexxout). */
function compactChannelIdToLndFormat(chanId: string): string | null {
  const trimmed = String(chanId).trim();
  if (/^\d+$/.test(trimmed)) {
    try {
      const n = BigInt(trimmed);
      const out = Number(n & 0xffffn);
      const tx = Number((n >> 16n) & 0xffffffn);
      const block = Number((n >> 40n) & 0xffffffn);
      return `${block}x${tx}x${out}`;
    } catch {
      return null;
    }
  }
  return trimmed || null;
}

export type CircularRebalanceParams = {
  tokens: number;
  outgoing_channel: string;
  incoming_channel: string;
  max_fee_sats: number;
};

export type CircularRebalanceResult = {
  tokens: number;
  fee_paid_sats: number;
  outgoing_channel: string;
  incoming_channel: string;
  payment_hash: string;
};

export class CircularRebalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircularRebalanceError";
  }
}

/**
 * Validates request and channel state, then executes circular rebalance.
 * On success: creates execution record, creates invoice, gets route to self, pays via route,
 * updates execution and inserts rebalance cost. On failure: updates execution with error.
 */
export async function executeCircularRebalance(
  params: CircularRebalanceParams
): Promise<{ ok: true; rebalance: CircularRebalanceResult }> {
  const { tokens, outgoing_channel, incoming_channel, max_fee_sats } = params;

  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw new CircularRebalanceError("tokens must be a positive number");
  }
  if (!Number.isFinite(max_fee_sats) || max_fee_sats < 0) {
    throw new CircularRebalanceError("max_fee_sats must be a non-negative number");
  }
  if (!outgoing_channel || typeof outgoing_channel !== "string") {
    throw new CircularRebalanceError("outgoing_channel is required");
  }
  if (!incoming_channel || typeof incoming_channel !== "string") {
    throw new CircularRebalanceError("incoming_channel is required");
  }
  if (outgoing_channel === incoming_channel) {
    throw new CircularRebalanceError("outgoing_channel and incoming_channel must differ");
  }

  const { channels } = await getLndChannels();
  const outId = compactChannelIdToLndFormat(outgoing_channel) ?? outgoing_channel;
  const inId = compactChannelIdToLndFormat(incoming_channel) ?? incoming_channel;
  const outChan = channels.find((c) => c.id === outId) ?? channels.find((c) => c.id === outgoing_channel);
  const inChan = channels.find((c) => c.id === inId) ?? channels.find((c) => c.id === incoming_channel);

  if (!outChan) {
    throw new CircularRebalanceError(`outgoing_channel not found: ${outgoing_channel}`);
  }
  if (!inChan) {
    throw new CircularRebalanceError(`incoming_channel not found: ${incoming_channel}`);
  }
  if (outChan.id === inChan.id) {
    throw new CircularRebalanceError("outgoing_channel and incoming_channel must differ");
  }
  if (!outChan.is_active) {
    throw new CircularRebalanceError("outgoing_channel is not active");
  }
  if (!inChan.is_active) {
    throw new CircularRebalanceError("incoming_channel is not active");
  }

  const requiredLocal = tokens + max_fee_sats + RESERVE_SATS;
  if (outChan.local_balance < requiredLocal) {
    throw new CircularRebalanceError(
      `outgoing channel has insufficient local balance: ${outChan.local_balance} < ${requiredLocal} (tokens + max_fee + reserve)`
    );
  }

  const selfIdentity = await getLndIdentity();
  const selfPubkey = selfIdentity.public_key;
  if (!selfPubkey) {
    throw new CircularRebalanceError("Could not get own node public key");
  }

  const execId = createRebalanceExecution({
    type: "circular",
    tokens,
    outgoing_channel: outChan.id,
    incoming_channel: inChan.id,
    max_fee_sats,
  });

  try {
    const invoice = await createLndInvoice(tokens);
    const paymentHash = invoice.id;
    const totalMtokens = invoice.mtokens ?? String(tokens * 1000);
    const payment = invoice.payment ?? paymentHash;

    updateRebalanceExecution(execId, "submitted");

    const { route } = await getLndRouteToDestination({
      destination: selfPubkey,
      tokens,
      outgoing_channel: outChan.id,
      incoming_peer: inChan.partner_public_key,
      max_fee: max_fee_sats,
      payment,
      total_mtokens: totalMtokens,
    });

    const payResult = await payLndViaRoutes(paymentHash, [route]);
    const feePaid = payResult.fee ?? 0;

    updateRebalanceExecution(execId, "succeeded", paymentHash, feePaid, null);
    insertRebalanceCost("circular", tokens, feePaid, outChan.id);

    return {
      ok: true,
      rebalance: {
        tokens,
        fee_paid_sats: feePaid,
        outgoing_channel: outChan.id,
        incoming_channel: inChan.id,
        payment_hash: paymentHash,
      },
    };
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    updateRebalanceExecution(execId, "failed", null, null, msg);
    throw err;
  }
}
