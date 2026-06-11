import { describe, it, expect, beforeEach } from "vitest";
import {
  parseStatusForPayment,
  estimateFeeSats,
  ESTIMATED_TX_VBYTES,
  classifySendError,
  lndErrorDetail,
  errorHttpStatus,
  acquireSendLock,
  releaseSendLock,
  isSendInFlight,
  type PayFromNodeError,
} from "./payFromNode";

describe("parseStatusForPayment — amount + destination derivation", () => {
  const applicable = {
    applicable: true,
    member_pubkey: "02abc",
    current_tier: "prepay",
    paid_through: 0,
    price_sats: 50_000,
    period_days: 30,
    deposit_address: "bc1qexampleaddress0000000000000000000000",
    last_payment_at: null,
    last_payment_txid: null,
    grace: { fresh_until: 0, worker_until: 0, routing_until: 0, close_at: 0 },
  };

  it("derives address and amount from an applicable status", () => {
    expect(parseStatusForPayment(applicable)).toEqual({
      deposit_address: "bc1qexampleaddress0000000000000000000000",
      price_sats: 50_000,
    });
  });

  it("returns null for a not-applicable status (no deposit address exists)", () => {
    expect(parseStatusForPayment({ applicable: false, reason: "missing" })).toBeNull();
    expect(parseStatusForPayment({ applicable: false, reason: "no_channel" })).toBeNull();
  });

  it("returns null when the deposit address is missing or empty", () => {
    expect(parseStatusForPayment({ ...applicable, deposit_address: "" })).toBeNull();
    const { deposit_address, ...noAddr } = applicable;
    void deposit_address;
    expect(parseStatusForPayment(noAddr)).toBeNull();
  });

  it("returns null when price_sats is missing, zero, or non-finite", () => {
    expect(parseStatusForPayment({ ...applicable, price_sats: 0 })).toBeNull();
    expect(parseStatusForPayment({ ...applicable, price_sats: -1 })).toBeNull();
    expect(parseStatusForPayment({ ...applicable, price_sats: NaN })).toBeNull();
    const { price_sats, ...noPrice } = applicable;
    void price_sats;
    expect(parseStatusForPayment(noPrice)).toBeNull();
  });

  it("returns null for junk inputs (never throws)", () => {
    expect(parseStatusForPayment(null)).toBeNull();
    expect(parseStatusForPayment(undefined)).toBeNull();
    expect(parseStatusForPayment("not an object")).toBeNull();
    expect(parseStatusForPayment(42)).toBeNull();
  });

  it("never trusts a client-supplied address: only the treasury body's field is read", () => {
    // Even if extra fields are present, only deposit_address/price_sats matter.
    const target = parseStatusForPayment({
      ...applicable,
      // a hypothetical attacker-injected field is ignored
      destination_override: "bc1qattacker",
      amount_override: 9_999_999,
    } as any);
    expect(target).toEqual({
      deposit_address: "bc1qexampleaddress0000000000000000000000",
      price_sats: 50_000,
    });
  });
});

describe("estimateFeeSats — fee preview from a per-vByte rate", () => {
  it("multiplies the rate by the conservative vsize and rounds up", () => {
    expect(estimateFeeSats(1)).toBe(ESTIMATED_TX_VBYTES);
    expect(estimateFeeSats(10)).toBe(10 * ESTIMATED_TX_VBYTES);
  });

  it("rounds fractional rates up so the preview never under-quotes", () => {
    expect(estimateFeeSats(1.5)).toBe(Math.ceil(1.5 * ESTIMATED_TX_VBYTES));
    expect(estimateFeeSats(2.3)).toBe(Math.ceil(2.3 * ESTIMATED_TX_VBYTES));
  });

  it("returns 0 for non-positive or non-finite rates", () => {
    expect(estimateFeeSats(0)).toBe(0);
    expect(estimateFeeSats(-5)).toBe(0);
    expect(estimateFeeSats(NaN)).toBe(0);
    expect(estimateFeeSats(Infinity)).toBe(0);
  });
});

describe("classifySendError — LND send error → app error code", () => {
  it("recognizes insufficient balance variants", () => {
    expect(classifySendError([503, "InsufficientBalance"]).code).toBe("insufficient_funds");
    expect(classifySendError(new Error("insufficient funds available")).code).toBe("insufficient_funds");
    expect(classifySendError("not enough funds to construct transaction").code).toBe("insufficient_funds");
  });

  it("recognizes LND-unavailable / connection failures", () => {
    expect(classifySendError([503, "FailedToConnect"]).code).toBe("lnd_unavailable");
    expect(classifySendError(new Error("LND files not available: missing TLS cert")).code).toBe("lnd_unavailable");
    expect(classifySendError("14 UNAVAILABLE: No connection established").code).toBe("lnd_unavailable");
    expect(classifySendError(new Error("connect ECONNREFUSED 127.0.0.1:10009")).code).toBe("lnd_unavailable");
  });

  it("falls back to send_failed for unrecognized errors, preserving detail", () => {
    const r = classifySendError([500, "SomethingWeirdHappened", { foo: 1 }]);
    expect(r.code).toBe("send_failed");
    expect(r.detail).toContain("SomethingWeirdHappened");
  });
});

describe("lndErrorDetail — readable detail extraction (never throws)", () => {
  it("flattens ln-service array-shaped errors", () => {
    expect(lndErrorDetail([503, "FailedToConnect", { err: "x" }])).toContain("FailedToConnect");
  });
  it("reads Error.message and plain strings", () => {
    expect(lndErrorDetail(new Error("boom"))).toBe("boom");
    expect(lndErrorDetail("plain")).toBe("plain");
  });
  it("handles null/undefined", () => {
    expect(lndErrorDetail(null)).toBe("unknown error");
    expect(lndErrorDetail(undefined)).toBe("unknown error");
  });
});

describe("errorHttpStatus — error code → HTTP status", () => {
  const cases: Array<[PayFromNodeError, number]> = [
    ["payment_in_flight", 409],
    ["status_unavailable", 503],
    ["lnd_unavailable", 503],
    ["insufficient_funds", 400],
    ["fee_estimate_failed", 502],
    ["send_failed", 502],
  ];
  it.each(cases)("%s → %i", (code, status) => {
    expect(errorHttpStatus(code)).toBe(status);
  });
});

describe("in-flight guard — single concurrent send", () => {
  beforeEach(() => releaseSendLock());

  it("acquires when free, refuses a second acquire while held", () => {
    expect(isSendInFlight()).toBe(false);
    expect(acquireSendLock()).toBe(true);
    expect(isSendInFlight()).toBe(true);
    // Second concurrent attempt (the double-click) is refused → 409.
    expect(acquireSendLock()).toBe(false);
    expect(errorHttpStatus("payment_in_flight")).toBe(409);
  });

  it("re-acquires after release", () => {
    expect(acquireSendLock()).toBe(true);
    releaseSendLock();
    expect(isSendInFlight()).toBe(false);
    expect(acquireSendLock()).toBe(true);
  });
});
