// Loop provider — wraps loop.ts with status normalization and event recording.
// Does NOT replace loop.ts; existing auto-rebalance continues using it directly.

import crypto from "crypto";
import { db } from "../db";
import {
  getLoopOutTerms,
  getLoopOutQuote,
  executeLoopOutSwap,
  getLoopInTerms,
  getLoopInQuote,
  executeLoopInSwap,
  listLoopSwaps,
  isLoopAvailable,
  type SwapState,
  type SwapInfo,
  type LoopOutQuote,
  type LoopInQuote,
} from "../lightning/loop";
import { createLndChainAddress } from "../lightning/lnd";

// ─── Status normalization ────────────────────────────────────────────────

export type AppSwapStatus =
  | "quote_created"
  | "awaiting_confirmation"
  | "initiated"
  | "executing"
  | "confirming"
  | "completed"
  | "failed"
  | "expired"
  | "blocked_policy";

export function normalizeLoopState(loopState: SwapState): AppSwapStatus {
  switch (loopState) {
    case "INITIATED":
      return "initiated";
    case "PREIMAGE_REVEALED":
    case "HTLC_PUBLISHED":
      return "executing";
    case "INVOICE_SETTLED":
      return "confirming";
    case "SUCCESS":
      return "completed";
    case "FAILED":
      return "failed";
    default:
      return "executing"; // conservative default for unknown states
  }
}

// ─── Event recording ─────────────────────────────────────────────────────

export function recordSwapEvent(
  swapRequestId: string,
  eventType: string,
  eventData: Record<string, unknown>,
  swapExecutionId?: string
): void {
  db.prepare(`
    INSERT INTO swap_events (id, swap_request_id, swap_execution_id, event_type, event_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    swapRequestId,
    swapExecutionId ?? null,
    eventType,
    JSON.stringify(eventData),
    Date.now()
  );
}

// ─── Loop Out provider ───────────────────────────────────────────────────

export type LoopOutQuoteResult = {
  amount_sat: number;
  swap_fee_sat: number;
  prepay_sat: number;
  miner_fee_sat: number;
  total_fee_sat: number;
  conf_target: number;
};

export async function quoteLoopOut(amountSat: number, confTarget?: number): Promise<LoopOutQuoteResult> {
  const q = await getLoopOutQuote(amountSat, confTarget);
  return {
    amount_sat: amountSat,
    swap_fee_sat: q.swap_fee_sat,
    prepay_sat: q.prepay_amt_sat,
    miner_fee_sat: q.miner_fee,
    total_fee_sat: q.total_cost_sats,
    conf_target: q.conf_target,
  };
}

export async function initiateLoopOut(params: {
  amountSat: number;
  destinationAddress: string;
  maxSwapFee: number;
  maxMinerFee: number;
  maxPrepay: number;
  confTarget: number;
  channelIds?: string[];
}): Promise<{ swapHash: string; id: string; serverMessage: string }> {
  return executeLoopOutSwap({
    amt: params.amountSat,
    dest: params.destinationAddress,
    outgoing_chan_set: params.channelIds ?? [],
    max_swap_fee: params.maxSwapFee,
    max_miner_fee: params.maxMinerFee,
    max_prepay_amt: params.maxPrepay,
    sweep_conf_target: params.confTarget,
  }).then((r) => ({
    swapHash: r.swap_hash,
    id: r.id,
    serverMessage: r.server_message,
  }));
}

// ─── Loop In provider ────────────────────────────────────────────────────

export type LoopInQuoteResult = {
  amount_sat: number;
  swap_fee_sat: number;
  htlc_publish_fee_sat: number;
  total_fee_sat: number;
  conf_target: number;
};

export async function quoteLoopIn(amountSat: number, confTarget?: number): Promise<LoopInQuoteResult> {
  const q = await getLoopInQuote(amountSat, confTarget);
  return {
    amount_sat: amountSat,
    swap_fee_sat: q.swap_fee_sat,
    htlc_publish_fee_sat: q.htlc_publish_fee_sat,
    total_fee_sat: q.total_cost_sats,
    conf_target: q.conf_target,
  };
}

export async function initiateLoopIn(params: {
  amountSat: number;
  maxSwapFee: number;
  maxMinerFee: number;
  confTarget: number;
  lastHop?: string;
}): Promise<{ swapHash: string; id: string; serverMessage: string; htlcAddress: string }> {
  return executeLoopInSwap({
    amt: params.amountSat,
    max_swap_fee: params.maxSwapFee,
    max_miner_fee: params.maxMinerFee,
    htlc_conf_target: params.confTarget,
    last_hop: params.lastHop,
  }).then((r) => ({
    swapHash: r.swap_hash,
    id: r.id,
    serverMessage: r.server_message,
    htlcAddress: r.htlc_address,
  }));
}

// ─── Terms ───────────────────────────────────────────────────────────────

export { getLoopOutTerms, getLoopInTerms, isLoopAvailable, listLoopSwaps };

// ─── Fresh on-chain address (for member Loop Out destination) ────────────

export async function generateDestinationAddress(): Promise<string> {
  const { address } = await createLndChainAddress();
  return address;
}
