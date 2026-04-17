import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashRibbons } from "../../src/valuation/inputs/hashRibbons";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("hashRibbons adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'hash_ribbons'", () => {
    expect(hashRibbons.key).toBe("hash_ribbons");
  });

  it("calls the hash-rate MA signal metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 1.02 }]), { status: 200 })
    );
    await hashRibbons.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/hash_ribbon");
  });
});
