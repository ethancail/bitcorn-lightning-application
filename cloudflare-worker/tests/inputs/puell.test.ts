import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { puell } from "../../src/valuation/inputs/puell";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("puell adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'puell'", () => {
    expect(puell.key).toBe("puell");
  });

  it("fetchLatest parses Glassnode response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 0.42 }]), { status: 200 })
    );
    const reading = await puell.fetchLatest(env);
    expect(reading).not.toBeNull();
    expect(reading!.value).toBeCloseTo(0.42, 10);
  });

  it("calls the correct Glassnode metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 0.42 }]), { status: 200 })
    );
    await puell.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/puell_multiple");
  });
});
