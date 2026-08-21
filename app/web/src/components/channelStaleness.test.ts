// PAIR 4 (web half) — the marker appears when the numbers are old, and is
// ABSENT when they are not.
//
// (b) is the half that matters. A notice that always renders would satisfy every
// "shows a warning" assertion while putting a permanent scare-line on healthy
// dashboards — and since this ships as a release that lands on a large majority
// of nodes with nothing wrong, that is the more damaging failure of the two.

import { describe, it, expect } from "vitest";
import { channelStalenessNotice, type ChannelFreshnessInput } from "./channelStaleness";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const fresh: ChannelFreshnessInput = {
  updated_at_ms: NOW - 15_000,
  age_seconds: 15,
  staleness: "fresh",
};
const stale: ChannelFreshnessInput = {
  updated_at_ms: NOW - 12 * MIN,
  age_seconds: 12 * 60,
  staleness: "stale",
};
const veryStale: ChannelFreshnessInput = {
  updated_at_ms: NOW - 4 * 24 * 60 * MIN,
  age_seconds: 4 * 24 * 60 * 60,
  staleness: "very_stale",
};
const neverSynced: ChannelFreshnessInput = {
  updated_at_ms: null,
  age_seconds: null,
  staleness: "never_synced",
};

describe("channelStalenessNotice", () => {
  // ── (b) THE CONTROL: silence on a healthy node ──
  it("returns null for fresh numbers with LND reachable — healthy dashboards are unchanged", () => {
    expect(channelStalenessNotice(fresh, true, NOW)).toBeNull();
  });

  it("returns null when there is no channel at all", () => {
    expect(channelStalenessNotice(null, true, NOW)).toBeNull();
    expect(channelStalenessNotice(undefined, true, NOW)).toBeNull();
  });

  // ── (a) the incident shape: old numbers AND an unreachable LND ──
  it("says the figures are not current when they are old and LND is unreachable", () => {
    const n = channelStalenessNotice(veryStale, false, NOW)!;

    expect(n.severity).toBe("critical");
    expect(n.text).toMatch(/last updated/i);
    expect(n.text).toMatch(/not current/i);
    // The reassurance is the point — the farmer read a stale number as lost money.
    expect(n.text).toMatch(/funds are unaffected/i);
    // And the inequality against the healthy case, so neither is a constant.
    expect(channelStalenessNotice(fresh, true, NOW)).toBeNull();
  });

  it("names the remediation in the order that actually works", () => {
    const n = channelStalenessNotice(veryStale, false, NOW)!;
    // LND regenerates the cert on ITS restart; the API only picks up the new
    // cert afterwards. Lightning first, then Bitcorn.
    expect(n.text).toMatch(/restarting the lightning app, then bitcorn/i);
  });

  it("escalates very_stale above stale", () => {
    expect(channelStalenessNotice(stale, false, NOW)!.severity).toBe("warning");
    expect(channelStalenessNotice(veryStale, false, NOW)!.severity).toBe("critical");
  });

  it("still warns when the numbers are old but the live reads work — a lagging sync loop", () => {
    const n = channelStalenessNotice(stale, true, NOW)!;
    expect(n.text).toMatch(/may not be current/i);
    // No restart advice here: nothing suggests LND is down.
    expect(n.text).not.toMatch(/restarting the lightning app/i);
  });

  it("notes a failed live read even when the numbers are still fresh", () => {
    const n = channelStalenessNotice(fresh, false, NOW)!;
    expect(n.text).toMatch(/didn't respond just now/i);
    expect(n.text).toMatch(/funds are unaffected/i);
  });

  it("distinguishes never-synced from stale — a fresh install is not a broken node", () => {
    const n = channelStalenessNotice(neverSynced, true, NOW)!;
    expect(n.text).toMatch(/haven't synced/i);
    expect(n.text).not.toMatch(/last updated/i);
    expect(n.text).not.toBe(channelStalenessNotice(veryStale, true, NOW)!.text);
  });

  it("renders an age even when the timestamp is missing but the row reads stale", () => {
    const odd: ChannelFreshnessInput = {
      updated_at_ms: null,
      age_seconds: null,
      staleness: "very_stale",
    };
    expect(channelStalenessNotice(odd, false, NOW)!.text).toMatch(/an unknown time ago/);
  });

  // ⚠ Same guard as ./actionConfirm/confirmMachine.test.ts:153-154. On a member
  // node the farmer IS the node operator.
  it("never routes the farmer to a node operator", () => {
    const cases: Array<[ChannelFreshnessInput, boolean]> = [
      [stale, true], [stale, false],
      [veryStale, true], [veryStale, false],
      [fresh, false],
      [neverSynced, true],
    ];
    for (const [f, ok] of cases) {
      const text = channelStalenessNotice(f, ok, NOW)?.text ?? "";
      expect(text).not.toMatch(/ask your (node )?operator/i);
      expect(text).not.toMatch(/contact your (node )?operator/i);
      expect(text).not.toMatch(/your operator/i);
    }
  });
});
