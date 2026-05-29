// Revert-reason classifier for the receipt-poll path (§4 exit b).
//
// Without this, every reverted settle() lands as the generic "Transaction
// reverted on-chain" — operator-tested in the 2026-05-28 Item 33 live trial
// and recorded there as a polish item (Item 35). Two causes account for the
// vast majority of real-world reverts seen so far:
//
//   1. EnforcedPause — settle() called while the SettlementRouter is paused
//      (operator-initiated, e.g. during an incident or upgrade window).
//   2. ERC20 allowance shortfall — settle() called with allowance < amount,
//      usually because a previous approve was used by an earlier settle and
//      the user retried without re-approving.
//
// Rather than parse the receipt's revert data (which would require knowing
// every selector the SettlementRouter could throw + USDC + miscellaneous),
// we pre-check the two state predicates that would have caused the revert
// and pick the most specific matching reason. The check happens *after* the
// revert is already observed, so it's not racy: paused() / allowance() at
// "now" are a strict superset of what was true at the failed tx — if the
// state shifted (e.g. the operator unpaused after our revert), we fall back
// to the generic message, which is correct (the situation has changed).
//
// Split into a pure classifier + an I/O wrapper so the rule table is
// unit-testable without mocking viem's PublicClient. New causes can be
// added by extending the input shape and the switch in classifyRevertReason.

import type { Address, PublicClient } from "viem";
import { ERC20_ABI, SETTLEMENT_ROUTER_ABI } from "./contract";

/**
 * Inputs the rule table needs. Each field reflects on-chain state observed
 * AFTER the revert detection, so a `paused = true` here means "the contract
 * is paused now," which the call to settle() therefore would have failed
 * against (it's monotonic across the post-revert window from the user's
 * perspective).
 *
 * `amount` is the settle() input that was attempted, taken from the
 * PendingEntry. `allowance` is the user's *current* allowance to the
 * router (USDC.allowance(wallet, router)).
 */
export interface RevertContext {
  paused: boolean;
  allowance: bigint;
  amount: bigint;
}

/**
 * Pure classification — given the on-chain state observed at revert time,
 * pick the most specific user-actionable reason. Order matters: paused
 * blocks everything, so check it first. Allowance is the most common
 * non-paused cause. Everything else is "generic revert" — the user sees
 * a tx link and can investigate themselves.
 */
export function classifyRevertReason(ctx: RevertContext): string {
  if (ctx.paused) {
    return "Settlement contract is paused — try again once the treasury reopens it.";
  }
  if (ctx.allowance < ctx.amount) {
    return "Allowance insufficient — re-approve and retry.";
  }
  return "Transaction reverted on-chain.";
}

/**
 * I/O wrapper: reads the two predicates from chain and runs the classifier.
 * If any read fails (RPC hiccup, contract addresses not configured at the
 * moment of revert), we fall back to the generic message — surfacing an
 * RPC error here would be worse UX than the original.
 */
export async function classifyRevertOnChain(
  publicClient: PublicClient,
  params: {
    router: Address;
    usdc: Address;
    wallet: Address;
    amount: bigint;
  },
): Promise<string> {
  try {
    const [paused, allowance] = await Promise.all([
      publicClient.readContract({
        address: params.router,
        abi: SETTLEMENT_ROUTER_ABI,
        functionName: "paused",
      }) as Promise<boolean>,
      publicClient.readContract({
        address: params.usdc,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [params.wallet, params.router],
      }) as Promise<bigint>,
    ]);
    return classifyRevertReason({ paused, allowance, amount: params.amount });
  } catch {
    return "Transaction reverted on-chain.";
  }
}
