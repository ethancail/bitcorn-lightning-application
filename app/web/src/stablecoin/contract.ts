// SettlementRouter + USDC contract bindings shared by the rail's components.
//
// The SettlementRouter address is read at runtime from
// /api/stablecoin/contract-state (the sync loop's cache); the USDC address
// is chain-static (Circle's published deployments) so we hardcode by chain.
//
// USDC reference: spec §0 T6 — Circle's native deployments on each BASE
// chain. Sepolia: testnet USDC, mainnet: native USDC (not bridged).
//
// ABIs are kept minimal — only the functions actually called from the
// frontend. Going via viem's parseAbi keeps these tree-shakable and type-safe.

import { parseAbi } from "viem";

export const USDC_DECIMALS = 6;

/**
 * USDC contract addresses keyed by chain ID. Verify against Circle's
 * current published list (spec §0 T6) if a new deployment surfaces.
 */
export const USDC_ADDRESS_BY_CHAIN: Record<number, `0x${string}`> = {
  // Base Sepolia (84532) — Circle's testnet USDC
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  // Base Mainnet (8453) — Coinbase-issued native USDC (NOT the bridged variant)
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

/**
 * Minimal IERC20 ABI — only the read+write functions the rail calls
 * directly. balanceOf is informational (the backend has a cached balance
 * via /balance); approve + allowance support the two-step approve→settle
 * flow.
 */
export const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

/**
 * Minimal SettlementRouter ABI — `settle(...)` for writes, `paused()` for
 * the post-revert reason classifier (revertClassifier.ts). Steady-state
 * reads (feeBps, paused, feeRecipient) all go through the API container's
 * cache via /api/stablecoin/contract-state; the only reason to read
 * `paused()` directly is to attribute a *just-observed* revert at the
 * moment the receipt-poll detects it, where freshness matters and the
 * cache could lag by up to one sync tick.
 */
export const SETTLEMENT_ROUTER_ABI = parseAbi([
  "function settle(address recipient, uint256 amount, bytes32 tradeRef) external",
  "function paused() view returns (bool)",
]);

/**
 * Convert a human "100.00" style USDC amount to 6-decimal units. Returns
 * null if the input doesn't parse cleanly (caller surfaces the error).
 */
export function parseUsdcAmount(human: string): bigint | null {
  const trimmed = human.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const padded = (frac + "000000").slice(0, USDC_DECIMALS);
  try {
    return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(padded || "0");
  } catch {
    return null;
  }
}

export function formatUsdc(units: bigint): string {
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = units / divisor;
  const frac = units % divisor;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").slice(0, 2);
  return `${whole.toString()}.${fracStr}`;
}

export function basescanTxUrl(chainId: number, txHash: string): string {
  const base = chainId === 8453
    ? "https://basescan.org"
    : "https://sepolia.basescan.org";
  return `${base}/tx/${txHash}`;
}

export function basescanBlockUrl(chainId: number, blockNumber: number | bigint): string {
  const base = chainId === 8453
    ? "https://basescan.org"
    : "https://sepolia.basescan.org";
  return `${base}/block/${blockNumber}`;
}

export function basescanAddressUrl(chainId: number, address: string): string {
  const base = chainId === 8453
    ? "https://basescan.org"
    : "https://sepolia.basescan.org";
  return `${base}/address/${address}`;
}
