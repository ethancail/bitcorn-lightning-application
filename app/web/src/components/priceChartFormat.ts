// Pure formatting + tick helpers for the Bitcoin Price chart
// (BitcoinPriceGraph.tsx). Extracted as a non-React module so the tick
// math and label formats are unit-testable in isolation (no Recharts /
// DOM import). See specs note: the y-axis "nice ticks" requirement and
// the 1y/5y x-axis year-disambiguation fix (v1.17.15).

export type Period = "24h" | "7d" | "30d" | "1y" | "5y";

const MS_PER_SEC = 1000;

/**
 * X-axis tick label per time range. The longer-span views must carry the
 * year explicitly: a 5y "Jun 21" reads as "June 21st" but means June
 * 2021, and a 1y month-only label is ambiguous across the year boundary.
 * Both use an apostrophe-year ("Jun '25") which Intl can't emit, so it's
 * built manually. Day-level views (24h/7d/30d) are already unambiguous.
 */
export function formatTimeLabel(unixSeconds: number, period: Period): string {
  const d = new Date(unixSeconds * MS_PER_SEC);
  switch (period) {
    case "24h":
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    case "7d":
      return d.toLocaleDateString("en-US", { weekday: "short" });
    case "30d":
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case "1y":
    case "5y": {
      const month = d.toLocaleDateString("en-US", { month: "short" });
      const yy = String(d.getFullYear()).slice(-2);
      return `${month} '${yy}`;
    }
  }
}

/**
 * Y-axis price label. Whole thousands render without a decimal ("$63k");
 * non-round thousands keep one decimal so tight-range ticks don't collide
 * ("$62.8k"); zero is "$0"; sub-$1k falls back to a plain dollar amount.
 */
export function formatAxisPrice(n: number): string {
  if (n === 0) return "$0";
  if (n < 1000) return `$${n.toFixed(0)}`;
  const k = n / 1000;
  return Number.isInteger(k) ? `$${k}k` : `$${k.toFixed(1)}k`;
}

// Smallest "nice" step (1 / 2 / 2.5 / 5 × 10ⁿ) that is >= x.
function niceStepCeil(x: number): number {
  if (x <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 2.5, 5]) {
    if (m * mag >= x - 1e-9) return m * mag;
  }
  return 10 * mag;
}

// Next nice step strictly above the given one (1→2→2.5→5→10×).
function bumpStep(step: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(step)));
  const n = step / mag; // ≈ 1, 2, 2.5, or 5
  if (n < 1.5) return 2 * mag;
  if (n < 2.25) return 2.5 * mag;
  if (n < 3.5) return 5 * mag;
  return 10 * mag;
}

// Kevin item 1: the domain is the data range plus this much on each side, so
// a day's movement fills the plot instead of floating on a coarse grid.
const AXIS_PAD = 0.08;
// The narrowest domain, as a fraction of the price: a flat (or near-flat)
// range still gets a readable axis, and its labels stay distinct ("$60.4k").
const MIN_SPAN = 0.005;

/**
 * K4a: neighbouring price labels sit at least this many label sizes apart
 * (73.9px at 1.0x text). The reference is the Power Law chart, which spaces
 * its labels 73px apart at its densest (the 2042 view) at 11px labels: 6.6
 * label sizes. In label sizes rather than px, so the spacing follows the
 * text-size setting the way the labels do.
 */
export const PRICE_LABEL_GAP_EM = 6.5;

/**
 * The price chart's y-axis: the domain it plots and the labelled ticks.
 * The domain is FITTED to the data (range plus AXIS_PAD each side, at least
 * MIN_SPAN wide, never below $0 for prices), not snapped out to round ticks:
 * snapping could widen it by up to a step on each end, and the line then
 * filled as little as 40% of the 120px plot.
 *
 * Labels are the round ticks (1 / 2 / 2.5 / 5 × 10ⁿ) that fall INSIDE the
 * domain: the finest round step that puts at most `maxTicks` inside, so
 * Recharts never has to drop a label, and whose labels are at least `minGap`
 * apart (a fraction of the domain, so of the axis's height; K4a). At least two
 * are always shown: if fewer fit, the step is halved, and the gap gives way.
 */
export function priceAxis(min: number, max: number, maxTicks = 4, minGap = 0): { domain: [number, number]; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { domain: [min, max], ticks: [] };
  const [lo, hi] = min < max ? [min, max] : [max, min];
  const pad = (hi - lo) * AXIS_PAD;
  let dLo = lo - pad;
  let dHi = hi + pad;
  const minSpan = Math.max(Math.abs(lo), Math.abs(hi)) * MIN_SPAN || 1;
  if (dHi - dLo < minSpan) {
    const mid = (lo + hi) / 2;
    dLo = mid - minSpan / 2;
    dHi = mid + minSpan / 2;
  }
  if (lo >= 0 && dLo < 0) dLo = 0;

  const cap = Math.max(2, maxTicks);
  const inside = (s: number) => Math.floor(dHi / s) - Math.ceil(dLo / s) + 1;
  // Any step under span / (cap + 1) puts more than `cap` labels inside, so the
  // search starts there (K4a: the finest step the cap allows) or at the gap.
  // A gap wider than the axis can only ever be met by the two-label fallback.
  const span = dHi - dLo;
  const gapStep = minGap > 0 ? span * Math.min(minGap, 1) : 0;
  let step = niceStepCeil(Math.max(span / (cap + 1), gapStep));
  for (let guard = 0; inside(step) > cap && guard < 24; guard++) step = bumpStep(step);
  for (let guard = 0; inside(step) < 2 && guard < 24; guard++) step /= 2;

  const ticks: number[] = [];
  for (let i = Math.ceil(dLo / step); i <= Math.floor(dHi / step); i++) ticks.push(i * step);
  // Halving can overshoot a tiny cap (1 label → 3) or close the gap; keep
  // every k-th, still uniform, and never fewer than two.
  const k = Math.max(1, Math.min(Math.max(Math.ceil(ticks.length / cap), Math.ceil(gapStep / step - 1e-9)), ticks.length - 1));
  return { domain: [dLo, dHi], ticks: ticks.filter((_, i) => i % k === 0) };
}

/**
 * How many evenly spaced axis labels fit across `available` px when the
 * widest label is `labelWidth` px and neighbours need `gap` px between them.
 * Round 1, X5: on a narrow screen the chart shows fewer time labels so they
 * never collide ("2:00 AM6:00 AM" at 390px in round 1). Clamped to
 * [min, max]; an unmeasured plot (no width yet) keeps `max`.
 */
export function fittingTickCount(
  available: number,
  labelWidth: number,
  gap: number,
  min = 2,
  max = 6,
): number {
  if (!(available > 0) || !(labelWidth > 0)) return max;
  const n = Math.floor((available + gap) / (labelWidth + gap));
  return Math.max(min, Math.min(max, n));
}

/** Recharts' default tick length: it offsets the time labels even with the tick line off. */
export const X_TICK_SIZE = 6;

/**
 * The x-axis band for a label font of `fontPx`: the margin under the axis
 * line and the band's height. PR 7: the lowest price label is centred on the
 * axis line, so its lower half hangs into this band; at the default 2px margin
 * the first time label sat on it (about 2px of overlap at 1.0x text, more at
 * 1.5x). The margin grows with the label size so the time labels start below
 * it, and the band grows to hold them; at 1.0x the band stays Recharts' 30px.
 */
export function xAxisBand(fontPx: number): { tickMargin: number; height: number } {
  const tickMargin = Math.max(2, Math.ceil(fontPx * 0.9) - 5);
  const height = Math.max(30, X_TICK_SIZE + tickMargin + Math.ceil(fontPx * 1.25));
  return { tickMargin, height };
}
