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
import {
  snapshotChannelLiquidity,
  assertRebalancePairIsViable,
  scoreOutgoing,
  scoreIncoming,
} from "../utils/rebalance-liquidity";
import { ENV } from "../config/env";
import { pickAutoRebalancePair, type AutoRebalanceSelection } from "./rebalance-auto";

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
  outgoing_channel?: string;
  incoming_channel?: string;
  max_fee_sats: number;
};

export type CircularRebalanceResult = {
  tokens: number;
  fee_paid_sats: number;
  outgoing_channel: string;
  incoming_channel: string;
  payment_hash: string;
};

export type CircularRebalanceResponse = {
  ok: true;
  rebalance: CircularRebalanceResult;
  selected?: AutoRebalanceSelection;
};

export class CircularRebalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircularRebalanceError";
  }
}

/**
 * Validates request and channel state, then executes circular rebalance.
 * If outgoing_channel or incoming_channel are omitted, picks a pair via pickAutoRebalancePair().
 * On success: creates execution record, creates invoice, gets route to self, pays via route,
 * updates execution and inserts rebalance cost. On failure: updates execution with error.
 */
export async function executeCircularRebalance(
  params: CircularRebalanceParams
): Promise<CircularRebalanceResponse> {
  const { tokens, outgoing_channel, incoming_channel, max_fee_sats } = params;

  if (!Number.isFinite(tokens) || tokens <= 0) {
    throw new CircularRebalanceError("tokens must be a positive number");
  }
  if (!Number.isFinite(max_fee_sats) || max_fee_sats < 0) {
    throw new CircularRebalanceError("max_fee_sats must be a non-negative number");
  }

  let outgoingId: string;
  let incomingId: string;
  let selected: AutoRebalanceSelection | undefined;

  if (
    outgoing_channel != null &&
    incoming_channel != null &&
    String(outgoing_channel).trim() !== "" &&
    String(incoming_channel).trim() !== ""
  ) {
    outgoingId = String(outgoing_channel).trim();
    incomingId = String(incoming_channel).trim();
    if (outgoingId === incomingId) {
      throw new CircularRebalanceError("outgoing_channel and incoming_channel must differ");
    }
  } else {
    const picked = await pickAutoRebalancePair({ tokens, maxFeeSats: max_fee_sats });
    outgoingId = picked.outgoing_channel;
    incomingId = picked.incoming_channel;
    selected = picked;
  }

  const { channels } = await getLndChannels();
  const outIdResolved =
    compactChannelIdToLndFormat(outgoingId) ?? outgoingId;
  const inIdResolved = compactChannelIdToLndFormat(incomingId) ?? incomingId;
  const outChan =
    channels.find((c) => c.id === outIdResolved) ??
    channels.find((c) => c.id === outgoingId);
  const inChan =
    channels.find((c) => c.id === inIdResolved) ??
    channels.find((c) => c.id === incomingId);

  if (!outChan) {
    throw new CircularRebalanceError(`outgoing_channel not found: ${outgoingId}`);
  }
  if (!inChan) {
    throw new CircularRebalanceError(`incoming_channel not found: ${incomingId}`);
  }
  if (outChan.id === inChan.id) {
    throw new CircularRebalanceError("outgoing_channel and incoming_channel must differ");
  }

  const outSnap = snapshotChannelLiquidity(outChan);
  const inSnap = snapshotChannelLiquidity(inChan);

  try {
    assertRebalancePairIsViable({
      outgoing: outSnap,
      incoming: inSnap,
      tokens,
      maxFeeSats: max_fee_sats,
    });
  } catch (e) {
    throw new CircularRebalanceError(e instanceof Error ? e.message : String(e));
  }

  if (ENV.debug) {
    console.log("[rebalance] outgoing score:", scoreOutgoing(outSnap), outSnap);
    console.log("[rebalance] incoming score:", scoreIncoming(inSnap), inSnap);
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

    const response: CircularRebalanceResponse = {
      ok: true,
      rebalance: {
        tokens,
        fee_paid_sats: feePaid,
        outgoing_channel: outChan.id,
        incoming_channel: inChan.id,
        payment_hash: paymentHash,
      },
    };
    if (selected) response.selected = selected;
    return response;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    updateRebalanceExecution(execId, "failed", null, null, msg);
    throw err;
  }
}
