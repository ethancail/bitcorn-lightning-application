// The settlement form's pre-flight guard chain, as a pure function.
//
// Pure + dependency-light so it unit-tests without a DOM or a React renderer —
// same pattern as feePreview.ts / settlementAmounts.ts / railAccess.ts (and
// app/web/vitest.config.ts only collects `*.test.ts`, not `.tsx`).
//
// ─── WHY THE CHAIN LIVES HERE AND NOT INLINE IN THE COMPONENT ─────────────
//
// These checks were seven sequential `if` blocks inside handleSubmit. They are
// all pure decisions over primitive inputs, and they are the last thing standing
// between a user and a signed transaction — so they are worth testing directly.
// Extracting them verbatim (same order, same messages) also makes the ORDER
// itself assertable, which matters now that entitlement is in the chain and has
// to outrank the connect-a-wallet message.
//
// ─── ⚠ THIS IS A PRODUCT GATE, NOT A SECURITY BOUNDARY ────────────────────
//
// The entitlement check below is client-side, and that is the CORRECT level for
// it. Its bypassability is not a weakness to be fixed.
//
// SettlementRouter is a public, non-custodial contract. A lapsed member can call
// `settle()` directly from their own wallet, from Etherscan, from a script —
// with or without this check, with or without Bitcorn running at all. The app
// already tells them so in as many words (RailErrorBanner.tsx:45-48: "Your
// wallet can still interact with the SettlementRouter contract on Base
// directly"). Their USDC is theirs and Bitcorn was never in the path.
//
// What we are withholding is a PRODUCT SURFACE — the Bitcorn UI that composes
// the approve/settle flow, previews the fee, tracks the pending row, and renders
// the history. That is the thing a subscription pays for, and a client-side
// check withholds exactly it.
//
// So do NOT "harden" this into a server-side block. There is nothing on the
// server to block: sending goes wallet → BASE directly and never traverses the
// API or the Worker. A server-side gate here would achieve nothing while
// implying it achieves something — the worst combination, because the next
// reader would trust it. The Worker's full-scope gate on /base/* is a real
// boundary because those are OUR reads of OUR RPC budget. This is not that, and
// it should not pretend to be.

import type { SubscriptionStatus } from "../api/client";
import { isRailGated } from "./railAccess";
import { parseUsdcAmount } from "./contract";

/**
 * On success the guard hands back every value it validated, already narrowed.
 * The caller therefore never re-parses and never re-narrows — which is what
 * keeps a silent `if (!x) return` out of the component, and keeps the derivation
 * of recipient/amount in exactly one place.
 */
export type SubmitGuardResult =
  | {
      ok: true;
      recipientAddress: `0x${string}`;
      amountUnits: bigint;
      usdcAddress: `0x${string}`;
      routerAddress: `0x${string}`;
      walletAddress: `0x${string}`;
    }
  | { ok: false; message: string };

export function isAddressLike(s: string): s is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

export interface SubmitGuardInput {
  /**
   * Member's subscription status. Passed as the status rather than a
   * pre-computed boolean so the tier→entitlement decision goes through the one
   * tested path (railAccess.isRailGated) and no caller can mis-derive it.
   *
   * `null` / not-applicable FAILS OPEN, matching railAccess: the status hook
   * starts null and polls at 60s, and blocking a paying member's send for the
   * first minute after page load would be a far worse failure than briefly
   * showing a form to a lapsed one.
   */
  subscriptionStatus: SubscriptionStatus | null;
  walletAddress: string | undefined;
  usdcAddress: string | undefined;
  routerAddress: string | undefined;
  isPaused: boolean;
  recipient: string;
  amount: string;
  /** Whether wagmi handed us a usable public client for the settlement chain. */
  hasPublicClient: boolean;
  /** Only for the USDC-misconfiguration message. */
  chainId: number;
}

/**
 * Runs the ordered pre-flight chain. Returns the derived recipient + amount on
 * success so the caller does not re-parse them (one source of truth), or the
 * first failing check's user-facing message.
 *
 * ORDER IS LOAD-BEARING and matches the original inline chain, with entitlement
 * inserted at the top:
 *   0. entitlement   ← new
 *   1. wallet connected
 *   2. USDC address configured for the chain
 *   3. router address known (contract state cached)
 *   4. contract not paused
 *   5. recipient parses as an address
 *   6. amount parses and is positive
 *   7. public client available
 *
 * Entitlement outranks "connect a wallet" deliberately: for a lapsed member with
 * no wallet connected, the subscription is both the more fundamental blocker and
 * the more actionable one. Telling them to connect a wallet would send them down
 * a path that ends in this same refusal.
 *
 * Every caller must run this BEFORE touching the wallet. In SettlementForm the
 * first wallet interaction is `switchChainAsync`, and this call sits above it —
 * so no rejected pre-flight can ever produce a wallet prompt.
 */
export function validateSettlementSubmit(input: SubmitGuardInput): SubmitGuardResult {
  if (isRailGated(input.subscriptionStatus)) {
    return {
      ok: false,
      message:
        "Stablecoin settlements need an active membership. " +
        "Renew your subscription in Settings to send.",
    };
  }
  if (!input.walletAddress) {
    return { ok: false, message: "Connect a wallet first." };
  }
  if (!input.usdcAddress) {
    return {
      ok: false,
      message: `USDC address not configured for chain ${input.chainId}.`,
    };
  }
  if (!input.routerAddress) {
    return {
      ok: false,
      message: "Contract state not loaded yet; try again in a moment.",
    };
  }
  if (input.isPaused) {
    return { ok: false, message: "Settlements are paused. Try again later." };
  }
  const recipientTrimmed = input.recipient.trim();
  if (!isAddressLike(recipientTrimmed)) {
    return { ok: false, message: "Recipient must be a 0x address." };
  }
  const amountUnits = parseUsdcAmount(input.amount);
  if (amountUnits === null || amountUnits === 0n) {
    return {
      ok: false,
      message: "Amount must be a positive USDC value (up to 6 decimals).",
    };
  }
  if (!input.hasPublicClient) {
    return { ok: false, message: "Wallet RPC not available; try refreshing." };
  }
  return {
    ok: true,
    recipientAddress: recipientTrimmed.toLowerCase() as `0x${string}`,
    amountUnits,
    usdcAddress: input.usdcAddress as `0x${string}`,
    routerAddress: input.routerAddress as `0x${string}`,
    walletAddress: input.walletAddress as `0x${string}`,
  };
}
