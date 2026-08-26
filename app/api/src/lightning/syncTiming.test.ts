// Controls for the sync-tick timing, and for the knob that turns it down.
//
// ⚠ THE KNOB CONTROL IS THE POINT OF THIS FILE. A knob that is present but
// unreachable is WORSE than no knob: it reads as the effective configuration to
// anyone grepping for it. This repo has already been bitten by exactly that — a
// `?? 1_000_000` fallback that a parseInt could never reach became the
// documented rate limit in two places while the real value was 200x higher. So
// the non-default value is proven to reach ENV through the real config module,
// not merely proven to parse.

import { describe, expect, it, vi, afterEach } from "vitest";
import {
  parseSyncTimingLevel,
  formatTickTiming,
  createTickTimer,
  DEFAULT_SYNC_TIMING_LEVEL,
} from "./syncTiming";

const ORIGINAL = process.env.LND_SYNC_TIMING_LEVEL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.LND_SYNC_TIMING_LEVEL;
  else process.env.LND_SYNC_TIMING_LEVEL = ORIGINAL;
  vi.resetModules();
});

// ═══════════════════════════════════════════════════════════════════════════
// THE KNOB IS REACHABLE — through config/env, not just through the parser.
// ═══════════════════════════════════════════════════════════════════════════

describe("LND_SYNC_TIMING_LEVEL actually reaches ENV", () => {
  async function envWith(value: string | undefined) {
    vi.resetModules();
    if (value === undefined) delete process.env.LND_SYNC_TIMING_LEVEL;
    else process.env.LND_SYNC_TIMING_LEVEL = value;
    const { ENV } = await import("../config/env");
    return ENV.syncTimingLevel;
  }

  it("unset gives the default, which is ON", async () => {
    expect(await envWith(undefined)).toBe(DEFAULT_SYNC_TIMING_LEVEL);
    expect(DEFAULT_SYNC_TIMING_LEVEL).toBe("calls");
  });

  it("⚠ 'off' REACHES ENV — the knob is not decorative", async () => {
    expect(await envWith("off")).toBe("off");
  });

  it("⚠ 'tick' REACHES ENV", async () => {
    expect(await envWith("tick")).toBe("tick");
  });

  it("an unrecognised value falls back to the default rather than disabling", async () => {
    // A typo in a compose file must not silently stop the measurement — that
    // would be indistinguishable from a healthy node that is simply not logging.
    expect(await envWith("verbose")).toBe(DEFAULT_SYNC_TIMING_LEVEL);
  });
});

describe("parseSyncTimingLevel", () => {
  it("accepts the three levels, case- and whitespace-insensitively", () => {
    expect(parseSyncTimingLevel("off")).toBe("off");
    expect(parseSyncTimingLevel(" OFF ")).toBe("off");
    expect(parseSyncTimingLevel("Tick")).toBe("tick");
    expect(parseSyncTimingLevel("calls")).toBe("calls");
  });

  it("falls back to the default on undefined, empty and garbage", () => {
    for (const raw of [undefined, "", "   ", "yes", "1", "true"]) {
      expect(parseSyncTimingLevel(raw)).toBe(DEFAULT_SYNC_TIMING_LEVEL);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE KNOB TAKES EFFECT — each level produces a different observable output.
// ═══════════════════════════════════════════════════════════════════════════

describe("formatTickTiming honours the level", () => {
  const samples = [
    { label: "getLndInfo", ms: 12 },
    { label: "persistPeers", ms: 40 },
  ];

  it("off emits nothing at all", () => {
    expect(formatTickTiming(samples, 100, "off")).toBeNull();
  });

  it("tick emits the total and NOT the breakdown", () => {
    const line = formatTickTiming(samples, 100, "tick")!;
    expect(line).toContain("tick=100ms");
    expect(line).not.toContain("getLndInfo");
  });

  it("calls emits the total AND the breakdown", () => {
    const line = formatTickTiming(samples, 100, "calls")!;
    expect(line).toContain("tick=100ms");
    expect(line).toContain("getLndInfo=12ms");
    expect(line).toContain("persistPeers=40ms");
  });

  it("the three levels are genuinely distinguishable", () => {
    // Guards the green-control mechanism "all three returned a string, so all
    // three assertions passed": they must differ from each other.
    const off = formatTickTiming(samples, 100, "off");
    const tick = formatTickTiming(samples, 100, "tick");
    const calls = formatTickTiming(samples, 100, "calls");
    expect(new Set([String(off), String(tick), String(calls)]).size).toBe(3);
  });

  it("survives an empty sample list without a trailing separator", () => {
    expect(formatTickTiming([], 7, "calls")).toBe("[lnd-timing] tick=7ms");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE TIMER — including the failed-tick case, which is the one worth having.
// ═══════════════════════════════════════════════════════════════════════════

describe("createTickTimer", () => {
  /** Deterministic clock: each read advances by `step`. */
  function clock(steps: number[]) {
    let i = 0;
    return () => steps[Math.min(i++, steps.length - 1)];
  }

  it("records each step's duration against the injected clock", async () => {
    // reads: start=0, t0=0, after=10, t0=10, after=35, total=35
    const t = createTickTimer(clock([0, 0, 10, 10, 35, 35]));
    await t.time("a", async () => 1);
    await t.time("b", async () => 2);
    expect(t.samples()).toEqual([
      { label: "a", ms: 10 },
      { label: "b", ms: 25 },
    ]);
  });

  it("⚠ records a step that THREW, then rethrows", async () => {
    // The interesting tick is the one where a call hit its deadline. A timer
    // that only recorded successes would omit exactly that measurement.
    const t = createTickTimer(clock([0, 0, 3000, 3000]));
    await expect(
      t.time("getLndChainBalance", async () => {
        throw new Error("ETIMEDOUT: getLndChainBalance exceeded 3000ms deadline");
      }),
    ).rejects.toThrow(/ETIMEDOUT/);

    expect(t.samples()).toEqual([{ label: "getLndChainBalance", ms: 3000 }]);
  });

  it("passes the step's resolved value through untouched", async () => {
    const t = createTickTimer(clock([0, 0, 1, 1]));
    await expect(t.time("x", async () => ({ channels: [1, 2] }))).resolves.toEqual({
      channels: [1, 2],
    });
  });
});
