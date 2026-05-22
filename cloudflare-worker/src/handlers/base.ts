// Bitcorn Lightning — Cloudflare Worker BASE proxy handlers.
//
// Three endpoints surface BASE-side state to the API container while keeping
// the upstream RPC API key secret-side. Authorization mirrors the existing
// three-category Worker model (public / subscriber-base / tier-gated) per
// spec §5.2.
//
//   GET  /base/contract-info   — public; static config + live feeBps/paused
//   POST /base/contract-state  — subscriber-base; generic ABI-call wrapper
//   GET  /base/balance         — subscriber-base; convenience for balanceOf
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §5
// Contract: bitcorn-stablecoin-rail repo, deployed to 0xF1Bc89... on Base Sepolia

import { CORS_HEADERS } from "../lib/cors";
import { ethCall, ethBlockNumber, BaseRpcError } from "../lib/baseRpc";
import {
  AbiType,
  decodeReturn,
  encodeCallData,
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
