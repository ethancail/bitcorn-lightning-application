import { describe, expect, it } from "vitest";
import {
    STALE_THRESHOLD_MS,
    VERY_STALE_THRESHOLD_MS,
    classifyStaleness,
    isStaleByThreshold,
    stalenessSecondsForBalance,
} from "./staleness";

const NOW = 1_716_400_000_000; // arbitrary fixed timestamp for determinism

describe("stalenessSecondsForBalance", () => {
    it("returns 0 when as_of_at == now", () => {
        expect(stalenessSecondsForBalance(NOW, NOW)).toBe(0);
    });

    it("returns elapsed seconds for past as_of_at", () => {
        expect(stalenessSecondsForBalance(NOW - 60_000, NOW)).toBe(60);
        expect(stalenessSecondsForBalance(NOW - 300_000, NOW)).toBe(300);
    });

    it("returns 0 for future as_of_at (clock skew)", () => {
        expect(stalenessSecondsForBalance(NOW + 60_000, NOW)).toBe(0);
    });

    it("returns 0 for NaN or Infinity inputs (defensive)", () => {
        expect(stalenessSecondsForBalance(NaN, NOW)).toBe(0);
        expect(stalenessSecondsForBalance(NOW, NaN)).toBe(0);
        expect(stalenessSecondsForBalance(Infinity, NOW)).toBe(0);
    });
});

describe("isStaleByThreshold", () => {
    it("is false just below the threshold", () => {
        expect(isStaleByThreshold(NOW - STALE_THRESHOLD_MS + 1, NOW)).toBe(false);
    });

    it("is true at exactly the threshold", () => {
        expect(isStaleByThreshold(NOW - STALE_THRESHOLD_MS, NOW)).toBe(true);
    });

    it("respects custom threshold", () => {
        expect(isStaleByThreshold(NOW - 30_000, NOW, 60_000)).toBe(false);
        expect(isStaleByThreshold(NOW - 60_000, NOW, 60_000)).toBe(true);
    });
});

describe("classifyStaleness", () => {
    it("returns fresh below the stale threshold", () => {
        expect(classifyStaleness(NOW - 60_000, NOW)).toBe("fresh");
        expect(classifyStaleness(NOW, NOW)).toBe("fresh");
    });

    it("returns stale between the two thresholds", () => {
        expect(classifyStaleness(NOW - STALE_THRESHOLD_MS, NOW)).toBe("stale");
        expect(classifyStaleness(NOW - 10 * 60_000, NOW)).toBe("stale");
    });

    it("returns very_stale at or above the second threshold", () => {
        expect(classifyStaleness(NOW - VERY_STALE_THRESHOLD_MS, NOW)).toBe("very_stale");
        expect(classifyStaleness(NOW - 60 * 60_000, NOW)).toBe("very_stale");
    });
});
