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

/**
 * "Nice numbers" tick generator (Heckbert): given a data [min, max] and a
 * target tick count, returns evenly-spaced ticks on a round interval
 * (1 / 2 / 2.5 / 5 × 10ⁿ) bracketing the range. The chart snaps its
 * domain to [first, last] and renders these as the y-axis ticks, so the
 * axis shows round numbers while still zooming to the data — and the
 * interval adapts automatically as the price scale changes.
 */
export function niceTicks(min: number, max: number, targetCount = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [min];
  }
  const [lo, hi] = min < max ? [min, max] : [max, min];
  const range = hi - lo;
  const rawStep = range / Math.max(1, targetCount - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let niceStep: number;
  if (norm <= 1) niceStep = 1;
  else if (norm <= 2) niceStep = 2;
  else if (norm <= 2.5) niceStep = 2.5;
  else if (norm <= 5) niceStep = 5;
  else niceStep = 10;
  niceStep *= mag;

  const niceMin = Math.floor(lo / niceStep) * niceStep;
  const niceMax = Math.ceil(hi / niceStep) * niceStep;
  const ticks: number[] = [];
  // Half-step slop guards against floating-point drift on the last tick.
  for (let t = niceMin; t <= niceMax + niceStep * 0.5; t += niceStep) {
    // Snap each tick to the step grid to clear accumulated fp error.
    ticks.push(Math.round(t / niceStep) * niceStep);
  }
  return ticks;
}
