// PAIR 4 — B3: frozen channel rows must be legible as frozen.
//
// The two halves are inseparable here. (a) alone is satisfied by a function that
// always says "stale", which would put a permanent marker on a healthy
// dashboard and train the farmer to ignore it — the same alert-fatigue failure
// the severity map reasons about. (b) is what forbids that.
//
// Pure module, clock injected: no DB, no fs, no store.

import { describe, it, expect } from "vitest";
import { channelDataFreshness } from "./memberStatsFreshness";
import { STALE_THRESHOLD_MS, VERY_STALE_THRESHOLD_MS } from "../base/staleness";

const NOW = 1_700_000_000_000;

describe("PAIR 4 — channel data age", () => {
  // ── (a) the frozen case, which is what the incident looked like ──
  it("reports a frozen row as stale, with its real age", () => {
    // Four days without a successful sync — the duration a farmer's node sat
    // broken before anyone noticed.
    const fourDays = 4 * 24 * 60 * 60 * 1000;
    const got = channelDataFreshness(NOW - fourDays, NOW);

    expect(got.staleness).toBe("very_stale");
    expect(got.age_seconds).toBe(fourDays / 1000);
    expect(got.updated_at_ms).toBe(NOW - fourDays);
  });

  // ── (b) THE CONTROL — the marker is not permanently on ──
  it("reports a freshly synced row as fresh, and emits no age alarm", () => {
    // The sync loop runs every 15s, so this is the steady state.
    const got = channelDataFreshness(NOW - 15_000, NOW);

    expect(got.staleness).toBe("fresh");
    expect(got.age_seconds).toBe(15);
    // The inequality, so neither half can be a constant.
    const frozen = channelDataFreshness(NOW - 4 * 24 * 60 * 60 * 1000, NOW);
    expect(got.staleness).not.toBe(frozen.staleness);
  });

  it("crosses into stale exactly at base/staleness.ts's threshold, not before", () => {
    const justUnder = channelDataFreshness(NOW - (STALE_THRESHOLD_MS - 1000), NOW);
    const justOver = channelDataFreshness(NOW - STALE_THRESHOLD_MS, NOW);

    expect(justUnder.staleness).toBe("fresh");
    expect(justOver.staleness).toBe("stale");
  });

  it("crosses into very_stale at the 30-minute threshold", () => {
    expect(channelDataFreshness(NOW - VERY_STALE_THRESHOLD_MS, NOW).staleness).toBe("very_stale");
    expect(
      channelDataFreshness(NOW - (VERY_STALE_THRESHOLD_MS - 1000), NOW).staleness,
    ).toBe("stale");
  });

  // never_synced vs very_stale: a fresh install is not a broken node.
  it("distinguishes never-synced from very-stale", () => {
    const never = channelDataFreshness(null, NOW);
    expect(never.staleness).toBe("never_synced");
    expect(never.age_seconds).toBeNull();
    expect(never.updated_at_ms).toBeNull();
    expect(never.staleness).not.toBe(
      channelDataFreshness(NOW - 10 * 24 * 60 * 60 * 1000, NOW).staleness,
    );
  });

  it("treats undefined and a non-finite timestamp as never-synced rather than throwing", () => {
    expect(channelDataFreshness(undefined, NOW).staleness).toBe("never_synced");
    expect(channelDataFreshness(NaN, NOW).staleness).toBe("never_synced");
  });

  it("clamps a future timestamp to age 0 instead of reporting negative age", () => {
    // Clock skew between the writer and the reader is real; a negative age
    // would render as a nonsense "-3s ago".
    const got = channelDataFreshness(NOW + 60_000, NOW);
    expect(got.age_seconds).toBe(0);
    expect(got.staleness).toBe("fresh");
  });
});
