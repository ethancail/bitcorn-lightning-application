import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reserveRisk } from "../../src/valuation/inputs/reserveRisk";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("reserveRisk adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'reserve_risk'", () => {
    expect(reserveRisk.key).toBe("reserve_risk");
  });

  it("calls the reserve-risk metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 0.003 }]), { status: 200 })
    );
    await reserveRisk.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/reserve_risk");
  });
});
