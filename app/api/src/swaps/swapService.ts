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
import { SwapRefusalError, type SwapRefusalCode } from "./swapRefusal";
import { checkLoopOutRoutes, minerFeeExceedsMargin } from "../lightning/loopOutPrechecks";
import { ceilingsFor, ceilingsMatch } from "./swapCeilings";

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
  // No max_fee_sat: the column stays in the database, unread and unwritten,
  // and never appears in a response (loop-fee-ceilings B6, item 30, D19).
  quoted_fee_sat: number | null;
  // The quote's components (migrations 060–062). NULL on a row quoted before
  // them, which execute refuses with requote_required (spec §5, D8).
  quoted_swap_fee_sat: number | null;
  quoted_prepay_sat: number | null; // Loop Out only; NULL for Loop In by design
  quoted_miner_fee_sat: number | null; // Loop Out: sweep fee; Loop In: HTLC fee
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
       status, amount_sat, quoted_fee_sat, destination_address,
       channel_id, quote_expires_at,
       quoted_swap_fee_sat, quoted_prepay_sat, quoted_miner_fee_sat)
    VALUES (?, ?, ?, ?, ?, 'loop_out', 'lightning_to_chain',
            'quote_created', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, now, now, params.nodePubkey, params.role,
    params.amountSat,
    (quote.swap_fee_sat ?? 0) + (quote.miner_fee_sat ?? 0), // swap + miner, without the prepay (P1 open; see swapRoutes.ts)
    destAddr, params.channelId ?? null, expiresAt,
    quote.swap_fee_sat, quote.prepay_sat, quote.miner_fee_sat
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
}): Promise<{ swapRequest: SwapRequest; quote: LoopInQuoteResult }> {
  const quote = await quoteLoopIn(params.amountSat);
  // Ruling Z (spec §4 D, D12): getLoopInQuote clamps loopd's −1 ("estimation
  // failed") to 0, so 0 here means failed OR zero — unknown either way. Refuse
  // before anything is stored, so no executable quote carries a 0 miner fee
  // and the confirmation never shows one.
  if (!(quote.htlc_publish_fee_sat > 0)) {
    throw new SwapRefusalError(
      "miner_fee_unknown",
      "The network fee for this refill couldn't be estimated right now. Try again in a few minutes."
    );
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  const expiresAt = now + ENV.swapQuoteExpirySec * 1000;

  db.prepare(`
    INSERT INTO swap_requests
      (id, created_at, updated_at, node_pubkey, role, swap_type, direction,
       status, amount_sat, quoted_fee_sat, quote_expires_at,
       quoted_swap_fee_sat, quoted_miner_fee_sat)
    VALUES (?, ?, ?, ?, ?, 'loop_in', 'chain_to_lightning',
            'quote_created', ?, ?, ?, ?, ?)
  `).run(id, now, now, params.nodePubkey, params.role, params.amountSat,
    quote.total_fee_sat, expiresAt,
    quote.swap_fee_sat, quote.htlc_publish_fee_sat);

  recordSwapEvent(id, "quote_created", { amount_sat: params.amountSat, quote, expires_at: expiresAt });

  return { swapRequest: getSwapRequest(id)!, quote };
}

// ─── Swap initiation ─────────────────────────────────────────────────────

/**
 * @param echoed The execute request's body. Its ceilings (the quote response's
 *   `ceilings`, F4) must equal the stored quote's; the confirmation hash
 *   covers them too. Other keys in it are ignored.
 */
export async function initiateSwap(
  swapRequestId: string,
  destinationAddress: string | undefined,
  echoed: Record<string, unknown>
): Promise<SwapRequest> {
  const req = getSwapRequest(swapRequestId);
  if (!req) throw new Error("Swap request not found");
  if (req.status !== "quote_created" && req.status !== "awaiting_confirmation") {
    throw new Error(`Cannot initiate swap in status: ${req.status}`);
  }
  if (req.quote_expires_at && Date.now() > req.quote_expires_at) {
    updateSwapStatus(swapRequestId, "expired");
    throw new Error("Quote has expired");
  }

  // A row quoted before migrations 060–062 has no components to bind the
  // ceilings to. Refuse and requote; never fall back to the 15% formula
  // (spec §5, D8). Loop In has no prepay, so only its two are required.
  const missingComponents =
    req.quoted_swap_fee_sat == null ||
    req.quoted_miner_fee_sat == null ||
    (req.swap_type === "loop_out" && req.quoted_prepay_sat == null);
  if (missingComponents) {
    recordSwapEvent(swapRequestId, "initiation_refused", { code: "requote_required" });
    throw new SwapRefusalError(
      "requote_required",
      "This quote was made before an update and can't be used. Get a new quote."
    );
  }

  // F4 (spec §6): the ceilings the caller confirmed must be the ones this
  // quote authorises. A mismatch — altered, missing, or computed under a
  // different routing-cap setting — is refused and requoted.
  const expected = ceilingsFor(req)!;
  if (!ceilingsMatch(expected, echoed)) {
    recordSwapEvent(swapRequestId, "initiation_refused", { code: "ceiling_mismatch", expected });
    throw new SwapRefusalError(
      "ceiling_mismatch",
      "The fee limits sent don't match this quote. Get a new quote."
    );
  }

  if (req.swap_type === "loop_out") {
    await assertLoopOutPrechecks(req);
  } else if (req.swap_type === "loop_in") {
    await assertLoopInPrechecks(req);
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
        // Ceilings are the stored quote's components, with no margin (F1, F3).
        // Non-null: rows missing them were refused above.
        maxSwapFee: updatedReq.quoted_swap_fee_sat!,
        maxMinerFee: updatedReq.quoted_miner_fee_sat!,
        maxPrepay: updatedReq.quoted_prepay_sat!,
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
        // The quoted swap fee alone, without the HTLC fee (ruling 10, D16), and
        // the quoted HTLC fee as the miner ceiling (F3). Non-null: rows
        // missing them were refused above.
        maxSwapFee: updatedReq.quoted_swap_fee_sat!,
        maxMinerFee: updatedReq.quoted_miner_fee_sat!,
        confTarget: ENV.loopConfTarget,
        lastHop: ENV.treasuryPubkey || undefined, // hub-and-spoke: tell Loop server to route through treasury
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

/** Builds a refusal for one swap request, recording why before it is thrown. */
function refuser(swapRequestId: string) {
  return (code: SwapRefusalCode, message: string, data: Record<string, unknown>) => {
    recordSwapEvent(swapRequestId, "initiation_refused", { code, ...data });
    return new SwapRefusalError(code, message);
  };
}

/**
 * Loop In (site D): the fee-rate refusal before initiation, at the HTLC conf
 * target (spec §4 D, F3), from one fresh quote at the same amount and conf
 * target. A fresh estimate that failed or is zero is unknown and refused
 * (Ruling Z) — otherwise 0 would pass any margin. There is no route probe on
 * D here: the Loop In pre-quote probe (probeRouteToLoopServer, in
 * checkMemberLoopInPolicy) is unchanged.
 */
async function assertLoopInPrechecks(req: SwapRequest): Promise<void> {
  const refuse = refuser(req.id);
  const fresh = await quoteLoopIn(req.amount_sat);
  const quotedMinerFee = req.quoted_miner_fee_sat!;
  if (!(fresh.htlc_publish_fee_sat > 0)) {
    throw refuse(
      "miner_fee_unknown",
      "The network fee for this refill couldn't be estimated right now. Try again in a few minutes.",
      { quoted_miner_fee_sat: quotedMinerFee, fresh_miner_fee_sat: fresh.htlc_publish_fee_sat }
    );
  }
  if (minerFeeExceedsMargin(fresh.htlc_publish_fee_sat, quotedMinerFee)) {
    throw refuse(
      "fee_rate_over_quote",
      "Network fees have gone up since this quote. Get a new quote.",
      { quoted_miner_fee_sat: quotedMinerFee, fresh_miner_fee_sat: fresh.htlc_publish_fee_sat }
    );
  }
}

/**
 * Loop Out (sites A and B): the fee-rate check and the route probe, before any
 * money-moving loopd call (spec §4 A and B). Both use one fresh loopd quote at
 * the same amount and conf target: its miner fee for the fee-rate check, and
 * its swap_payment_dest as the probe's first target. The ceilings themselves
 * stay the STORED quote's — the fresh quote only checks.
 *
 * A refusal throws SwapRefusalError and records why, leaving the row as it
 * was. Any other error (the fresh quote failing) propagates the same way,
 * also before initiation.
 */
async function assertLoopOutPrechecks(req: SwapRequest): Promise<void> {
  const refuse = refuser(req.id);

  const fresh = await quoteLoopOut(req.amount_sat);
  const quotedMinerFee = req.quoted_miner_fee_sat!;
  if (minerFeeExceedsMargin(fresh.miner_fee_sat, quotedMinerFee)) {
    throw refuse(
      "fee_rate_over_quote",
      "Network fees have gone up since this quote. Get a new quote.",
      { quoted_miner_fee_sat: quotedMinerFee, fresh_miner_fee_sat: fresh.miner_fee_sat }
    );
  }

  const route = await checkLoopOutRoutes({
    swapPaymentDest: fresh.swap_payment_dest,
    amountSat: req.amount_sat,
    prepaySat: req.quoted_prepay_sat!,
    outgoingChannel: req.channel_id ?? undefined,
  });
  if (!route.ok) {
    if (route.reason === "no_route") {
      throw refuse(
        "route_not_found",
        "No payment route to the swap service was found. Try again later.",
        { checked: route.checked }
      );
    }
    throw refuse(
      "route_fee_over_cap",
      "Routing this payment would cost more than the allowed routing fee. Try again later.",
      {
        branch: route.branch,
        target: route.target,
        swap_route_fee_sat: route.swapRouteFeeSat,
        prepay_route_fee_sat: route.prepayRouteFeeSat,
        swap_cap_sat: route.swapCapSat,
        prepay_cap_sat: route.prepayCapSat,
      }
    );
  }
  // Which branch ran is recorded: the post-deploy real Loop Out reads it
  // (spec §10, post-deploy (4)).
  recordSwapEvent(req.id, "route_probed", {
    branch: route.branch,
    target: route.target,
    swap_route_fee_sat: route.swapRouteFeeSat,
    prepay_route_fee_sat: route.prepayRouteFeeSat,
  });
}

// ─── Status helpers ──────────────────────────────────────────────────────

// Every column a SwapRequest carries, named. Not SELECT *: max_fee_sat stays
// in the table, unread, and must not reach any swap_request response — every
// route's swap_request comes through these two readers (loop-fee-ceilings
// B6, item 30, D19).
const SWAP_REQUEST_COLUMNS = `
  id, created_at, updated_at, node_pubkey, role, swap_type, direction, status,
  amount_sat, quoted_fee_sat, quoted_swap_fee_sat, quoted_prepay_sat,
  quoted_miner_fee_sat, actual_fee_sat, destination_address, channel_id,
  quote_expires_at, failure_reason, notes`;

export function getSwapRequest(id: string): SwapRequest | null {
  return db.prepare(`SELECT ${SWAP_REQUEST_COLUMNS} FROM swap_requests WHERE id = ?`).get(id) as SwapRequest | null;
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
  let sql = `SELECT ${SWAP_REQUEST_COLUMNS} FROM swap_requests WHERE 1=1`;
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
