import { describe, it, expect } from "vitest";
import { bip21Uri } from "./bip21";

describe("bip21Uri", () => {
  const ADDR = "bc1qexampleaddress0000000000000000000000";

  it("uses a lowercase scheme and lowercase amount key", () => {
    const uri = bip21Uri(ADDR, 50_000);
    expect(uri.startsWith("bitcoin:")).toBe(true);
    expect(uri).toContain("?amount=");
    // No uppercased scheme or key (the QR-string trap).
    expect(uri).not.toContain("BITCOIN:");
    expect(uri).not.toContain("?AMOUNT=");
  });

  it("renders the amount as 8-decimal BTC", () => {
    expect(bip21Uri(ADDR, 50_000)).toBe(`bitcoin:${ADDR}?amount=0.00050000`);
    expect(bip21Uri(ADDR, 100_000_000)).toBe(`bitcoin:${ADDR}?amount=1.00000000`);
    expect(bip21Uri(ADDR, 1)).toBe(`bitcoin:${ADDR}?amount=0.00000001`);
  });

  it("preserves the (lowercase) address verbatim", () => {
    const uri = bip21Uri(ADDR, 50_000);
    expect(uri).toContain(ADDR);
  });
});
