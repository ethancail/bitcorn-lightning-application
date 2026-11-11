// payBlocked's truth table (treasury-price-trust; exported for drive-mode R45).
//
// Every trust state blocks; both labels absent blocks — the behaviour this
// branch already had at its call site (a missing label is not verified); and
// the anti-vacuity rows: a verified status with no refusal is NOT blocked.
// Each status row also asserts equality with the expression the panel used
// before payBlocked existed (`trustStateOfStatus(status) != null`), so moving
// the call site onto it changed no behaviour.

import { describe, expect, it } from "vitest";
import { payBlocked, trustStateOfStatus } from "./paymentTrust";

const refusal = {
  above_cap: { code: "price_above_cap", detail: "", price_sats: 90_000 },
  not_integer: { code: "price_not_integer", detail: "", price_sats: 1.5 },
  changed: { code: "deposit_address_changed", detail: "", pinned_address: "bc1qa", stated_address: "bc1qb" },
} as const;

const rows: Array<[string, Record<string, unknown>, boolean]> = [
  // ── anti-vacuity: NOT blocked ──
  ["verified, refusal null", { treasury_signature: "verified", treasury_pay_refusal: null }, false],
  ["verified, refusal absent", { treasury_signature: "verified" }, false],
  // ── S1–S3: the verdict ──
  ["S1 unsigned", { treasury_signature: "unsigned", treasury_pay_refusal: null }, true],
  ["S2 invalid", { treasury_signature: "invalid", treasury_pay_refusal: null }, true],
  ["S3 unverifiable (key_unset)", { treasury_signature: "unverifiable", treasury_signature_reason: "key_unset" }, true],
  ["S3 unverifiable (lnd_unavailable)", { treasury_signature: "unverifiable", treasury_signature_reason: "lnd_unavailable" }, true],
  ["an unknown verdict string", { treasury_signature: "verified-ish" }, true],
  // ── S4–S6: verified, but a refusal ──
  ["S4 price_above_cap", { treasury_signature: "verified", treasury_pay_refusal: refusal.above_cap }, true],
  ["S5 price_not_integer", { treasury_signature: "verified", treasury_pay_refusal: refusal.not_integer }, true],
  ["S6 deposit_address_changed", { treasury_signature: "verified", treasury_pay_refusal: refusal.changed }, true],
  // ── labels absent ──
  ["both labels absent (today's behaviour: blocked)", {}, true],
  ["signature absent, refusal null", { treasury_pay_refusal: null }, true],
  ["signature absent, a refusal present", { treasury_pay_refusal: refusal.changed }, true],
  ["unverified AND refused", { treasury_signature: "unsigned", treasury_pay_refusal: refusal.above_cap }, true],
];

describe("payBlocked — the truth table", () => {
  it.each(rows)("%s → blocked=%s", (_label, labels, blocked) => {
    expect(payBlocked(labels as any)).toBe(blocked);
    // Unchanged behaviour: the panel's previous expression agrees on every row.
    expect(payBlocked(labels as any)).toBe(trustStateOfStatus(labels as any) != null);
  });

  it("no status at all is blocked (fail closed; no call site passes one)", () => {
    expect(payBlocked(null)).toBe(true);
    expect(payBlocked(undefined)).toBe(true);
  });

  it("reads only the two labels: the S3 reason and the rest of the status never change the answer", () => {
    const base = { treasury_signature: "verified", treasury_pay_refusal: null };
    expect(payBlocked({ ...base, treasury_signature_reason: "key_unset", price_sats: 1, deposit_address: "x" } as any)).toBe(false);
    expect(payBlocked({ treasury_signature: "unsigned", applicable: true, current_tier: "current" } as any)).toBe(true);
  });
});
