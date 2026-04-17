import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sopr } from "../../src/valuation/inputs/sopr";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("sopr adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'sopr'", () => {
    expect(sopr.key).toBe("sopr");
  });

  it("calls the adjusted-SOPR 30d-MA metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 1.008 }]), { status: 200 })
    );
    await sopr.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/sopr_adjusted");
  });
});
