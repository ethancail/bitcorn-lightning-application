// Test 46, FORBIDDING half — spec §3.4.3; binding consequence of decisions/
// 2026-09-25-daybreak-no-third-table-scope-valuation-zones-not-power-law-bands.md:
// "the web app contains NO band boundaries or labels. It renders only the
// stamped table." The permitting half (a recalibrated stamped table renders
// correctly) is in ../pages/Daybreak.test.tsx.
//
// A source scan of app/web/src, tests excluded. Two things are looked for:
//   1. a band-shaped literal — `lower:` or `upper:` followed by a number or
//      null, the shape a hardcoded table (or a "default" to fall back on) takes;
//   2. band labels from Kevin's spec as the vault quotes them (§4.2, §7).
// Both carry anti-vacuity: each pattern is shown matching a probe, and the file
// walk is shown to reach the Daybreak gauge itself.
//
// Excluded: components/autoBuy/, another arc's VALUATION composite zones — a
// different number, and not this arc's to scan or change (spec §6).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

// A KEY `lower:` / `upper:` — not a property read ending a ternary (`x.lower : null`).
const BAND_SHAPE = /(?<![.\w])(lower|upper)\s*:\s*(-?\d|null\b)/;
const KEVIN_LABELS = /Steady Accumulation|Accumulate Aggressively|historically rare/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = relative(SRC, full).split("\\").join("/");
    if (rel === "components/autoBuy") return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [full];
  });
}

const FILES = sourceFiles(SRC);
const rel = (f: string) => relative(SRC, f).split("\\").join("/");

describe("test 46 forbidding: the web app holds no band table", () => {
  it("anti-vacuity: the walk reaches the Daybreak screen's own files", () => {
    const names = FILES.map(rel);
    expect(names).toContain("daybreak/DaybreakGauge.tsx");
    expect(names).toContain("daybreak/daybreakView.ts");
    expect(names).toContain("pages/Daybreak.tsx");
    expect(names.some((n) => n.startsWith("components/autoBuy/"))).toBe(false);
  });

  it("anti-vacuity: each pattern matches the thing it is meant to catch", () => {
    expect(BAND_SHAPE.test(`const BANDS = [{ lower: null, upper: -1, label: "x" }]`)).toBe(true);
    expect(BAND_SHAPE.test(`{ lower: -1.0, upper: 0 }`)).toBe(true);
    expect(KEVIN_LABELS.test(`label: "Steady Accumulation"`)).toBe(true);
    // …and not the type declarations and property reads the screen needs.
    expect(BAND_SHAPE.test(`lower: number | null;`)).toBe(false);
    expect(BAND_SHAPE.test(`{ lower: b.lower, upper: b.upper }`)).toBe(false);
    expect(BAND_SHAPE.test(`const span = ok ? b.upper - b.lower : null;`)).toBe(false);
    expect(BAND_SHAPE.test(`{lower:0,upper:1}`)).toBe(true); // no spaces is still a table
  });

  it("forbidding: no source file carries a band-shaped literal", () => {
    const hits = FILES.flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => [line, i] as const)
        .filter(([line]) => BAND_SHAPE.test(line))
        .map(([line, i]) => `${rel(f)}:${i + 1}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it("forbidding: no source file carries a band label from Kevin's spec", () => {
    const hits = FILES.filter((f) => KEVIN_LABELS.test(readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual([]);
  });
});
