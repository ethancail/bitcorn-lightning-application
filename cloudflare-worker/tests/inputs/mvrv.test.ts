import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mvrv } from "../../src/valuation/inputs/mvrv";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("mvrv adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'mvrv'", () => {
    expect(mvrv.key).toBe("mvrv");
  });

  it("fetchLatest returns the last point from the Glassnode response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744761600, v: 1.8 }, { t: 1744848000, v: 2.1 }]), { status: 200 })
    );
    const reading = await mvrv.fetchLatest(env);
    expect(reading).not.toBeNull();
    expect(reading!.value).toBeCloseTo(2.1, 10);
  });
});
