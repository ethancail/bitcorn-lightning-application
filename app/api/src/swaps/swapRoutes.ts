// Swap API route handlers — member withdrawal + treasury swap operations.
// Follows the same pattern as the other route handlers.

import type { IncomingMessage, ServerResponse } from "http";
import { getNodeInfo } from "../api/read";
import { assertTreasury } from "../utils/role";
import { assertActiveMember } from "../utils/membership";
import {
  createLoopOutQuote,
  createLoopInQuote,
  initiateSwap,
  getSwapRequest,
  getSwapExecution,
  getSwapEvents,
  listSwapRequests,
  type SwapRequest,
} from "./swapService";
import { SwapRefusalError } from "./swapRefusal";
import { ceilingsFor } from "./swapCeilings";
import {
  checkMemberLoopOutPolicy,
  checkTreasuryLoopOutPolicy,
  checkMemberLoopInPolicy,
  getMemberSwapLimits,
} from "./swapPolicy";
import { isLoopAvailable } from "./loopProvider";
import { validateOnchainAddress } from "../utils/btc-address";
import { ENV } from "../config/env";

type Res = ServerResponse;

function json(res: Res, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** initiateSwap, with a refusal before initiation answered as a 409 carrying
 *  its own code. Returns null when it has already answered. */
async function initiateOrRefuse(
  res: Res,
  swapRequestId: string,
  destinationAddress: string | undefined,
  body: Record<string, unknown>
): Promise<SwapRequest | null> {
  try {
    // The body carries the echoed ceilings (F4); initiateSwap checks them
    // against the stored quote.
    return await initiateSwap(swapRequestId, destinationAddress, body);
  } catch (e) {
    if (e instanceof SwapRefusalError) {
      json(res, 409, { error: e.code, detail: e.message });
      return null;
    }
    throw e;
  }
}

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => { body += c.toString(); });
    req.on("end", () => resolve(body));
  });
}

// ─── Member endpoints ────────────────────────────────────────────────────

export async function handleMemberLoopOutQuote(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });
  if (node.node_role !== "treasury") assertActiveMember(node.membership_status);

  const body = JSON.parse(await parseBody(req));
  const amountSat = Number(body.amount_sat);
  const destinationAddress = body.destination_address as string | undefined;
  // No max_fee_sat: the parameter is removed (loop-fee-ceilings B6). A body
  // that still sends one is ignored.

  if (!amountSat || amountSat <= 0) return json(res, 400, { error: "invalid_amount" });

  const loopStatus = await isLoopAvailable();
  if (!loopStatus.available) return json(res, 503, { error: "loop_unavailable", detail: loopStatus.error });

  // Phase 1: the pre-quote policy, before any swap_requests row or loopd quote
  // exists (drive-mode P1 item 7) — the shape Loop In already has.
  const preCheck = await checkMemberLoopOutPolicy({ nodePubkey: node.pubkey, amountSat });
  if (!preCheck.ok) {
    const status = preCheck.code === "loop_unavailable" ? 503 : 429;
    return json(res, status, { error: "policy_violation", detail: preCheck.reason, code: preCheck.code });
  }

  const { swapRequest, quote } = await createLoopOutQuote({
    nodePubkey: node.pubkey,
    role: node.node_role === "treasury" ? "treasury" : "member",
    amountSat,
    destinationAddress,
  });

  // Phase 2: the fee phase (advisory — the quote is already created)
  // The policy's fee is swap + miner, without the prepay: the prepay is an
  // advance on the principal, not a fee. Polar gate 1's L3 measured it (regtest
  // loopserver, not production): swap invoice + prepay − on-chain HTLC = the
  // quoted swap fee, so the prepay counts toward the amount withdrawn. The
  // authorised maximum shown to the member therefore excludes it (P12 p,
  // superseding ruling 11), and max_prepay_amt is bound to the quoted prepay.
  // The post-deploy mainnet Loop Out confirms it; if it disagrees, mainnet
  // governs (spec §7, §12 P1).
  const netFeeSat = (quote.swap_fee_sat ?? 0) + (quote.miner_fee_sat ?? 0);
  const policy = await checkMemberLoopOutPolicy({
    nodePubkey: node.pubkey,
    amountSat,
    quotedFeeSat: netFeeSat,
  });

  json(res, 200, { swap_request: swapRequest, quote, ceilings: ceilingsFor(swapRequest), policy_check: policy });
}

export async function handleMemberLoopOut(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });
  if (node.node_role !== "treasury") assertActiveMember(node.membership_status);

  const body = JSON.parse(await parseBody(req));
  const swapRequestId = body.swap_request_id as string;
  const destinationAddress = body.destination_address as string;

  if (!swapRequestId) return json(res, 400, { error: "swap_request_id_required" });
  if (!destinationAddress) return json(res, 400, { error: "destination_address_required" });

  const memberDestCheck = validateOnchainAddress(destinationAddress, ENV.bitcoinNetwork);
  if (!memberDestCheck.ok) {
    return json(res, 400, { error: "invalid_destination_address", detail: memberDestCheck.detail });
  }

  const existing = getSwapRequest(swapRequestId);
  if (!existing) return json(res, 404, { error: "swap_request_not_found" });
  if (existing.node_pubkey !== node.pubkey) return json(res, 403, { error: "not_your_swap" });

  // Enforce policy before execution
  const policy = await checkMemberLoopOutPolicy({
    nodePubkey: node.pubkey,
    amountSat: existing.amount_sat,
    quotedFeeSat: existing.quoted_fee_sat ?? 0,
  });
  if (!policy.ok) return json(res, 429, { error: "policy_violation", detail: policy.reason, code: policy.code });

  const result = await initiateOrRefuse(res, swapRequestId, destinationAddress, body);
  if (!result) return;
  json(res, 200, { swap_request: result, execution: getSwapExecution(swapRequestId) });
}

// ─── Member Loop In (refill) ────────────────────────────────────────────

export async function handleMemberLoopInQuote(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });
  if (node.node_role !== "treasury") assertActiveMember(node.membership_status);

  const body = JSON.parse(await parseBody(req));
  const amountSat = Number(body.amount_sat);
  if (!amountSat || amountSat <= 0) return json(res, 400, { error: "invalid_amount" });

  const loopStatus = await isLoopAvailable();
  if (!loopStatus.available) return json(res, 503, { error: "loop_unavailable", detail: loopStatus.error });

  // Phase 1: pre-quote policy check (includes route probe)
  const preCheck = await checkMemberLoopInPolicy({
    nodePubkey: node.pubkey,
    amountSat,
  });
  if (!preCheck.ok) {
    const status = preCheck.code === "route_unavailable" || preCheck.code === "loop_unavailable" ? 503 : 429;
    return json(res, status, { error: "policy_violation", detail: preCheck.reason, code: preCheck.code });
  }

  // Create quote (calls loopd GetLoopInQuote). A failed or zero HTLC-fee
  // estimate is refused here with its own code (Ruling Z).
  let created: Awaited<ReturnType<typeof createLoopInQuote>>;
  try {
    created = await createLoopInQuote({
      nodePubkey: node.pubkey,
      role: node.node_role === "treasury" ? "treasury" : "member",
      amountSat,
    });
  } catch (e) {
    if (e instanceof SwapRefusalError) return json(res, 409, { error: e.code, detail: e.message });
    throw e;
  }
  const { swapRequest, quote } = created;

  // Phase 2: post-quote policy check (fee cap — advisory)
  const postCheck = await checkMemberLoopInPolicy({
    nodePubkey: node.pubkey,
    amountSat,
    quotedFeeSat: quote.total_fee_sat,
    minerFeeSat: quote.htlc_publish_fee_sat, // the quote's, R18(10)
  });

  // miner_fee_margin_pct (ruling tt): the margin minerFeeExceedsMargin allows
  // before initiation, so the web's "Most you authorize in fees" can include
  // it. Beside `ceilings`, never in them: the ceilings are echoed and hashed (F4),
  // and this is not a ceiling sent to loopd.
  json(res, 200, {
    swap_request: swapRequest,
    quote,
    ceilings: ceilingsFor(swapRequest),
    miner_fee_margin_pct: ENV.loopMinerFeeMarginPct,
    policy_check: postCheck,
  });
}

export async function handleMemberLoopIn(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });
  if (node.node_role !== "treasury") assertActiveMember(node.membership_status);

  const body = JSON.parse(await parseBody(req));
  const swapRequestId = body.swap_request_id as string;
  if (!swapRequestId) return json(res, 400, { error: "swap_request_id_required" });

  const existing = getSwapRequest(swapRequestId);
  if (!existing) return json(res, 404, { error: "swap_request_not_found" });
  if (existing.node_pubkey !== node.pubkey) return json(res, 403, { error: "not_your_swap" });

  // Full policy enforcement (with stored fee)
  const policy = await checkMemberLoopInPolicy({
    nodePubkey: node.pubkey,
    amountSat: existing.amount_sat,
    quotedFeeSat: existing.quoted_fee_sat ?? 0,
    // The stored quote's HTLC fee (migration 062), R18(10). NULL only on a row
    // quoted before 062, which execute refuses with requote_required anyway.
    minerFeeSat: existing.quoted_miner_fee_sat ?? undefined,
  });
  if (!policy.ok) return json(res, 429, { error: "policy_violation", detail: policy.reason, code: policy.code });

  const result = await initiateOrRefuse(res, swapRequestId, undefined, body);
  if (!result) return;
  json(res, 200, { swap_request: result, execution: getSwapExecution(swapRequestId) });
}

export async function handleGetSwap(req: IncomingMessage, res: Res, swapId: string): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });

  const swap = getSwapRequest(swapId);
  if (!swap) return json(res, 404, { error: "swap_not_found" });

  // Members can only see their own swaps; treasury can see all
  if (node.node_role !== "treasury" && swap.node_pubkey !== node.pubkey) {
    return json(res, 403, { error: "not_your_swap" });
  }

  const execution = getSwapExecution(swapId);
  const events = getSwapEvents(swapId);
  json(res, 200, { swap_request: swap, execution, events });
}

export async function handleSwapHistory(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });

  const url = new URL(req.url ?? "", "http://localhost");
  const limit = Number(url.searchParams.get("limit")) || 20;

  const swaps = listSwapRequests({
    nodePubkey: node.node_role === "treasury" ? undefined : node.pubkey,
    limit,
  });

  json(res, 200, { swaps });
}

/** GET /api/swaps/limits — the effective member swap limits per direction
 *  and today's remaining daily amount (drive-mode P1 item 6). A read. */
export async function handleSwapLimits(_req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  if (!node) return json(res, 503, { error: "node_info_unavailable" });
  json(res, 200, await getMemberSwapLimits(node.pubkey));
}

// ─── Treasury (admin) endpoints ──────────────────────────────────────────

export async function handleAdminLoopOutQuote(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const body = JSON.parse(await parseBody(req));
  const amountSat = Number(body.amount_sat);
  const channelId = body.channel_id as string | undefined;
  if (!amountSat || amountSat <= 0) return json(res, 400, { error: "invalid_amount" });

  const { swapRequest, quote } = await createLoopOutQuote({
    nodePubkey: node!.pubkey,
    role: "treasury",
    amountSat,
    channelId,
  });

  const treasuryNetFee = (quote.swap_fee_sat ?? 0) + (quote.miner_fee_sat ?? 0);
  const policy = await checkTreasuryLoopOutPolicy({ amountSat, quotedFeeSat: treasuryNetFee });
  json(res, 200, { swap_request: swapRequest, quote, ceilings: ceilingsFor(swapRequest), policy_check: policy });
}

export async function handleAdminLoopOut(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const body = JSON.parse(await parseBody(req));
  const swapRequestId = body.swap_request_id as string;
  const destinationAddress = body.destination_address as string | undefined;

  if (!swapRequestId) return json(res, 400, { error: "swap_request_id_required" });

  // A wrong custom destination is an irreversible-loss path — validate
  // checksum + network before anything reaches loopd.
  if (destinationAddress) {
    const destCheck = validateOnchainAddress(destinationAddress, ENV.bitcoinNetwork);
    if (!destCheck.ok) {
      return json(res, 400, { error: "invalid_destination_address", detail: destCheck.detail });
    }
  }

  const existing = getSwapRequest(swapRequestId);
  if (!existing) return json(res, 404, { error: "swap_request_not_found" });

  const policy = await checkTreasuryLoopOutPolicy({
    amountSat: existing.amount_sat,
    quotedFeeSat: existing.quoted_fee_sat ?? 0,
  });
  if (!policy.ok) return json(res, 429, { error: "policy_violation", detail: policy.reason, code: policy.code });

  const result = await initiateOrRefuse(res, swapRequestId, destinationAddress, body);
  if (!result) return;
  json(res, 200, { swap_request: result, execution: getSwapExecution(swapRequestId) });
}

// Treasury-initiated Loop In handlers removed from active architecture (v1.7.1).
// Treasury maintains inbound via Loop OUT. Member-side Loop In (merchant refill)
// is handled above by handleMemberLoopInQuote / handleMemberLoopIn.

export async function handleAdminSwapList(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const url = new URL(req.url ?? "", "http://localhost");
  const limit = Number(url.searchParams.get("limit")) || 50;
  const swaps = listSwapRequests({ limit });
  json(res, 200, { swaps });
}

export async function handleAdminGetSwap(req: IncomingMessage, res: Res, swapId: string): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const swap = getSwapRequest(swapId);
  if (!swap) return json(res, 404, { error: "swap_not_found" });
  const execution = getSwapExecution(swapId);
  const events = getSwapEvents(swapId);
  json(res, 200, { swap_request: swap, execution, events });
}
