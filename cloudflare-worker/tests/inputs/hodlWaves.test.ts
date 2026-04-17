import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hodlWaves } from "../../src/valuation/inputs/hodlWaves";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("hodlWaves adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'hodl_waves'", () => {
    expect(hodlWaves.key).toBe("hodl_waves");
  });

  it("calls the realized-HODL-waves metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 0.15 }]), { status: 200 })
    );
    await hodlWaves.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/supply/realized_hodl_waves");
  });
});
