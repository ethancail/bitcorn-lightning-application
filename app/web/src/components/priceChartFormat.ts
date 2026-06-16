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

/**
 * "Nice numbers" y-axis tick generator with a GUARANTEED maximum count.
 * Returns evenly-spaced ticks on a round interval (1 / 2 / 2.5 / 5 × 10ⁿ)
 * bracketing [min, max], with at most `maxTicks` of them. The chart snaps
 * its domain to [first, last] and renders these as the y-axis ticks, so
 * the axis shows round numbers while still zooming to the data, and the
 * interval adapts to the price scale automatically.
 *
 * The cap matters: snapping the domain to the grid (floor/ceil) can widen
 * the range by up to one step on each end, so a naive "target N" can emit
 * N+1 or N+2 ticks. On the 120px panel chart that overflows the plot area
 * and Recharts then drops labels at irregular positions — reproducing the
 * very "irregular spacing" this fixes. So we bump to the next nice step
 * until the count fits, guaranteeing every tick has room to render.
 */
export function niceTicks(min: number, max: number, maxTicks = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    return [min];
  }
  const [lo, hi] = min < max ? [min, max] : [max, min];
  const cap = Math.max(2, maxTicks);
  const tickCount = (s: number) => Math.ceil(hi / s) - Math.floor(lo / s) + 1;

  let step = niceStepCeil((hi - lo) / cap);
  for (let guard = 0; tickCount(step) > cap && guard < 24; guard++) {
    step = bumpStep(step);
  }

  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const n = Math.round((niceMax - niceMin) / step);
  const ticks: number[] = [];
  for (let i = 0; i <= n; i++) {
    // Snap each tick to the step grid to clear accumulated fp error.
    ticks.push(Math.round((niceMin + i * step) / step) * step);
  }
  return ticks;
}
