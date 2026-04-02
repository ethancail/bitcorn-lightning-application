// Swap API route handlers — member withdrawal + treasury swap operations.
// Follows the same pattern as liquidityRoutes.ts and other route handlers.

import type { IncomingMessage, ServerResponse } from "http";
import { getNodeInfo } from "../api/read";
import { assertTreasury } from "../utils/role";
import { assertActiveMember } from "../utils/membership";
import {
  createLoopOutQuote,
  initiateSwap,
  getSwapRequest,
  getSwapExecution,
  getSwapEvents,
  listSwapRequests,
} from "./swapService";
import {
  checkMemberLoopOutPolicy,
  checkTreasuryLoopOutPolicy,
} from "./swapPolicy";
import { isLoopAvailable } from "./loopProvider";

type Res = ServerResponse;

function json(res: Res, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
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
  const maxFeeSat = body.max_fee_sat ? Number(body.max_fee_sat) : undefined;

  if (!amountSat || amountSat <= 0) return json(res, 400, { error: "invalid_amount" });

  const loopStatus = await isLoopAvailable();
  if (!loopStatus.available) return json(res, 503, { error: "loop_unavailable", detail: loopStatus.error });

  const { swapRequest, quote } = await createLoopOutQuote({
    nodePubkey: node.pubkey,
    role: node.node_role === "treasury" ? "treasury" : "member",
    amountSat,
    destinationAddress,
    maxFeeSat,
  });

  // Pre-check policy (non-blocking — quote still created)
  // Use net fee (swap + miner) for policy check — prepay is a temporary hold
  // that's returned as part of the on-chain payment, not an additional cost.
  const netFeeSat = (quote.swap_fee_sat ?? 0) + (quote.miner_fee_sat ?? 0);
  const policy = await checkMemberLoopOutPolicy({
    nodePubkey: node.pubkey,
    amountSat,
    maxFeeSat,
    quotedFeeSat: netFeeSat,
  });

  json(res, 200, { swap_request: swapRequest, quote, policy_check: policy });
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

  const result = await initiateSwap(swapRequestId, destinationAddress);
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
  json(res, 200, { swap_request: swapRequest, quote, policy_check: policy });
}

export async function handleAdminLoopOut(req: IncomingMessage, res: Res): Promise<void> {
  const node = getNodeInfo();
  assertTreasury(node?.node_role);

  const body = JSON.parse(await parseBody(req));
  const swapRequestId = body.swap_request_id as string;
  const destinationAddress = body.destination_address as string | undefined;

  if (!swapRequestId) return json(res, 400, { error: "swap_request_id_required" });

  const existing = getSwapRequest(swapRequestId);
  if (!existing) return json(res, 404, { error: "swap_request_not_found" });

  const policy = await checkTreasuryLoopOutPolicy({
    amountSat: existing.amount_sat,
    quotedFeeSat: existing.quoted_fee_sat ?? 0,
  });
  if (!policy.ok) return json(res, 429, { error: "policy_violation", detail: policy.reason, code: policy.code });

  const result = await initiateSwap(swapRequestId, destinationAddress);
  json(res, 200, { swap_request: result, execution: getSwapExecution(swapRequestId) });
}

// Treasury Loop In handlers removed from active architecture (v1.7.1).
// Merchant-side liquidity uses channel lifecycle management, not Loop In.
// Low-level gRPC support retained in loop.ts / loopProvider.ts for potential future use.

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
