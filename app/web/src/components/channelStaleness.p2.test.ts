// drive-mode P2 item 9 (R6(c)): the plain-sentence pass on the LND banner.
// The member's word for LND is the app they installed and restart, "the
// Lightning app" — which the restart step already says; "Lightning service"
// named something they never see. The restart step is unchanged, word for
// word.

import { describe, it, expect } from "vitest";
import { channelStalenessNotice } from "./channelStaleness";

const NOW = 1_790_000_000_000;
const MIN = 60_000;
const fresh = { updated_at_ms: NOW - MIN, age_seconds: 60, staleness: "fresh" as const };
const veryStale = { updated_at_ms: NOW - 120 * MIN, age_seconds: 7_200, staleness: "very_stale" as const };

const STEP = "If this doesn't clear on its own in a few minutes, restarting the Lightning app usually restores it.";

describe("the LND banner, in the member's words", () => {
  it("old figures, LND not responding: the Lightning app, and the restart step verbatim", () => {
    const text = channelStalenessNotice(veryStale, false, NOW)!.text;
    expect(text).toContain("Your node's Lightning app isn't responding, so these figures are the last ones recorded, not current ones.");
    expect(text).toContain(STEP);
    expect(text).not.toMatch(/Lightning service/);
  });

  it("fresh figures, a live read failed: the Lightning app", () => {
    const text = channelStalenessNotice(fresh, false, NOW)!.text;
    expect(text).toMatch(/^Your node's Lightning app didn't respond just now\./);
    expect(text).not.toMatch(/Lightning service/);
  });
});
