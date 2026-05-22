// Typed helper for forwarding JSON-RPC calls to the upstream BASE RPC.
//
// The Worker holds BASE_SEPOLIA_RPC_URL as a secret (URL may include an
// embedded API key — Alchemy's standard pattern). Callers in handlers/base.ts
// invoke `ethCall` / `ethBlockNumber` etc. rather than hand-building JSON-RPC
// bodies, so the upstream's auth and error shape stay isolated to this module.
//
// Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §5

import type { Env } from "./types";

export interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export class BaseRpcError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "unconfigured"
      | "upstream_http_error"
      | "upstream_json_rpc_error"
      | "upstream_unreachable"
      | "malformed_response",
    public readonly status: number,
    public readonly upstreamCode?: number,
  ) {
    super(message);
    this.name = "BaseRpcError";
  }
}

let nextId = 1;

async function callRpc<T>(env: Env, method: string, params: unknown[]): Promise<T> {
  const rpcUrl = env.BASE_SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    throw new BaseRpcError(
      "BASE_SEPOLIA_RPC_URL is not configured on this Worker",
      "unconfigured",
      503,
    );
  }

  const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });

  let res: Response;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (err) {
    throw new BaseRpcError(
      `upstream BASE RPC unreachable: ${err instanceof Error ? err.message : String(err)}`,
      "upstream_unreachable",
      502,
    );
  }

  if (!res.ok) {
    // Non-2xx from the RPC provider itself (rate limit, auth failure, etc.).
    const text = await res.text().catch(() => "");
    throw new BaseRpcError(
      `upstream BASE RPC HTTP ${res.status}: ${text.slice(0, 200)}`,
      "upstream_http_error",
      502,
    );
  }

  let parsed: JsonRpcResponse<T>;
  try {
    parsed = (await res.json()) as JsonRpcResponse<T>;
  } catch {
    throw new BaseRpcError("upstream BASE RPC returned non-JSON body", "malformed_response", 502);
  }

  if (parsed.error) {
    throw new BaseRpcError(
      `upstream BASE RPC error: ${parsed.error.message}`,
      "upstream_json_rpc_error",
      502,
      parsed.error.code,
    );
  }

  if (parsed.result === undefined) {
    throw new BaseRpcError("upstream BASE RPC response missing result", "malformed_response", 502);
  }

  return parsed.result;
}

// -----------------------------------------------------------------------
// Named wrappers
// -----------------------------------------------------------------------

/**
 * eth_call against the given target contract with hex-encoded calldata.
 * Returns the raw return hex (caller decodes with `decodeReturn` from abi.ts).
 */
export async function ethCall(
  env: Env,
  to: string,
  data: string,
  blockTag: string = "latest",
): Promise<string> {
  return callRpc<string>(env, "eth_call", [{ to, data }, blockTag]);
}

/** eth_blockNumber — returns the latest block as a 0x-prefixed hex string. */
export async function ethBlockNumber(env: Env): Promise<string> {
  return callRpc<string>(env, "eth_blockNumber", []);
}

/** eth_chainId — used by the contract-info handler to surface the configured chain. */
export async function ethChainId(env: Env): Promise<string> {
  return callRpc<string>(env, "eth_chainId", []);
}
