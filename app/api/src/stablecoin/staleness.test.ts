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
