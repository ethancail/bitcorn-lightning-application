import { useState, useEffect, useCallback } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import {
  niceTicks,
  formatAxisPrice,
  formatTimeLabel,
  fittingTickCount,
  type Period,
} from "./priceChartFormat";

// ─── Types ───────────────────────────────────────────────────────────────

type PricePoint = {
  time: number;
  price: number;
  label: string;
};

type CoinbaseHistoricResponse = {
  data: {
    prices: Array<{ price: string; time: string }>;
  };
};

type CoinbaseSpotResponse = {
  data: { amount: string; base: string; currency: string };
};

// ─── Constants ───────────────────────────────────────────────────────────

const COINBASE_BASE = "https://api.coinbase.com/v2/prices/BTC-USD";

const PERIOD_MAP: Record<Period, string> = {
  "24h": "day",
  "7d": "week",
  "30d": "month",
  "1y": "year",
  "5y": "all",
};

const PERIODS: Period[] = ["24h", "7d", "30d", "1y", "5y"];

const REFRESH_MS = 60_000;

// Colors from styles.css (can't use CSS vars in SVG attributes)
const AMBER = "#f59e0b";
const GREEN = "#22c55e";
const RED = "#ef4444";
const TEXT = "#e8e8f0";
const TEXT_3 = "#5a5a70";
const BG_2 = "#17171e";
const BORDER = "#2a2a38";
const BORDER_HI = "#3a3a50";
const getMono = () => getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "sans-serif";

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTooltipTime(unixSeconds: number, period: Period): string {
  const d = new Date(unixSeconds * 1000);
  if (period === "24h") {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  }
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: period === "1y" || period === "5y" ? "numeric" : undefined,
  });
}

// ─── Data Fetching ───────────────────────────────────────────────────────

async function fetchSpotPrice(): Promise<number> {
  const res = await fetch(`${COINBASE_BASE}/spot`);
  if (!res.ok) throw new Error("Spot price fetch failed");
  const json: CoinbaseSpotResponse = await res.json();
  return parseFloat(json.data.amount);
}

async function fetchHistoricPrices(period: Period): Promise<PricePoint[]> {
  const res = await fetch(`${COINBASE_BASE}/historic?period=${PERIOD_MAP[period]}`);
  if (!res.ok) throw new Error("Historic prices fetch failed");
  const json: CoinbaseHistoricResponse = await res.json();
  const fiveYearsAgo = Math.floor(Date.now() / 1000) - 5 * 365.25 * 86400;
  return json.data.prices
    .map((p) => ({
      time: parseInt(p.time, 10),
      price: parseFloat(p.price),
      label: formatTimeLabel(parseInt(p.time, 10), period),
    }))
    .filter((p) => period !== "5y" || p.time >= fiveYearsAgo)
    .sort((a, b) => a.time - b.time);
}

// ─── Custom Tooltip ──────────────────────────────────────────────────────

function PriceTooltip({
  active,
  payload,
  period,
}: {
  active?: boolean;
  payload?: Array<{ payload: PricePoint }>;
  period: Period;
}) {
  if (!active || !payload?.length) return null;
  const pt = payload[0].payload;
  return (
    <div
      style={{
        background: BG_2,
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        padding: "8px 12px",
        fontFamily: getMono(),
        fontSize: "0.75rem",
      }}
    >
      <div style={{ color: TEXT, fontWeight: 600 }}>{formatUsd(pt.price)}</div>
      <div style={{ color: TEXT_3, marginTop: 2 }}>{formatTooltipTime(pt.time, period)}</div>
    </div>
  );
}

// ─── Tick Sampling ───────────────────────────────────────────────────────

function sampleTicks(data: PricePoint[], maxTicks: number): number[] {
  if (data.length <= maxTicks) return data.map((d) => d.time);
  const step = Math.ceil(data.length / maxTicks);
  const ticks: number[] = [];
  for (let i = 0; i < data.length; i += step) {
    ticks.push(data[i].time);
  }
  return ticks;
}

// ─── Plot measurement (round 1, X5) ─────────────────────────────────────
// The plot measures its own box and the label font size the stylesheet
// gives it (.price-plot { font-size: var(--d-label) }), and the axes are
// fitted to that: time labels never collide on a narrow screen, and axis
// labels follow the density block's label size (X2) instead of a fixed 11px.

type PlotBox = { width: number; height: number; fontPx: number };

function usePlotBox() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [box, setBox] = useState<PlotBox | null>(null);
  useEffect(() => {
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const fontPx = parseFloat(getComputedStyle(el).fontSize) || 11;
      setBox((prev) =>
        prev && prev.width === r.width && prev.height === r.height && prev.fontPx === fontPx
          ? prev
          : { width: r.width, height: r.height, fontPx },
      );
    };
    read();
    // Widths are measured in the app's font (--mono follows it, Z2); re-read
    // once it has loaded.
    document.fonts?.ready.then(read).catch(() => {});
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, box] as const;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string, fontPx: number, family: string): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
  }
  if (!measureCtx) return text.length * fontPx * 0.62; // tabular-digit advance, approx.
  measureCtx.font = `${fontPx}px ${family}`;
  return measureCtx.measureText(text).width;
}

// Recharts' default x-axis band and the AreaChart margins below.
const X_AXIS_H = 30;
const PLOT_MARGIN_X = 8;

// ─── Component ───────────────────────────────────────────────────────────

export default function BitcoinPriceGraph() {
  const [period, setPeriod] = useState<Period>("24h");
  const [spot, setSpot] = useState<number | null>(null);
  const [data, setData] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [plotRef, plot] = usePlotBox();

  const load = useCallback(async () => {
    try {
      const [spotPrice, historic] = await Promise.all([
        fetchSpotPrice(),
        fetchHistoricPrices(period),
      ]);
      setSpot(spotPrice);
      setData(historic);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  // Price change calculation
  const oldest = data.length > 0 ? data[0].price : null;
  const changeAmt = spot != null && oldest != null ? spot - oldest : null;
  const changePct =
    changeAmt != null && oldest != null && oldest !== 0
      ? (changeAmt / oldest) * 100
      : null;
  const isPositive = changeAmt != null && changeAmt >= 0;

  // Y axis: round "nice" ticks bracketing the data range, with the domain
  // snapped to those ticks so the axis shows clean numbers (e.g. $0/$50k/
  // $100k/$150k) while still zooming to the data. The interval adapts to
  // the price scale automatically (see priceChartFormat.niceTicks).
  const prices = data.map((d) => d.price);
  const yMin = prices.length ? Math.min(...prices) : 0;
  const yMax = prices.length ? Math.max(...prices) : 0;
  // X5a: as many y-ticks as fit the plot's height (one label line plus half
  // a line between labels, at most 5), so the price axis takes the finest
  // round step that still labels cleanly and a day's movement fills the plot
  // instead of a flat line on a coarse grid. niceTicks never exceeds the
  // target it is given, so Recharts never has to hide a label.
  const fontPx = plot?.fontPx ?? 11;
  const family = getMono();
  const yTarget = plot
    ? fittingTickCount(plot.height - X_AXIS_H, fontPx * 1.2, fontPx * 0.5, 2, 5)
    : 4;
  const yTicks = niceTicks(yMin, yMax, yTarget);
  const yDomain: [number, number] = [yTicks[0], yTicks[yTicks.length - 1]];
  const yAxisWidth = plot
    ? Math.ceil(Math.max(...yTicks.map((t) => textWidth(formatAxisPrice(t), fontPx, family))) + fontPx)
    : 54;

  // X5: as many time labels as fit the measured width without colliding
  // (at most 6, at least 2), measured against the widest candidate label.
  const candidates = sampleTicks(data, 6);
  const labelWidth = plot
    ? Math.max(0, ...candidates.map((t) => textWidth(formatTimeLabel(t, period), fontPx, family)))
    : 0;
  const xCount = plot
    ? fittingTickCount(plot.width - yAxisWidth - PLOT_MARGIN_X, labelWidth, fontPx * 1.5, 2, 6)
    : 6;
  const xTicks = sampleTicks(data, xCount);

  return (
    <div className="panel fade-in price-tile">
      {/* Header */}
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">₿</span>Bitcoin Price
        </span>
        <div className="btn-group-tight">
          {PERIODS.map((p) => (
            <button
              key={p}
              className={`btn btn-sm ${p === period ? "btn-primary" : "btn-outline"}`}
              onClick={() => setPeriod(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      <div className="panel-body">
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="loading-shimmer" style={{ height: 40, width: "50%" }} />
            <div className="loading-shimmer" style={{ height: 20, width: "30%" }} />
            <div className="loading-shimmer" style={{ height: 200 }} />
          </div>
        ) : error ? (
          <div className="error-state">Price data unavailable</div>
        ) : (
          <>
            {/* Spot price + change */}
            {/* The price supports (TASTE A14): sized below the headline
                numbers by the density block's --d-price. */}
            <div className="price-head">
              <div className="price-spot">
                {spot != null ? formatUsd(spot) : "—"}
              </div>
              {changeAmt != null && changePct != null && (
                <div className="price-change" style={{ color: isPositive ? GREEN : RED }}>
                  {isPositive ? "+" : ""}
                  {formatUsd(changeAmt)}{" "}
                  ({isPositive ? "+" : ""}
                  {changePct.toFixed(2)}%)
                  <span className="price-change-period">{period}</span>
                </div>
              )}
            </div>

            {/* Chart */}
            <div className="price-plot" ref={plotRef}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="amberFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={AMBER} stopOpacity={0.15} />
                    <stop offset="100%" stopColor={AMBER} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="time"
                  ticks={xTicks}
                  interval={0}
                  tickFormatter={(t: number) => formatTimeLabel(t, period)}
                  axisLine={{ stroke: BORDER }}
                  tickLine={false}
                  tick={{ fill: TEXT_3, fontFamily: family, fontSize: fontPx }}
                />
                <YAxis
                  domain={yDomain}
                  ticks={yTicks}
                  tickFormatter={formatAxisPrice}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: TEXT_3, fontFamily: family, fontSize: fontPx }}
                  width={yAxisWidth}
                />
                <Tooltip
                  content={<PriceTooltip period={period} />}
                  cursor={{ stroke: BORDER_HI, strokeDasharray: "4 4" }}
                />
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke={AMBER}
                  strokeWidth={2}
                  fill="url(#amberFill)"
                  dot={false}
                  activeDot={{
                    r: 4,
                    fill: AMBER,
                    stroke: "#0a0a0c",
                    strokeWidth: 2,
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
