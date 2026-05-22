// Bitcorn Lightning — Cloudflare Worker BASE proxy handlers.
//
// Four endpoints surface BASE-side state to the API container while keeping
// the upstream RPC API key secret-side. Authorization mirrors the existing
// three-category Worker model (public / subscriber-base / tier-gated) per
// spec §5.2.
//
//   GET  /base/contract-info   — public; static config + live feeBps/paused
//   POST /base/contract-state  — subscriber-base; generic ABI-call wrapper
//   GET  /base/balance         — subscriber-base; convenience for balanceOf
//   POST /base/events          — subscriber-base; allowlisted eth_getLogs wrapper
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §5
// Contract: bitcorn-stablecoin-rail repo, deployed to 0xF1Bc89... on Base Sepolia

import { CORS_HEADERS } from "../lib/cors";
import { ethCall, ethBlockNumber, ethGetLogs, BaseRpcError, RpcLog } from "../lib/baseRpc";
import {
  AbiType,
  decodeIndexedTopic,
  decodeReturn,
  encodeCallData,
  eventTopic0,
  isAddress,
  normalizeAddress,
  parseSignature,
} from "../lib/abi";
import type { Env } from "../lib/types";

const JSON_HEADERS = { "Content-Type": "application/json", ...CORS_HEADERS };

// -----------------------------------------------------------------------
// Allowlists
// -----------------------------------------------------------------------
// Hard-coded read-side function signatures keyed by their target contract.
// Anything not in this map is rejected at the handler boundary BEFORE any
// upstream RPC call. New endpoints requiring new functions need this map
// updated AND a corresponding spec amendment if scope changes.

interface SignatureSpec {
  /** Solidity function signature in canonical form (param names stripped). */
  signature: string;
  /** Ordered return types — drives decoding of the eth_call result. */
  returnTypes: AbiType[];
}

// SettlementRouter read functions.
const ROUTER_SIGNATURES: Record<string, SignatureSpec> = {
  "owner()":          { signature: "owner()",          returnTypes: ["address"] },
  "feeRecipient()":   { signature: "feeRecipient()",   returnTypes: ["address"] },
  "usdcToken()":      { signature: "usdcToken()",      returnTypes: ["address"] },
  "feeBps()":         { signature: "feeBps()",         returnTypes: ["uint16"]  },
  "MAX_FEE_BPS()":    { signature: "MAX_FEE_BPS()",    returnTypes: ["uint16"]  },
  "paused()":         { signature: "paused()",         returnTypes: ["bool"]    },
};

// USDC (and any ERC-20 we might point at) read functions.
const ERC20_SIGNATURES: Record<string, SignatureSpec> = {
  "balanceOf(address)": { signature: "balanceOf(address)", returnTypes: ["uint256"] },
  "allowance(address,address)": {
    signature: "allowance(address,address)",
    returnTypes: ["uint256"],
  },
  "decimals()":   { signature: "decimals()",   returnTypes: ["uint8"]   },
  "symbol()":     { signature: "symbol()",     returnTypes: [] /* string; v1 doesn't decode */ },
  "totalSupply()":{ signature: "totalSupply()",returnTypes: ["uint256"] },
};

// Event allowlist for /base/events. v1 covers the four events the §7 sync
// loop needs to observe: Settled (state-changing), FeeBpsUpdated (governance),
// Paused/Unpaused (governance). Other SettlementRouter events (OwnershipProposed,
// FeeRecipientUpdated, OwnershipTransferred, OwnershipTransferStarted) are
// audited on-chain via BaseScan; adding them is a small allowlist extension
// when the sync loop needs them.

interface EventSpec {
  /** Full event signature for topic[0] computation (param names stripped). */
  signature: string;
  /** Indexed parameter types in declaration order — drive `topics[1..N]` decoding. */
  indexedTypes: AbiType[];
  /** Snake-case field names returned in the decoded payload (parallel to indexedTypes). */
  indexedNames: string[];
  /** Non-indexed parameter types in declaration order — drive `data` decoding. */
  dataTypes: AbiType[];
  /** Snake-case field names returned in the decoded payload (parallel to dataTypes). */
  dataNames: string[];
}

const EVENT_ALLOWLIST: Record<string, EventSpec> = {
  Settled: {
    signature: "Settled(address,address,uint256,uint256,bytes32)",
    indexedTypes: ["address", "address", "bytes32"],
    indexedNames: ["sender", "recipient", "trade_ref"],
    dataTypes: ["uint256", "uint256"],
    dataNames: ["amount", "fee"],
  },
  FeeBpsUpdated: {
    signature: "FeeBpsUpdated(uint16,uint16)",
    indexedTypes: [],
    indexedNames: [],
    dataTypes: ["uint16", "uint16"],
    dataNames: ["old_bps", "new_bps"],
  },
  Paused: {
    // OZ Pausable's Paused(address) event — note `account` is NOT indexed.
    signature: "Paused(address)",
    indexedTypes: [],
    indexedNames: [],
    dataTypes: ["address"],
    dataNames: ["account"],
  },
  Unpaused: {
    signature: "Unpaused(address)",
    indexedTypes: [],
    indexedNames: [],
    dataTypes: ["address"],
    dataNames: ["account"],
  },
};

// Block-range cap for a single /base/events call. Alchemy's free tier
// rejects eth_getLogs queries spanning more than 10k blocks; this cap
// ensures the Worker returns a clean 400 before the upstream rejects.
const MAX_BLOCK_RANGE = 10_000;

// -----------------------------------------------------------------------
// GET /base/contract-info  (public)
// -----------------------------------------------------------------------

/**
 * Returns the rail's BASE configuration plus the live router state. Static
 * fields come from Worker secrets (set via `wrangler secret put`); live
 * fields (`current_fee_bps`, `is_paused`, `as_of_block_number`) come from
 * a fan-out of three eth_calls + one eth_blockNumber.
 *
 * Public per spec §5.2: members need this before they hold any token, and
 * all values are on-chain-public anyway.
 *
 * Degraded mode: if the upstream RPC is unreachable or unconfigured, the
 * static fields are still returned and the live fields are reported as
 * `null` with an `rpc_status` field explaining why. Members can still
 * discover the contract address; they just won't see the live state.
 */
export async function handleBaseContractInfo(env: Env): Promise<Response> {
  const routerAddress = env.SETTLEMENT_ROUTER_ADDRESS ?? null;
  const usdcAddress = env.USDC_TOKEN_ADDRESS ?? null;
  const chainId = env.BASE_CHAIN_ID ? Number(env.BASE_CHAIN_ID) : null;
  const deployBlock = env.SETTLEMENT_ROUTER_DEPLOY_BLOCK
    ? Number(env.SETTLEMENT_ROUTER_DEPLOY_BLOCK)
    : null;

  let currentFeeBps: number | null = null;
  let isPaused: boolean | null = null;
  let asOfBlock: number | null = null;
  let rpcStatus: "ok" | "unconfigured" | "upstream_error" = "ok";

  if (routerAddress) {
    try {
      // Parallel eth_calls: feeBps, paused, blockNumber.
      const [feeBpsHex, pausedHex, blockHex] = await Promise.all([
        ethCall(env, routerAddress, encodeCallData("feeBps()", [])),
        ethCall(env, routerAddress, encodeCallData("paused()", [])),
        ethBlockNumber(env),
      ]);
      currentFeeBps = Number(decodeReturn(feeBpsHex, ["uint16"])[0]);
      isPaused = Boolean(decodeReturn(pausedHex, ["bool"])[0]);
      asOfBlock = Number(BigInt(blockHex));
    } catch (err) {
      rpcStatus = err instanceof BaseRpcError && err.kind === "unconfigured"
        ? "unconfigured"
        : "upstream_error";
      // Static fields still returned; UI degrades gracefully (§5.4).
    }
  } else {
    rpcStatus = "unconfigured";
  }

  return new Response(
    JSON.stringify({
      chain_id: chainId,
      settlement_router_address: routerAddress,
      settlement_router_deploy_block: deployBlock,
      usdc_token_address: usdcAddress,
      current_fee_bps: currentFeeBps,
      is_paused: isPaused,
      as_of_block_number: asOfBlock,
      rpc_status: rpcStatus,
    }),
    { headers: JSON_HEADERS },
  );
}

// -----------------------------------------------------------------------
// POST /base/contract-state  (subscriber-base scope)
// -----------------------------------------------------------------------

interface ContractStateRequest {
  contract?: string;
  signature?: string;
  args?: unknown[];
  block_tag?: string;
}

/**
 * Generic ABI-encoded eth_call wrapper. Caller supplies the target contract,
 * function signature, and ordered args; Worker encodes, calls, decodes, and
 * returns typed results.
 *
 * Allowlist enforced server-side:
 *   • Target contract must be one of the addresses surfaced via env (Router
 *     or USDC).
 *   • Function signature must appear in ROUTER_SIGNATURES or ERC20_SIGNATURES.
 *
 * Anything outside the allowlist returns HTTP 400. This is stricter than
 * spec §5.1's "method allowlist (eth_call, eth_getLogs, ...)" — we constrain
 * at the signature level because for v1 we know exactly which read calls
 * the API container needs. New signatures land in the maps above when a
 * new read pattern is needed; same for new target contracts.
 */
export async function handleBaseContractState(request: Request, env: Env): Promise<Response> {
  let body: ContractStateRequest;
  try {
    body = (await request.json()) as ContractStateRequest;
  } catch {
    return jsonError(400, "invalid_json", "request body must be JSON");
  }

  const { contract, signature, args = [], block_tag = "latest" } = body;
  if (!contract || !isAddress(contract)) {
    return jsonError(400, "invalid_contract", "contract must be a 20-byte hex address");
  }
  if (!signature || typeof signature !== "string") {
    return jsonError(400, "invalid_signature", "signature is required");
  }

  const allowlist = pickAllowlist(contract, env);
  if (!allowlist) {
    return jsonError(400, "contract_not_allowed", `contract ${contract} is not in the allowlist`);
  }

  const spec = allowlist[signature];
  if (!spec) {
    return jsonError(
      400,
      "signature_not_allowed",
      `signature "${signature}" is not in the allowlist for this contract`,
    );
  }

  // Decode arg encoding errors as 400; upstream errors as 502.
  let callData: string;
  try {
    callData = encodeCallData(spec.signature, args);
  } catch (err) {
    return jsonError(
      400,
      "encode_failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  try {
    const [returnHex, blockHex] = await Promise.all([
      ethCall(env, contract, callData, block_tag),
      ethBlockNumber(env),
    ]);

    let result: unknown;
    if (spec.returnTypes.length === 0) {
      // Caller asked for a function we know about but whose return decoding
      // isn't implemented here (e.g. symbol() returns string). Surface raw hex
      // and let the caller decode if they really need it. Avoids forcing v1
      // to ship a string decoder.
      result = { raw: returnHex };
    } else {
      const decoded = decodeReturn(returnHex, spec.returnTypes);
      result = spec.returnTypes.length === 1
        ? serializeValue(decoded[0])
        : decoded.map(serializeValue);
    }

    return new Response(
      JSON.stringify({
        contract: normalizeAddress(contract),
        signature: spec.signature,
        result,
        as_of_block_number: Number(BigInt(blockHex)),
      }),
      { headers: JSON_HEADERS },
    );
  } catch (err) {
    return mapRpcError(err);
  }
}

// -----------------------------------------------------------------------
// GET /base/balance?address=<addr>&token=<USDC|0x...>  (subscriber-base scope)
// -----------------------------------------------------------------------

/**
 * Read an ERC-20 balance. `token` may be the literal "USDC" (defaults to the
 * configured USDC address) or an explicit allowlisted token address. Returns
 * raw + human-readable amounts plus the block height the balance was read at.
 *
 * This endpoint is a convenience over /base/contract-state; the API container
 * can call either, but /base/balance is the canonical path for member-balance
 * reads driven by the §7 sync loop.
 */
export async function handleBaseBalance(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const addressParam = url.searchParams.get("address");
  const tokenParam = url.searchParams.get("token") ?? "USDC";

  if (!addressParam || !isAddress(addressParam)) {
    return jsonError(400, "invalid_address", "address query param must be a 20-byte hex address");
  }

  let tokenAddress: string;
  if (tokenParam.toUpperCase() === "USDC") {
    if (!env.USDC_TOKEN_ADDRESS) {
      return jsonError(503, "usdc_unconfigured", "USDC_TOKEN_ADDRESS is not set on the Worker");
    }
    tokenAddress = env.USDC_TOKEN_ADDRESS;
  } else if (isAddress(tokenParam)) {
    // Explicit token address — must still be allowlisted (today only USDC).
    if (normalizeAddress(tokenParam) !== normalizeAddress(env.USDC_TOKEN_ADDRESS ?? "")) {
      return jsonError(
        400,
        "token_not_allowed",
        "explicit token address is not allowlisted (only USDC is at v1)",
      );
    }
    tokenAddress = tokenParam;
  } else {
    return jsonError(
      400,
      "invalid_token",
      'token must be "USDC" or an allowlisted 0x address',
    );
  }

  try {
    const [balanceHex, decimalsHex, blockHex] = await Promise.all([
      ethCall(env, tokenAddress, encodeCallData("balanceOf(address)", [addressParam])),
      ethCall(env, tokenAddress, encodeCallData("decimals()", [])),
      ethBlockNumber(env),
    ]);
    const balanceRaw = decodeReturn(balanceHex, ["uint256"])[0] as bigint;
    const decimals = Number(decodeReturn(decimalsHex, ["uint8"])[0]);
    const blockNumber = Number(BigInt(blockHex));

    return new Response(
      JSON.stringify({
        address: normalizeAddress(addressParam),
        token: normalizeAddress(tokenAddress),
        token_symbol: tokenParam.toUpperCase() === "USDC" ? "USDC" : null,
        balance_raw: balanceRaw.toString(),
        decimals,
        balance_human: formatUnits(balanceRaw, decimals),
        as_of_block_number: blockNumber,
      }),
      { headers: JSON_HEADERS },
    );
  } catch (err) {
    return mapRpcError(err);
  }
}

// -----------------------------------------------------------------------
// POST /base/events  (subscriber-base scope)
// -----------------------------------------------------------------------

interface EventsRequest {
  event?: string;
  from_block?: number;
  to_block?: number;
  contract?: string;
}

/**
 * Fetch decoded event logs from the SettlementRouter over a block range.
 *
 * Body:
 *   - event (required): one of "Settled", "FeeBpsUpdated", "Paused", "Unpaused"
 *   - from_block (required): inclusive start block, integer
 *   - to_block (required): inclusive end block, integer
 *   - contract (optional): defaults to env.SETTLEMENT_ROUTER_ADDRESS; if
 *     supplied, must match (allowlist guard)
 *
 * Allowlists enforced server-side:
 *   1. `event` must appear in EVENT_ALLOWLIST. Anything else → 400.
 *   2. `contract` must equal the configured SettlementRouter. Anything
 *      else → 400. New target contracts require an allowlist + spec
 *      amendment.
 *   3. `to_block - from_block` is capped at MAX_BLOCK_RANGE (10,000).
 *      Most upstream RPC providers reject larger ranges anyway; failing
 *      fast at the Worker gives a clean error code.
 *
 * Response:
 *   {
 *     event: "Settled",
 *     contract: "0x...",
 *     from_block: N,
 *     to_block: N+1000,
 *     logs: [
 *       {
 *         block_number: ...,
 *         tx_hash: "0x...",
 *         log_index: ...,
 *         decoded: { sender, recipient, trade_ref, amount, fee }   // event-shape-specific
 *       }, ...
 *     ],
 *     as_of_block_number: N+1100  // current tip; lets caller measure how far behind
 *                                  // their requested range is
 *   }
 *
 * Each indexed parameter is decoded via decodeIndexedTopic; non-indexed
 * parameters via decodeReturn. BigInts (uint256) come back as decimal
 * strings (same convention as /base/contract-state).
 */
export async function handleBaseEvents(request: Request, env: Env): Promise<Response> {
  let body: EventsRequest;
  try {
    body = (await request.json()) as EventsRequest;
  } catch {
    return jsonError(400, "invalid_json", "request body must be JSON");
  }

  const { event, from_block, to_block, contract } = body;

  if (!event || typeof event !== "string") {
    return jsonError(400, "invalid_event", "event field is required");
  }
  const spec = EVENT_ALLOWLIST[event];
  if (!spec) {
    return jsonError(
      400,
      "event_not_allowed",
      `event "${event}" is not in the allowlist (allowed: ${Object.keys(EVENT_ALLOWLIST).join(", ")})`,
    );
  }

  if (typeof from_block !== "number" || !Number.isInteger(from_block) || from_block < 0) {
    return jsonError(400, "invalid_from_block", "from_block must be a non-negative integer");
  }
  if (typeof to_block !== "number" || !Number.isInteger(to_block) || to_block < from_block) {
    return jsonError(400, "invalid_to_block", "to_block must be an integer >= from_block");
  }
  if (to_block - from_block > MAX_BLOCK_RANGE) {
    return jsonError(
      400,
      "block_range_too_large",
      `block range ${to_block - from_block} exceeds cap of ${MAX_BLOCK_RANGE} blocks`,
    );
  }

  // Resolve target contract — defaults to env.SETTLEMENT_ROUTER_ADDRESS.
  const targetContract = contract ?? env.SETTLEMENT_ROUTER_ADDRESS;
  if (!targetContract) {
    return jsonError(
      503,
      "router_unconfigured",
      "SETTLEMENT_ROUTER_ADDRESS is not set on the Worker",
    );
  }
  if (!isAddress(targetContract)) {
    return jsonError(400, "invalid_contract", "contract must be a 20-byte hex address");
  }
  if (
    env.SETTLEMENT_ROUTER_ADDRESS &&
    normalizeAddress(targetContract) !== normalizeAddress(env.SETTLEMENT_ROUTER_ADDRESS)
  ) {
    return jsonError(
      400,
      "contract_not_allowed",
      "explicit contract override is not the SettlementRouter",
    );
  }

  const topic0 = eventTopic0(spec.signature);
  let rawLogs: RpcLog[];
  try {
    rawLogs = await ethGetLogs(env, {
      fromBlock: "0x" + from_block.toString(16),
      toBlock: "0x" + to_block.toString(16),
      address: targetContract,
      topics: [topic0],
    });
  } catch (err) {
    return mapRpcError(err);
  }

  // Decode each log using the event spec. A malformed log (e.g. wrong topic
  // count) shouldn't ever happen given the topic0 filter, but we catch
  // per-log so one bad row doesn't blow up the whole response.
  const logs: unknown[] = [];
  const decodeErrors: Array<{ tx_hash: string; log_index: string; error: string }> = [];
  for (const log of rawLogs) {
    try {
      logs.push(decodeLog(spec, log));
    } catch (err) {
      decodeErrors.push({
        tx_hash: log.transactionHash,
        log_index: log.logIndex,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Best-effort tip read so the caller can compute "how far behind my
  // to_block is". A failure here doesn't fail the call.
  let asOfBlockNumber: number = to_block;
  try {
    const tipHex = await ethBlockNumber(env);
    asOfBlockNumber = Number(BigInt(tipHex));
  } catch {
    // Fall through: caller still gets the logs.
  }

  return new Response(
    JSON.stringify({
      event,
      contract: normalizeAddress(targetContract),
      from_block,
      to_block,
      logs,
      decode_errors: decodeErrors,
      as_of_block_number: asOfBlockNumber,
    }),
    { headers: JSON_HEADERS },
  );
}

/** Decode one log against the event spec. Throws on shape mismatch. */
function decodeLog(spec: EventSpec, log: RpcLog): unknown {
  // log.topics[0] is the event selector — already filtered upstream. The
  // remaining topics map 1:1 to the indexed parameters in declaration order.
  const indexedTopics = log.topics.slice(1);
  if (indexedTopics.length !== spec.indexedTypes.length) {
    throw new Error(
      `expected ${spec.indexedTypes.length} indexed topics for ${spec.signature}, ` +
        `got ${indexedTopics.length}`,
    );
  }

  const decoded: Record<string, string | number | boolean> = {};

  for (let i = 0; i < spec.indexedTypes.length; i++) {
    decoded[spec.indexedNames[i]] = serializeValue(
      decodeIndexedTopic(spec.indexedTypes[i], indexedTopics[i]),
    );
  }

  if (spec.dataTypes.length > 0) {
    const dataValues = decodeReturn(log.data, spec.dataTypes);
    for (let i = 0; i < spec.dataTypes.length; i++) {
      decoded[spec.dataNames[i]] = serializeValue(dataValues[i]);
    }
  }

  return {
    block_number: Number(BigInt(log.blockNumber)),
    tx_hash: log.transactionHash,
    log_index: Number(BigInt(log.logIndex)),
    decoded,
  };
}

// -----------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------

/** Returns the SignatureSpec map appropriate for the given contract, or null. */
function pickAllowlist(contract: string, env: Env): Record<string, SignatureSpec> | null {
  const lc = normalizeAddress(contract);
  if (env.SETTLEMENT_ROUTER_ADDRESS && lc === normalizeAddress(env.SETTLEMENT_ROUTER_ADDRESS)) {
    return ROUTER_SIGNATURES;
  }
  if (env.USDC_TOKEN_ADDRESS && lc === normalizeAddress(env.USDC_TOKEN_ADDRESS)) {
    return ERC20_SIGNATURES;
  }
  return null;
}

function serializeValue(value: unknown): string | number | boolean {
  // BigInts can't be JSON.stringify'd; convert to string. Booleans / numbers
  // / strings pass through unchanged.
  if (typeof value === "bigint") return value.toString();
  return value as string | number | boolean;
}

/** Convert a uint256 to a decimal string with `decimals` fractional digits. */
function formatUnits(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return `${whole}.${"0".repeat(decimals)}`;
  const fracStr = frac.toString().padStart(decimals, "0");
  return `${whole}.${fracStr}`;
}

function jsonError(status: number, code: string, detail: string): Response {
  return new Response(JSON.stringify({ error: code, detail }), {
    status,
    headers: JSON_HEADERS,
  });
}

function mapRpcError(err: unknown): Response {
  if (err instanceof BaseRpcError) {
    return jsonError(err.status, err.kind, err.message);
  }
  console.error("[base] unexpected error:", err);
  return jsonError(500, "internal_error", "unexpected handler error");
}
