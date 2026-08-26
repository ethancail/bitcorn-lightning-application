// Wall-clock timing for the 15s sync tick.
//
// ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// Nothing in this repository has ever measured LND call latency. Every timeout
// value in the tree is therefore argued rather than derived — including
// LND_GOSSIP_CALL_TIMEOUT_MS, which says so in its own docblock. This is what
// replaces the argument with a distribution.
//
// The specific question it exists to answer: the sync tick makes six guaranteed
// sequential LND calls plus one per page of forwarding history, so a 3s per-call
// deadline bounds each call but leaves the TICK able to exceed its own 15s
// period. Whether that matters — and what a per-tick budget should be — needs
// the real distribution of tick durations, not just the tail. Hence a line on
// EVERY tick rather than only on slow ones.
//
// ─── ON BEING ON BY DEFAULT ─────────────────────────────────────────────────
//
// Default is `calls`: on, ungated, one line per tick. Gating this behind
// ENV.debug would make it unreachable in production, which is the exact
// unreachable-default trap this codebase has been bitten by, and would defeat
// the whole point — the measurement is wanted from real member nodes, whose
// operators never set DEBUG.
//
// But permanent-by-default is a decision nobody made, and this ships to farmer
// nodes that update by clicking. So the volume comes down via
// LND_SYNC_TIMING_LEVEL without a code change:
//
//   calls (default) — one line per tick, with the per-step breakdown
//   tick            — one line per tick, total only
//   off             — nothing
//
// ⚠ THE KNOB IS PROVEN REACHABLE BY TEST, not merely present. syncTiming.test.ts
// re-imports config/env with the variable set and asserts ENV carries the parsed
// value, because an unreachable knob is worse than none: it reads as the
// effective configuration to anyone grepping for it. This repo has already been
// bitten by exactly that — a `?? 1_000_000` fallback a parseInt could never
// reach became the documented rate limit in two places while the real value was
// 200x higher.

export type SyncTimingLevel = "off" | "tick" | "calls";

/** On, with the per-step breakdown. See the header for why the default is on. */
export const DEFAULT_SYNC_TIMING_LEVEL: SyncTimingLevel = "calls";

/**
 * Pure. Map the raw env string to a level.
 *
 * Unset, empty, or unrecognised all fall back to the default rather than
 * throwing or silently disabling: a typo in an operator's compose file should
 * not quietly turn the measurement off, which would be indistinguishable from
 * a healthy node that simply is not logging.
 */
export function parseSyncTimingLevel(raw: string | undefined): SyncTimingLevel {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "off":
      return "off";
    case "tick":
      return "tick";
    case "calls":
      return "calls";
    default:
      return DEFAULT_SYNC_TIMING_LEVEL;
  }
}

export type CallSample = { label: string; ms: number };

/**
 * Pure. Render one tick's timing line, or null when the level says nothing
 * should be logged. Separated from the emitting so the shape is testable
 * without capturing console.
 *
 * ⚠ THE PER-STEP NUMBERS ARE STEPS, NOT PURE LND TIME. persistPeers and
 * persistChannels each make one LND call and then write SQLite, so their
 * samples include the DB work. That is deliberate — the question a per-tick
 * budget has to answer is how long the TICK takes — but it means these are an
 * upper bound on LND latency, not a measurement of it.
 */
export function formatTickTiming(
  samples: readonly CallSample[],
  totalMs: number,
  level: SyncTimingLevel,
): string | null {
  if (level === "off") return null;
  if (level === "tick") return `[lnd-timing] tick=${totalMs}ms`;

  const breakdown = samples.map((s) => `${s.label}=${s.ms}ms`).join(" ");
  return `[lnd-timing] tick=${totalMs}ms${breakdown ? " " + breakdown : ""}`;
}

/**
 * Collects per-step wall clock across one tick.
 *
 * The clock is injected (house style — mirrors base/staleness.ts) so tests read
 * deterministic durations instead of racing a real one.
 *
 * A step that THROWS is still recorded, then the error is rethrown. That is
 * load-bearing for this arc: the interesting tick is the one where a call hit
 * its deadline, and a timer that only recorded successes would omit exactly the
 * measurement worth having.
 */
export function createTickTimer(now: () => number = Date.now) {
  const started = now();
  const samples: CallSample[] = [];

  return {
    async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const t0 = now();
      try {
        return await fn();
      } finally {
        samples.push({ label, ms: now() - t0 });
      }
    },
    samples(): CallSample[] {
      return samples;
    },
    totalMs(): number {
      return now() - started;
    },
  };
}
