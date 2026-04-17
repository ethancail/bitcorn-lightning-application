import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nvt } from "../../src/valuation/inputs/nvt";
import type { Env } from "../../src/lib/types";

const env = { GLASSNODE_API_KEY: "glass-key" } as unknown as Env;

describe("nvt adapter", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses key 'nvt'", () => {
    expect(nvt.key).toBe("nvt");
  });

  it("calls the NVT signal metric path", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify([{ t: 1744848000, v: 85.4 }]), { status: 200 })
    );
    await nvt.fetchLatest(env);
    const url = (globalThis.fetch as any).mock.calls[0][0];
    expect(url).toContain("/indicators/nvts");
  });
});
