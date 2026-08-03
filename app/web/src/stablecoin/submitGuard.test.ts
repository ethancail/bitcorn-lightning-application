// Coverage for the settlement form's pre-flight chain, especially the
// subscription entitlement guard.
//
// THE TRAP, same shape as the Worker scope change: a fixture at tier `current`
// passes whether or not the entitlement guard exists. Every discriminating case
// below names a NON-CURRENT tier explicitly, and the guard is driven by a real
// SubscriptionStatus rather than a pre-computed boolean — so each test exercises
// tier → railAccess.isRailGated → refusal end to end, not one abstraction away
// from the tier.
//
// WHAT THESE TESTS DO NOT COVER: that SettlementForm actually calls this
// validator. There is no @testing-library/react in this package, so the
// component cannot be rendered in a test. The coupling rests on tsc plus the
// fact that handleSubmit has exactly one call site above the first wallet
// interaction. Verified by reading, not by test.

import { describe, expect, it } from "vitest";
import { validateSettlementSubmit, type SubmitGuardInput } from "./submitGuard";
import type {
  SubscriptionStatus,
  SubscriptionTier,
  SubscriptionNotApplicableReason,
} from "../api/client";

function status(tier: SubscriptionTier, over: Record<string, unknown> = {}): SubscriptionStatus {
  return {
    applicable: true,
    member_pubkey: "02".padEnd(66, "a"),
    current_tier: tier,
    paid_through: 1_700_000_000_000,
    price_sats: 50_000,
    period_days: 30,
    deposit_address: "bc1qexampleexampleexample",
    last_payment_at: 1_699_000_000_000,
    last_payment_txid: "a".repeat(64),
    grace: {
      fresh_until: 1_700_000_000_000,
      worker_until: 1_700_000_000_000,
      routing_until: 1_700_000_000_000,
      close_at: 1_700_000_000_000,
    },
    ...over,
  } as SubscriptionStatus;
}

const ROUTER = ("0x" + "1".repeat(40)) as `0x${string}`;
const USDC = ("0x" + "2".repeat(40)) as `0x${string}`;
const RECIPIENT = "0x" + "3".repeat(40);

/** A fully valid submit, entitled. Individual tests spoil one field at a time. */
function validInput(over: Partial<SubmitGuardInput> = {}): SubmitGuardInput {
  return {
    subscriptionStatus: status("current"),
    walletAddress: "0x" + "4".repeat(40),
    usdcAddress: USDC,
    routerAddress: ROUTER,
    isPaused: false,
    recipient: RECIPIENT,
    amount: "45000.00",
    hasPublicClient: true,
    chainId: 8453,
    ...over,
  };
}

const GATED_TIERS: SubscriptionTier[] = [
  "prepay",
  "worker_lapsed",
  "routing_lapsed",
  "close_due",
];

describe("validateSettlementSubmit — the entitlement guard", () => {
  it("permits an otherwise-valid submit at tier current", () => {
    // The control. If this ever fails, the tier tests below prove nothing.
    const result = validateSettlementSubmit(validInput());
    expect(result.ok).toBe(true);
  });

  it.each(GATED_TIERS)("BLOCKS submission at tier %s", (tier) => {
    // Everything else about this submit is valid — wallet connected, router
    // cached, amount and recipient fine. The ONLY reason it is refused is the
    // tier. That isolation is what makes this discriminating.
    const result = validateSettlementSubmit(
      validInput({ subscriptionStatus: status(tier) }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/active membership/i);
    expect(result.message).toMatch(/Settings/);
  });

  it.each(GATED_TIERS)("returns no derived values at tier %s", (tier) => {
    // A blocked result must not hand back a recipient or amount that a careless
    // caller could destructure and use anyway.
    const result = validateSettlementSubmit(
      validInput({ subscriptionStatus: status(tier) }),
    );
    expect(result).not.toHaveProperty("recipientAddress");
    expect(result).not.toHaveProperty("amountUnits");
    expect(result).not.toHaveProperty("routerAddress");
  });

  it("PERMITS a fresh-grace member who has never paid", () => {
    // Trial access is a deliberate property, not an accident of reusing
    // isRailGated. A never-paid node inside its 30-day grace_days_fresh window
    // (migration 042) computes to tier `current` and keeps the rail — including
    // the ability to SEND, which is the revenue-generating action (25 bps at
    // launch). This test fails loudly if someone later tightens the gate.
    const freshGrace = status("current", {
      last_payment_txid: null,
      last_payment_at: null,
    });
    const result = validateSettlementSubmit(
      validInput({ subscriptionStatus: freshGrace }),
    );
    expect(result.ok).toBe(true);
  });

  it("FAILS OPEN while the status is still null", () => {
    // useSubscriptionStatus starts null and polls at 60s. Blocking here would
    // refuse a paying member's send for up to a minute after every page load —
    // a far worse failure than briefly permitting a lapsed one, given this is a
    // product gate and not a funds boundary.
    const result = validateSettlementSubmit(
      validInput({ subscriptionStatus: null }),
    );
    expect(result.ok).toBe(true);
  });

  it.each<SubscriptionNotApplicableReason>([
    "external_peer",
    "unclassified",
    "not_yet_allocated",
    "missing",
    "no_channel",
  ])("FAILS OPEN for applicable:false / %s", (reason) => {
    const result = validateSettlementSubmit(
      validInput({
        subscriptionStatus: { applicable: false, reason } as SubscriptionStatus,
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateSettlementSubmit — guard ORDER", () => {
  it.each(GATED_TIERS)(
    "at tier %s with NO wallet connected, the entitlement message wins",
    (tier) => {
      // Priority requirement: the subscription is both the more fundamental
      // blocker and the more actionable one. Telling a lapsed member to connect
      // a wallet would send them down a path ending in this same refusal.
      const result = validateSettlementSubmit(
        validInput({ subscriptionStatus: status(tier), walletAddress: undefined }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.message).toMatch(/active membership/i);
      expect(result.message).not.toMatch(/Connect a wallet/i);
    },
  );

  it("at tier prepay with EVERY other field also invalid, entitlement still wins", () => {
    // Entitlement is first in the chain, so it must outrank all seven original
    // guards simultaneously — not just the wallet one.
    const result = validateSettlementSubmit({
      subscriptionStatus: status("prepay"),
      walletAddress: undefined,
      usdcAddress: undefined,
      routerAddress: undefined,
      isPaused: true,
      recipient: "not-an-address",
      amount: "0",
      hasPublicClient: false,
      chainId: 8453,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/active membership/i);
  });

  it("an ENTITLED member still gets the original guards, in the original order", () => {
    // The entitlement check must not have displaced or short-circuited the
    // existing chain. Walks it top to bottom, spoiling one field at a time.
    const entitled = status("current");
    const cases: Array<[Partial<SubmitGuardInput>, RegExp]> = [
      [{ walletAddress: undefined }, /Connect a wallet first/],
      [{ usdcAddress: undefined }, /USDC address not configured for chain 8453/],
      [{ routerAddress: undefined }, /Contract state not loaded yet/],
      [{ isPaused: true }, /Settlements are paused/],
      [{ recipient: "nope" }, /Recipient must be a 0x address/],
      [{ amount: "0" }, /Amount must be a positive USDC value/],
      [{ amount: "abc" }, /Amount must be a positive USDC value/],
      [{ hasPublicClient: false }, /Wallet RPC not available/],
    ];
    for (const [spoil, expected] of cases) {
      const result = validateSettlementSubmit(
        validInput({ subscriptionStatus: entitled, ...spoil }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.message).toMatch(expected);
    }
  });
});

describe("validateSettlementSubmit — derived values on success", () => {
  it("lowercases the recipient and returns parsed base units", () => {
    const result = validateSettlementSubmit(
      validInput({ recipient: "0x" + "AB".repeat(20), amount: "45000.00" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.recipientAddress).toBe("0x" + "ab".repeat(20));
    expect(result.amountUnits).toBe(45_000_000_000n);
  });

  it("trims surrounding whitespace from the recipient", () => {
    const result = validateSettlementSubmit(
      validInput({ recipient: `  ${RECIPIENT}  ` }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.recipientAddress).toBe(RECIPIENT);
  });

  it("passes through the validated usdc and router addresses", () => {
    // Returned so the component neither re-narrows nor re-derives them — the
    // reason there is no second `if (!x) return` in handleSubmit.
    const result = validateSettlementSubmit(validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.usdcAddress).toBe(USDC);
    expect(result.routerAddress).toBe(ROUTER);
  });

  it("accepts a sub-cent amount at full 6dp precision", () => {
    const result = validateSettlementSubmit(validInput({ amount: "0.000001" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.amountUnits).toBe(1n);
  });
});
