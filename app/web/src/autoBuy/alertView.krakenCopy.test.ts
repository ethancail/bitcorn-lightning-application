// kraken-autobuy P6: each alert's Kraken text, as Ethan approved it (E4, with
// his edits (a)–(c)), pinned verbatim. An alert raised on Kraken carries
// provider "kraken" in its context (D-P6-1); one without a provider is
// Coinbase's and keeps the Coinbase text, so both directions are asserted.
import { describe, it, expect } from "vitest";
import type { AutoBuyAlert } from "../api/client";
import { summarizeAlert } from "./alertView";

function alert(type: string, context: Record<string, unknown> | null, over: Partial<AutoBuyAlert> = {}): AutoBuyAlert {
  return {
    id: 1, type, severity: "warning", status: "active", consecutive_count: 1, latest_run_id: null,
    context, created_at: 1, updated_at: 1, resolved_at: null, dismissed_at: null,
    ...over,
  } as unknown as AutoBuyAlert;
}
const K = { provider: "kraken" };

describe("the three Kraken-only alert types", () => {
  it("AUTOBUY_BUY_BELOW_MINIMUM names the buy and the minimum", () => {
    const s = summarizeAlert(alert("AUTOBUY_BUY_BELOW_MINIMUM", { ...K, intended_buy_usd: 5, minimum_usd: 9.99 }));
    expect(s.title).toBe("Buy skipped: below Kraken's minimum");
    expect(s.message).toBe(
      "Auto-Buy skipped a $5.00 buy because Kraken's minimum is about $9.99. Buys are never rounded up. To buy in this zone, raise your base buy or this zone's multiplier.",
    );
  });
  it("AUTOBUY_BUY_BELOW_MINIMUM: every amount to two decimals (ruling C2; the capture read \"$5.6\")", () => {
    const s = summarizeAlert(alert("AUTOBUY_BUY_BELOW_MINIMUM", { ...K, intended_buy_usd: 0.25, minimum_usd: 5.6 }));
    expect(s.message).toContain("Auto-Buy skipped a $0.25 buy because Kraken's minimum is about $5.60.");
    expect(s.message).not.toMatch(/\$5\.6(?!0)/);
  });
  it("AUTOBUY_BUY_BELOW_MINIMUM refused by Kraken itself (no minimum figure) still reads as a sentence", () => {
    const s = summarizeAlert(alert("AUTOBUY_BUY_BELOW_MINIMUM", { ...K, intended_buy_usd: 5, minimum_usd: null }));
    expect(s.message).toContain("Auto-Buy skipped a $5.00 buy because it is below Kraken's minimum.");
  });
  it("AUTOBUY_WITHDRAWAL_AWAITING_APPROVAL (G1)", () => {
    const s = summarizeAlert(alert("AUTOBUY_WITHDRAWAL_AWAITING_APPROVAL", { ...K, btc_amount: 0.0123 }));
    expect(s.title).toBe("Withdrawal waiting for approval");
    expect(s.message).toBe(
      "Kraken is holding a withdrawal of 0.0123 BTC to your node until someone on your Kraken account approves it. Approve it in Kraken and Auto-Buy will pick up the result. If it's rejected, the BTC stays on Kraken.",
    );
  });
  it("AUTOBUY_LOW_FUNDS, with edit (c): the recurring deposit", () => {
    const s = summarizeAlert(alert("AUTOBUY_LOW_FUNDS", { ...K, usd_available: 150, next_buy_usd: 100, buys_covered: 1 }));
    expect(s.title).toBe("Low funds on Kraken");
    expect(s.message).toBe(
      "$150.00 USD covers 1 of your next buys ($100.00 each at the current zone). Add USD to Kraken, or raise your recurring deposit, to keep Auto-Buy buying. USDC isn't used for Kraken buys.",
    );
  });
});

describe("unknown outcomes and the too-short hold (G6, D-P6-3)", () => {
  it("ORDER_FAILED outcome_unknown names the buy and never says it failed", () => {
    const s = summarizeAlert(alert("AUTOBUY_ORDER_FAILED", { ...K, error_code: "outcome_unknown", intended_buy_usd: 100 }));
    expect(s.title).toBe("Buy outcome unknown");
    expect(s.message).toBe(
      "Kraken didn't confirm whether the $100.00 buy went through. Auto-Buy won't buy twice: it checks on its next run. Three unknowns in a row pause Auto-Buy.",
    );
  });
  it("SWEEP_FAILED withdraw_outcome_unknown says check first; it never says the BTC is safe", () => {
    const s = summarizeAlert(alert("AUTOBUY_SWEEP_FAILED", { ...K, error_code: "withdraw_outcome_unknown", btc_amount: 0.002 }, { severity: "critical" }));
    expect(s.title).toBe("Withdrawal outcome unknown");
    expect(s.message).toBe(
      "Kraken didn't confirm whether 0.002 BTC was sent to your node, and Auto-Buy won't send it again. Check Withdrawals in Kraken. If it's listed, it's on its way. If not, the BTC is still on Kraken; withdraw it yourself to your node's saved address.",
    );
    expect(s.message).not.toContain("safe");
  });
  it("SWEEP_FAILED with any other code is G6's text, with edit (b)", () => {
    const s = summarizeAlert(alert("AUTOBUY_SWEEP_FAILED", { ...K, error_code: "failed", btc_amount: 0.002 }, { severity: "critical" }));
    expect(s.title).toBe("Withdrawal failed: your BTC is safe on Kraken");
    expect(s.message).toBe(
      "0.002 BTC was bought but Kraken didn't send it to your node (failed). For example, Kraken may be holding the funds for review. To move it yourself, in Kraken go to Withdraw → Bitcoin, pick your node's saved address, and withdraw 0.002 BTC. Auto-Buy won't retry this withdrawal.",
    );
    expect(s.icon).toBe("✕");
  });
});

describe("the shared alert types, worded for Kraken", () => {
  it("AUTH_FAILURE", () => {
    const s = summarizeAlert(alert("AUTOBUY_AUTH_FAILURE", { ...K, paused_reason: "credentials_invalid" }, { severity: "critical" }));
    expect(s.title).toBe("Auto-Buy paused: Kraken key refused");
    expect(s.message).toBe("Kraken refused the API key. Check that the key still exists with the five permissions, then connect it again.");
  });
  it("RATE_LIMITED shows Kraken's error string, with edit (a): no extra sentence", () => {
    const s = summarizeAlert(alert("AUTOBUY_RATE_LIMITED", { ...K, http_status: 200, error: "EAPI:Rate limit exceeded" }));
    expect(s.title).toBe("Kraken busy or rate-limited");
    expect(s.message).toBe('Kraken returned "EAPI:Rate limit exceeded". This is usually brief; Auto-Buy tries again on its next run.');
    expect(s.message).not.toContain("200");
  });
  it("INSUFFICIENT_FUNDS adds the USDC note (D-P4-8)", () => {
    const s = summarizeAlert(alert("AUTOBUY_INSUFFICIENT_FUNDS", { ...K, intended_buy_usd: 100, currencies_checked: "USD" }));
    expect(s.message).toBe("No selected currency covered the $100.00 buy (checked USD). Add funds or adjust your currency preference. USDC isn't used for Kraken buys.");
  });
  it("ORDER_FAILED (a plain rejection) names Kraken", () => {
    const s = summarizeAlert(alert("AUTOBUY_ORDER_FAILED", { ...K, error_code: "rejected" }, { consecutive_count: 2 }));
    expect(s.message).toBe("Kraken rejected the buy order: rejected. Repeated rejections (×2) suggest a persistent problem.");
  });
});

describe("an alert WITHOUT a provider is Coinbase's: its text is unchanged", () => {
  it("auth, rate limit, sweep and order failures keep the Coinbase wording", () => {
    expect(summarizeAlert(alert("AUTOBUY_AUTH_FAILURE", {}, { severity: "critical" })).title).toBe("Auto-Buy paused — Coinbase credentials rejected");
    expect(summarizeAlert(alert("AUTOBUY_RATE_LIMITED", { http_status: 429 })).message).toBe(
      "A Coinbase call returned 429. Usually transient — the scheduler retries on the next tick.",
    );
    expect(summarizeAlert(alert("AUTOBUY_SWEEP_FAILED", { btc_amount: 0.01, error_code: "address_not_whitelisted" }, { severity: "critical" })).title)
      .toBe("Sweep failed — BTC held on Coinbase");
    expect(summarizeAlert(alert("AUTOBUY_ORDER_FAILED", { error_message: "bad order" })).message).toContain("Coinbase rejected the buy order: bad order.");
    expect(summarizeAlert(alert("AUTOBUY_INSUFFICIENT_FUNDS", { intended_buy_usd: 25, currencies_checked: "USD,USDC" })).message)
      .not.toContain("Kraken");
  });
});
