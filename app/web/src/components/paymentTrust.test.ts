// S1–S6, pure (bitcorn-research specs/2026-11-10-treasury-price-trust-spec.md
// §8). The copy is the spec's DRAFT, pinned here so a change to it is a
// deliberate edit seen at review — it is approved at the screenshot gate (G3),
// after the drive-mode chat's review (ruling 5).

import { describe, expect, it } from "vitest";
import {
  autoPayCanEnable,
  shortAddress,
  trustCopy,
  trustStateOfAutoPayConfig,
  trustStateOfRefusal,
  trustStateOfStatus,
} from "./paymentTrust";
import { payErrorMessage } from "./subscriptionPayMessages";
import { autoPayAlertContent } from "./subscriptionBanner";

const S = {
  S1: "Payments are paused. Your node can't confirm this price came from Bitcorn, so it won't pay it. Nothing has been sent. If this doesn't clear, contact Bitcorn.",
  S2: "Payments are blocked. The subscription details your node received failed a security check. Nothing has been sent. Don't pay from another wallet. Contact Bitcorn.",
  S3k: "Payments are paused. Your app needs an update before it can pay. Update Bitcorn Lightning in the Umbrel App Store.",
  S3l: "Your node's Lightning service isn't responding, so payments are paused. It usually comes back within a few minutes; if it's still down in an hour, restart the Lightning app, then restart Bitcorn Lightning.",
  S4: (p: string) =>
    `Payments are paused. The subscription price, ${p}, is above the limit built into this app. Nothing has been sent. Contact Bitcorn.`,
  S5: "Payments are paused. The price your node received doesn't look right, so it won't pay it. Nothing has been sent. Contact Bitcorn.",
  S6: (a: string, b: string) =>
    `Your subscription payment address has changed, from ${a} to ${b}. Your node won't send to a new address until you confirm it on the node itself. Nothing has been sent. Don't pay until you've checked with Bitcorn, from this node or any other wallet. Contact Bitcorn and we'll help you confirm the new address.`,
};
const PINNED = "bc1qpinnedaddress000000000000aaaa";
const STATED = "bc1qstatedaddress000000000000bbbb";

describe("the draft copy, verbatim", () => {
  it("S1–S6", () => {
    expect(trustCopy({ state: "S1_unsigned" }).text).toBe(S.S1);
    expect(trustCopy({ state: "S2_invalid" }).text).toBe(S.S2);
    expect(trustCopy({ state: "S3_unverifiable", reason: "key_unset" }).text).toBe(S.S3k);
    expect(trustCopy({ state: "S3_unverifiable", reason: "lnd_unavailable" }).text).toBe(S.S3l);
    expect(trustCopy({ state: "S4_price_above_cap", price_sats: 1 }, "$9.99 (1 sats)").text).toBe(S.S4("$9.99 (1 sats)"));
    expect(trustCopy({ state: "S5_price_not_integer" }).text).toBe(S.S5);
    expect(trustCopy({ state: "S6_deposit_address_changed", pinned: PINNED, stated: STATED }).text).toBe(
      S.S6(shortAddress(PINNED), shortAddress(STATED)),
    );
  });

  it("headline is the first sentence and body the rest, so the alert surfaces carry the same words", () => {
    const c = trustCopy({ state: "S2_invalid" });
    expect(`${c.headline} ${c.body}`).toBe(c.text);
    expect(c.headline).toBe("Payments are blocked.");
  });
});

describe("which state a status is in", () => {
  const base = { applicable: true } as any;
  it("verified and payable → no state (the anti-vacuity case for every row below)", () => {
    expect(trustStateOfStatus({ ...base, treasury_signature: "verified", treasury_pay_refusal: null })).toBeNull();
  });
  it("every label but verified, and a MISSING label, is a state", () => {
    expect(trustStateOfStatus({ ...base, treasury_signature: "unsigned" })).toEqual({ state: "S1_unsigned" });
    expect(trustStateOfStatus({ ...base })).toEqual({ state: "S1_unsigned" });
    expect(trustStateOfStatus({ ...base, treasury_signature: "invalid" })).toEqual({ state: "S2_invalid" });
    expect(trustStateOfStatus({ ...base, treasury_signature: "unverifiable", treasury_signature_reason: "key_unset" })).toEqual({
      state: "S3_unverifiable",
      reason: "key_unset",
    });
  });
  it("a verified status naming a target this node won't pay → S4, S5, S6", () => {
    const v = { ...base, treasury_signature: "verified" };
    expect(trustStateOfStatus({ ...v, treasury_pay_refusal: { code: "price_above_cap", detail: "", price_sats: 9 } })).toEqual({
      state: "S4_price_above_cap",
      price_sats: 9,
    });
    expect(trustStateOfStatus({ ...v, treasury_pay_refusal: { code: "price_not_integer", detail: "", price_sats: 1.5 } })).toEqual({
      state: "S5_price_not_integer",
    });
    expect(
      trustStateOfStatus({
        ...v,
        treasury_pay_refusal: { code: "deposit_address_changed", detail: "", pinned_address: PINNED, stated_address: STATED },
      }),
    ).toEqual({ state: "S6_deposit_address_changed", pinned: PINNED, stated: STATED });
  });
});

describe("the API's refusals → S1–S6 (quote and send)", () => {
  it("maps each refusal; any other code is not a trust state", () => {
    expect(trustStateOfRefusal("status_unverified", { reason: "unsigned" })).toEqual({ state: "S1_unsigned" });
    expect(trustStateOfRefusal("status_unverified", { reason: "unverifiable", verification_reason: "lnd_unavailable" })).toEqual({
      state: "S3_unverifiable",
      reason: "lnd_unavailable",
    });
    expect(trustStateOfRefusal("deposit_address_changed", { pinned_address: PINNED, stated_address: STATED })).toMatchObject({
      state: "S6_deposit_address_changed",
    });
    expect(trustStateOfRefusal("insufficient_funds", {})).toBeNull();
  });

  it("payErrorMessage uses the S copy for them, and keeps today's copy otherwise", () => {
    expect(payErrorMessage("status_unverified", "x", { reason: "invalid" })).toBe(S.S2);
    expect(payErrorMessage("price_above_cap", "x", { price_sats: 70_000 })).toBe(S.S4("70,000 sats"));
    expect(payErrorMessage("price_not_integer", "x", {})).toBe(S.S5);
    expect(payErrorMessage("insufficient_funds")).toMatch(/^Not enough on-chain balance/);
  });
});

describe("auto-pay: the alert copy, the section's state, the opt-in", () => {
  it("AUTOPAY_STATUS_UNVERIFIED and AUTOPAY_PAY_TARGET_REFUSED read their context", () => {
    expect(autoPayAlertContent("AUTOPAY_STATUS_UNVERIFIED", { verdict: "unsigned" })).toEqual({
      headline: "Payments are paused.",
      body: "Your node can't confirm this price came from Bitcorn, so it won't pay it. Nothing has been sent. If this doesn't clear, contact Bitcorn.",
    });
    expect(
      autoPayAlertContent("AUTOPAY_PAY_TARGET_REFUSED", { reason: "deposit_address_changed", pinned_address: PINNED, stated_address: STATED }),
    ).toEqual({
      headline: `Your subscription payment address has changed, from ${shortAddress(PINNED)} to ${shortAddress(STATED)}.`,
      body: "Your node won't send to a new address until you confirm it on the node itself. Nothing has been sent. Don't pay until you've checked with Bitcorn, from this node or any other wallet. Contact Bitcorn and we'll help you confirm the new address.",
    });
  });

  it("opting in needs a verified, payable status; the treasury unread is no claim", () => {
    const cfg = (o: Record<string, unknown>) => ({ enabled: false, ...o }) as any;
    expect(autoPayCanEnable(cfg({ status_verification: "verified", price_refusal: null }))).toBe(true);
    expect(autoPayCanEnable(cfg({ status_verification: "unsigned" }))).toBe(false);
    expect(autoPayCanEnable(cfg({ status_verification: "verified", price_refusal: { code: "price_above_cap", price_sats: 9 } }))).toBe(false);
    expect(autoPayCanEnable(cfg({ status_verification: null }))).toBe(false);
    expect(trustStateOfAutoPayConfig(cfg({ status_verification: null }))).toBeNull();
    expect(trustStateOfAutoPayConfig(cfg({ status_verification: "invalid" }))).toEqual({ state: "S2_invalid" });
  });
});
