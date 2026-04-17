import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { difficultyRibbon } from "../../src/valuation/inputs/difficultyRibbon";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("difficultyRibbon adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'difficulty_ribbon'", () => {
    expect(difficultyRibbon.key).toBe("difficulty_ribbon");
  });

  it("calls the difficulty-ribbon compression metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 0.023 }]), { status: 200 })
    );
    await difficultyRibbon.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/difficulty_ribbon_compression");
  });
});
