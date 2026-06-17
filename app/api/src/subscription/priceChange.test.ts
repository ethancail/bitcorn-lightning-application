import { describe, it, expect } from "vitest";
import { priceChangePending, priceChangeContent } from "./priceChange";

describe("priceChangePending", () => {
  it("is false when current price matches the last acknowledged price", () => {
    expect(
      priceChangePending({
        applicable: true,
        autoPayEnabled: true,
        currentPriceSats: 50000,
        lastAcknowledgedPrice: 50000,
      }),
    ).toBe(false);
  });

  it("is true when current price differs from the last acknowledged price", () => {
    expect(
      priceChangePending({
        applicable: true,
        autoPayEnabled: true,
        currentPriceSats: 60000,
        lastAcknowledgedPrice: 50000,
      }),
    ).toBe(true);
  });

  it("treats a null acknowledged price while enabled as pending", () => {
    expect(
      priceChangePending({
        applicable: true,
        autoPayEnabled: true,
        currentPriceSats: 50000,
        lastAcknowledgedPrice: null,
      }),
    ).toBe(true);
  });

  it("is false when auto-pay is disabled (opting out clears the banner)", () => {
    expect(
      priceChangePending({
        applicable: true,
        autoPayEnabled: false,
        currentPriceSats: 60000,
        lastAcknowledgedPrice: 50000,
      }),
    ).toBe(false);
  });

  it("is false when the subscription status is not applicable", () => {
    expect(
      priceChangePending({
        applicable: false,
        autoPayEnabled: true,
        currentPriceSats: 60000,
        lastAcknowledgedPrice: 50000,
      }),
    ).toBe(false);
  });
});

describe("priceChangeContent", () => {
  it("renders headline, body, and the current/previous prices", () => {
    const content = priceChangeContent(60000, 50000);
    expect(content.currentPrice).toBe(60000);
    expect(content.previousPrice).toBe(50000);
    expect(content.headline).toMatch(/price/i);
    expect(content.body).toContain("60,000");
    expect(content.body).toContain("50,000");
  });

  it("tolerates a null previous price", () => {
    const content = priceChangeContent(50000, null);
    expect(content.previousPrice).toBeNull();
    expect(content.body).toContain("50,000");
  });
});
