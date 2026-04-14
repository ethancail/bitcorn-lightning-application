// Swap service — orchestrates quote creation, swap initiation, status lookup.
// Delegates to loopProvider for Loop-specific logic.
// Records all state transitions to swap_events for auditability.

import crypto from "crypto";
import { db } from "../db";
import { ENV } from "../config/env";
import {
  quoteLoopOut,
  quoteLoopIn,
  initiateLoopOut,
  initiateLoopIn,
  recordSwapEvent,
  generateDestinationAddress,
  type AppSwapStatus,
  type LoopOutQuoteResult,
  type LoopInQuoteResult,
} from "./loopProvider";

// ─── Types ───────────────────────────────────────────────────────────────

export type SwapRequest = {
  id: string;
  created_at: number;
  updated_at: number;
  node_pubkey: string;
  role: string;
  swap_type: string;
  direction: string;
  status: string;
  amount_sat: number;
  max_fee_sat: number | null;
  quoted_fee_sat: number | null;
  actual_fee_sat: number | null;
  destination_address: string | null;
  channel_id: string | null;
  quote_expires_at: number | null;
  failure_reason: string | null;
  notes: string | null;
};

export type SwapExecution = {
  id: string;
  swap_request_id: string;
  provider: string;
  provider_swap_id: string | null;
  status: string;
  raw_provider_status: string | null;
  onchain_txid: string | null;
  sweep_txid: string | null;
  started_at: number;
  completed_at: number | null;
};

// ─── Quote creation ──────────────────────────────────────────────────────

export async function createLoopOutQuote(params: {
  nodePubkey: string;
  role: "member" | "treasury";
  amountSat: number;
  destinationAddress?: string;
  maxFeeSat?: number;
  channelId?: string;
}): Promise<{ swapRequest: SwapRequest; quote: LoopOutQuoteResult }> {
  const quote = await quoteLoopOut(params.amountSat);
  const now = Date.now();
  const id = crypto.randomUUID();
  const expiresAt = now + ENV.swapQuoteExpirySec * 1000;

  // For member withdrawals, generate a destination address if not provided
  const destAddr = params.destinationAddress || (params.role === "member" ? null : null);

  db.prepare(`
    INSERT INTO swap_requests
      (id, created_at, updated_at, node_pubkey, role, swap_type, direction,
       status, amount_sat, max_fee_sat, quoted_fee_sat, destination_address,
       channel_id, quote_expires_at)
    VALUES (?, ?, ?, ?, ?, 'loop_out', 'lightning_to_chain',
            'quote_created', ?, ?, ?, ?, ?, ?)
  `).run(
    id, now, now, params.nodePubkey, params.role,
    params.amountSat, params.maxFeeSat ?? null,
    (quote.swap_fee_sat ?? 0) + (quote.miner_fee_sat ?? 0), // net fee (excludes prepay hold)
    destAddr, params.channelId ?? null, expiresAt
  );

  recordSwapEvent(id, "quote_created", {
    amount_sat: params.amountSat,
    quote,
    expires_at: expiresAt,
  });

  return {
    swapRequest: getSwapRequest(id)!,
    quote,
  };
}

// Loop In quote creation — used by both member refill and (future) treasury operations.
export async function createLoopInQuote(params: {
  nodePubkey: string;
  role: "member" | "treasury";
  amountSat: number;
  maxFeeSat?: number;
}): Promise<{ swapRequest: SwapRequest; quote: LoopInQuoteResult }> {
  const quote = await quoteLoopIn(params.amountSat);
  const now = Date.now();
  const id = crypto.randomUUID();
  const expiresAt = now + ENV.swapQuoteExpirySec * 1000;

  db.prepare(`
    INSERT INTO swap_requests
      (id, created_at, updated_at, node_pubkey, role, swap_type, direction,
       status, amount_sat, max_fee_sat, quoted_fee_sat, quote_expires_at)
    VALUES (?, ?, ?, ?, ?, 'loop_in', 'chain_to_lightning',
            'quote_created', ?, ?, ?, ?)
  `).run(id, now, now, params.nodePubkey, params.role, params.amountSat,
    params.maxFeeSat ?? null, quote.total_fee_sat, expiresAt);

  recordSwapEvent(id, "quote_created", { amount_sat: params.amountSat, quote, expires_at: expiresAt });

  return { swapRequest: getSwapRequest(id)!, quote };
}

// ─── Swap initiation ─────────────────────────────────────────────────────

export async function initiateSwap(swapRequestId: string, destinationAddress?: string): Promise<SwapRequest> {
  const req = getSwapRequest(swapRequestId);
  if (!req) throw new Error("Swap request not found");
  if (req.status !== "quote_created" && req.status !== "awaiting_confirmation") {
    throw new Error(`Cannot initiate swap in status: ${req.status}`);
  }
  if (req.quote_expires_at && Date.now() > req.quote_expires_at) {
    updateSwapStatus(swapRequestId, "expired");
    throw new Error("Quote has expired");
  }

  const now = Date.now();
  const execId = crypto.randomUUID();

  // Update destination address if provided (member withdrawals)
  if (destinationAddress) {
    db.prepare("UPDATE swap_requests SET destination_address = ?, updated_at = ? WHERE id = ?")
      .run(destinationAddress, now, swapRequestId);
  }

  const updatedReq = getSwapRequest(swapRequestId)!;

  try {
    if (updatedReq.swap_type === "loop_out") {
      const dest = updatedReq.destination_address;
      if (!dest) throw new Error("Destination address required for Loop Out");

      const result = await initiateLoopOut({
        amountSat: updatedReq.amount_sat,
        destinationAddress: dest,
        maxSwapFee: Math.ceil(updatedReq.amount_sat * ENV.loopMaxSwapFeePct / 100),
        maxMinerFee: ENV.loopMaxMinerFeeSats,
        maxPrepay: 50_000, // prepay is a temporary hold (~30k), not a fee — safe ceiling
        confTarget: ENV.loopConfTarget,
        channelIds: updatedReq.channel_id ? [updatedReq.channel_id] : undefined,
      });

      db.prepare(`
        INSERT INTO swap_executions
          (id, swap_request_id, provider, provider_swap_id, status, started_at)
        VALUES (?, ?, 'loop', ?, 'initiated', ?)
      `).run(execId, swapRequestId, result.swapHash, now);

      updateSwapStatus(swapRequestId, "initiated");
      recordSwapEvent(swapRequestId, "swap_initiated", { provider_swap_id: result.swapHash, server_message: result.serverMessage }, execId);

    } else if (updatedReq.swap_type === "loop_in") {
      const result = await initiateLoopIn({
        amountSat: updatedReq.amount_sat,
        maxSwapFee: updatedReq.quoted_fee_sat ?? Math.ceil(updatedReq.amount_sat * ENV.loopMaxSwapFeePct / 100),
        maxMinerFee: ENV.loopMaxMinerFeeSats,
        confTarget: ENV.loopConfTarget,
      });

      db.prepare(`
        INSERT INTO swap_executions
          (id, swap_request_id, provider, provider_swap_id, htlc_address, status, started_at)
        VALUES (?, ?, 'loop', ?, ?, 'initiated', ?)
      `).run(execId, swapRequestId, result.swapHash, result.htlcAddress, now);

      updateSwapStatus(swapRequestId, "initiated");
      recordSwapEvent(swapRequestId, "swap_initiated", {
        provider_swap_id: result.swapHash,
        htlc_address: result.htlcAddress,
        server_message: result.serverMessage,
      }, execId);

    } else {
      throw new Error(`Unsupported swap type: ${updatedReq.swap_type}`);
    }
  } catch (err: any) {
    updateSwapStatus(swapRequestId, "failed", err.message);
    recordSwapEvent(swapRequestId, "initiation_failed", { error: err.message });
    throw err;
  }

  return getSwapRequest(swapRequestId)!;
}

// ─── Status helpers ──────────────────────────────────────────────────────

export function getSwapRequest(id: string): SwapRequest | null {
  return db.prepare("SELECT * FROM swap_requests WHERE id = ?").get(id) as SwapRequest | null;
}

export function getSwapExecution(swapRequestId: string): SwapExecution | null {
  return db.prepare(
    "SELECT * FROM swap_executions WHERE swap_request_id = ? ORDER BY started_at DESC LIMIT 1"
  ).get(swapRequestId) as SwapExecution | null;
}

export function listSwapRequests(params: {
  nodePubkey?: string;
  role?: string;
  limit?: number;
}): SwapRequest[] {
  let sql = "SELECT * FROM swap_requests WHERE 1=1";
  const args: unknown[] = [];
  if (params.nodePubkey) { sql += " AND node_pubkey = ?"; args.push(params.nodePubkey); }
  if (params.role) { sql += " AND role = ?"; args.push(params.role); }
  sql += " ORDER BY created_at DESC";
  if (params.limit) { sql += " LIMIT ?"; args.push(params.limit); }
  return db.prepare(sql).all(...args) as SwapRequest[];
}

export function getSwapEvents(swapRequestId: string): Array<{
  id: string; event_type: string; event_json: string; created_at: number;
}> {
  return db.prepare(
    "SELECT * FROM swap_events WHERE swap_request_id = ? ORDER BY created_at ASC"
  ).all(swapRequestId) as any[];
}

export function updateSwapStatus(id: string, status: AppSwapStatus, failureReason?: string): void {
  const now = Date.now();
  if (failureReason) {
    db.prepare("UPDATE swap_requests SET status = ?, failure_reason = ?, updated_at = ? WHERE id = ?")
      .run(status, failureReason, now, id);
  } else {
    db.prepare("UPDATE swap_requests SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);
  }
  recordSwapEvent(id, "status_changed", { new_status: status, failure_reason: failureReason ?? null });
}
