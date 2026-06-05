import { describe, it, expect } from "vitest";
import {
  selectCurrency,
  currenciesCheckedFor,
  productIdFor,
  type CurrencyPreference,
} from "./currency";

// Spec §8: all four preferences × balance states
// {USD covers / USDC covers / both cover / neither covers / exact-equal
// boundary}. intendedBuyUsd is fixed at 100 throughout; balances vary.
const NEED = 100;

// Balance states. Boundary states use exactly NEED to assert >= coverage.
const STATES = {
  usdOnly:        { usd: 150, usdc: 0,   label: "USD covers only" },
  usdcOnly:       { usd: 0,   usdc: 150, label: "USDC covers only" },
  both:           { usd: 150, usdc: 150, label: "both cover" },
  neither:        { usd: 50,  usdc: 50,  label: "neither covers" },
  usdBoundary:    { usd: 100, usdc: 0,   label: "USD exactly equal (boundary)" },
  usdcBoundary:   { usd: 0,   usdc: 100, label: "USDC exactly equal (boundary)" },
} as const;

type Expected = "USD" | "USDC" | null;

// Full expectation matrix: preference → state → selected currency.
const MATRIX: Record<CurrencyPreference, Record<keyof typeof STATES, Expected>> = {
  usd_only: {
    usdOnly: "USD", usdcOnly: null, both: "USD", neither: null,
    usdBoundary: "USD", usdcBoundary: null,
  },
  usdc_only: {
    usdOnly: null, usdcOnly: "USDC", both: "USDC", neither: null,
    usdBoundary: null, usdcBoundary: "USDC",
  },
  usd_preferred: {
    usdOnly: "USD", usdcOnly: "USDC", both: "USD", neither: null,
    usdBoundary: "USD", usdcBoundary: "USDC",
  },
  usdc_preferred: {
    usdOnly: "USD", usdcOnly: "USDC", both: "USDC", neither: null,
    usdBoundary: "USD", usdcBoundary: "USDC",
  },
};

describe("selectCurrency — 4 preferences × balance states", () => {
  for (const preference of Object.keys(MATRIX) as CurrencyPreference[]) {
    describe(preference, () => {
      for (const stateKey of Object.keys(STATES) as Array<keyof typeof STATES>) {
        const { usd, usdc, label } = STATES[stateKey];
        const expected = MATRIX[preference][stateKey];
        it(`${label} (usd=${usd}, usdc=${usd === usdc ? usdc : usdc}) → ${expected ?? "null (skip)"}`, () => {
          expect(selectCurrency(preference, usd, usdc, NEED)).toBe(expected);
        });
      }
    });
  }
});

describe("selectCurrency — boundary is inclusive (>=)", () => {
  it("balance exactly equal to intended counts as covered", () => {
    expect(selectCurrency("usd_only", 100, 0, 100)).toBe("USD");
    expect(selectCurrency("usdc_only", 0, 100, 100)).toBe("USDC");
  });
  it("balance one cent under intended does NOT cover", () => {
    expect(selectCurrency("usd_only", 99.99, 0, 100)).toBeNull();
    expect(selectCurrency("usdc_only", 0, 99.99, 100)).toBeNull();
  });
});

describe("selectCurrency — both-cover tiebreak (decision record)", () => {
  it("usd_preferred spends USD when both independently cover", () => {
    expect(selectCurrency("usd_preferred", 500, 500, 100)).toBe("USD");
  });
  it("usdc_preferred spends USDC when both independently cover", () => {
    expect(selectCurrency("usdc_preferred", 500, 500, 100)).toBe("USDC");
  });
  it("preferred currency short, fallback covers → falls back (Option C graceful degrade)", () => {
    expect(selectCurrency("usd_preferred", 50, 500, 100)).toBe("USDC");
    expect(selectCurrency("usdc_preferred", 500, 50, 100)).toBe("USD");
  });
});

describe("currenciesCheckedFor — canonical order, outcome-independent", () => {
  it("single-currency preferences check exactly one", () => {
    expect(currenciesCheckedFor("usd_only")).toBe("USD");
    expect(currenciesCheckedFor("usdc_only")).toBe("USDC");
  });
  it("both preferences record 'USD,USDC' in canonical order regardless of priority", () => {
    expect(currenciesCheckedFor("usd_preferred")).toBe("USD,USDC");
    expect(currenciesCheckedFor("usdc_preferred")).toBe("USD,USDC");
  });
});

describe("productIdFor", () => {
  it("maps currency to Coinbase product_id", () => {
    expect(productIdFor("USD")).toBe("BTC-USD");
    expect(productIdFor("USDC")).toBe("BTC-USDC");
  });
});
