import { describe, expect, it } from "vitest";
import { minerOutflows } from "../../src/valuation/inputs/minerOutflows";

describe("minerOutflows adapter", () => {
  it("uses key 'miner_outflows'", () => {
    expect(minerOutflows.key).toBe("miner_outflows");
  });

  it("is a manual adapter (post-v1.13.16 — switched from CryptoQuant)", () => {
    expect(minerOutflows.source).toBe("manual");
    expect(minerOutflows.category).toBe("mining");
    expect(minerOutflows.label).toBe("Miner Outflows");
  });
});
