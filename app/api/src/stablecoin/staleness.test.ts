import { describe, expect, it } from "vitest";
import {
    RAIL_STALE_THRESHOLD_MS,
    RAIL_VERY_STALE_THRESHOLD_MS,
    classifyRailStaleness,
    railStalenessSeconds,
} from "./staleness";

const NOW = 1_750_000_000_000;

describe("railStalenessSeconds", () => {
    it("returns 0 when asOfAt equals now", () => {
        expect(railStalenessSeconds(NOW, NOW)).toBe(0);
    });
    it("returns elapsed seconds for past timestamps", () => {
        expect(railStalenessSeconds(NOW - 60_000, NOW)).toBe(60);
        expect(railStalenessSeconds(NOW - 180_000, NOW)).toBe(180);
    });
    it("returns 0 for future timestamps (clock skew defense)", () => {
        expect(railStalenessSeconds(NOW + 60_000, NOW)).toBe(0);
    });
    it("returns 0 for non-finite inputs", () => {
        expect(railStalenessSeconds(NaN, NOW)).toBe(0);
        expect(railStalenessSeconds(NOW, Infinity)).toBe(0);
    });
});

describe("classifyRailStaleness — spec amendment §7 thresholds (3min / 15min)", () => {
    it("returns fresh below the 3-minute threshold", () => {
        expect(classifyRailStaleness(NOW, NOW)).toBe("fresh");
        expect(classifyRailStaleness(NOW - 60_000, NOW)).toBe("fresh");
        expect(classifyRailStaleness(NOW - RAIL_STALE_THRESHOLD_MS + 1, NOW)).toBe("fresh");
    });
    it("returns stale at exactly 3 minutes (the spec amendment's lower edge)", () => {
        expect(classifyRailStaleness(NOW - RAIL_STALE_THRESHOLD_MS, NOW)).toBe("stale");
    });
    it("returns stale between 3 and 15 minutes", () => {
        expect(classifyRailStaleness(NOW - 5 * 60_000, NOW)).toBe("stale");
        expect(classifyRailStaleness(NOW - 10 * 60_000, NOW)).toBe("stale");
    });
    it("returns very_stale at exactly 15 minutes (the spec amendment's upper edge)", () => {
        expect(classifyRailStaleness(NOW - RAIL_VERY_STALE_THRESHOLD_MS, NOW)).toBe("very_stale");
    });
    it("returns very_stale above 15 minutes", () => {
        expect(classifyRailStaleness(NOW - 30 * 60_000, NOW)).toBe("very_stale");
        expect(classifyRailStaleness(NOW - 60 * 60_000, NOW)).toBe("very_stale");
    });
});

describe("classifyRailStaleness — never_synced is a distinct state, not extreme staleness", () => {
    // THE BUG THIS PINS. base_sync_cursor seeds at (0, 0), so a node whose sync
    // loop has never recorded a success carried asOfAt = 0. `NOW - 0` is a
    // finite ~1.78e12 ms, so no NaN guard caught it: it classified as very_stale
    // and the banner rendered "Settlement data is significantly out of date
    // (cursor age: 29,758,925 min)" in prominent red.
    //
    // That fires on a HEALTHY node with no BASE wallet registered — sync.ts
    // returns `no_wallets` before contacting the Worker, so the cursor never
    // moves. Which is every subscriber on release day.

    it("classifies the 0 sentinel as never_synced, NOT very_stale", () => {
        expect(classifyRailStaleness(0, NOW)).toBe("never_synced");
        expect(classifyRailStaleness(0, NOW)).not.toBe("very_stale");
    });

    it("reports no age for a never-synced cursor instead of ~56 years", () => {
        // The absurd number that reached the banner. Asserting 0 exactly, and
        // additionally asserting it isn't the old value, so a regression that
        // reinstates the epoch arithmetic fails loudly rather than drifting.
        expect(railStalenessSeconds(0, NOW)).toBe(0);
        expect(railStalenessSeconds(0, NOW)).not.toBe(Math.floor(NOW / 1000));
    });

    it("treats negative timestamps as never_synced too", () => {
        // Defensive: any non-positive value is a sentinel, not a real instant.
        expect(classifyRailStaleness(-1, NOW)).toBe("never_synced");
        expect(railStalenessSeconds(-1, NOW)).toBe(0);
    });

    it("a real timestamp 1ms after the epoch is NOT never_synced", () => {
        // Boundary in the other direction: the sentinel must be 0-or-below only,
        // so a genuine (if absurdly old) timestamp still classifies by age. This
        // is what keeps the sentinel check from swallowing real data.
        expect(classifyRailStaleness(1, NOW)).toBe("very_stale");
        expect(railStalenessSeconds(1, NOW)).toBeGreaterThan(0);
    });

    it("never_synced does not depend on `now` — it is not an age at all", () => {
        expect(classifyRailStaleness(0, NOW)).toBe("never_synced");
        expect(classifyRailStaleness(0, NOW + 10 * 365 * 86_400_000)).toBe("never_synced");
        expect(classifyRailStaleness(0, 0)).toBe("never_synced");
    });
});
