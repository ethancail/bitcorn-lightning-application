import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../../src/valuation/inputs";
import { INPUT_WEIGHTS } from "../../src/valuation/composite";

describe("ADAPTERS registry", () => {
  it("contains exactly 12 adapters", () => {
    expect(ADAPTERS.length).toBe(12);
  });

  it("every adapter.key matches a key in INPUT_WEIGHTS", () => {
    for (const a of ADAPTERS) {
      expect(INPUT_WEIGHTS[a.key], `weight missing for ${a.key}`).toBeTypeOf("number");
    }
  });

  it("every INPUT_WEIGHTS key has exactly one adapter", () => {
    const adapterKeys = new Set(ADAPTERS.map((a) => a.key));
    for (const key of Object.keys(INPUT_WEIGHTS)) {
      expect(adapterKeys.has(key), `no adapter for weight key '${key}'`).toBe(true);
    }
  });

  it("adapter keys are unique", () => {
    const keys = ADAPTERS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
