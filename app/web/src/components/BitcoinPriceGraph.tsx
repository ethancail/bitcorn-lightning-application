import { useState, useEffect, useCallback } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ─── Types ───────────────────────────────────────────────────────────────

type Period = "24h" | "7d" | "30d" | "1y" | "5y";

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
const MONO = "'IBM Plex Mono', monospace";

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatAxisPrice(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function formatTimeLabel(unixSeconds: number, period: Period): string {
  const d = new Date(unixSeconds * 1000);
  switch (period) {
    case "24h":
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    case "7d":
      return d.toLocaleDateString("en-US", { weekday: "short" });
    case "30d":
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case "1y":
      return d.toLocaleDateString("en-US", { month: "short" });
    case "5y":
      return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  }
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
        fontFamily: MONO,
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

// ─── Component ───────────────────────────────────────────────────────────

export default function BitcoinPriceGraph() {
  const [period, setPeriod] = useState<Period>("24h");
  const [spot, setSpot] = useState<number | null>(null);
  const [data, setData] = useState<PricePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

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

  // Y axis domain with 2% padding
  const prices = data.map((d) => d.price);
  const yMin = prices.length ? Math.min(...prices) : 0;
  const yMax = prices.length ? Math.max(...prices) : 0;
  const yPad = (yMax - yMin) * 0.02 || 100;

  const xTicks = sampleTicks(data, 6);

  return (
    <div className="panel fade-in" style={{ marginBottom: 16 }}>
      {/* Header */}
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">₿</span>Bitcoin Price
        </span>
        <div style={{ display: "flex", gap: 4 }}>
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
            <div style={{ marginBottom: 20 }}>
              <div
                style={{
                  fontFamily: MONO,
                  fontSize: "2rem",
                  fontWeight: 600,
                  color: TEXT,
                  lineHeight: 1.2,
                }}
              >
                {spot != null ? formatUsd(spot) : "—"}
              </div>
              {changeAmt != null && changePct != null && (
                <div
                  style={{
                    fontFamily: MONO,
                    fontSize: "0.875rem",
                    fontWeight: 500,
                    color: isPositive ? GREEN : RED,
                    marginTop: 4,
                  }}
                >
                  {isPositive ? "+" : ""}
                  {formatUsd(changeAmt)}{" "}
                  ({isPositive ? "+" : ""}
                  {changePct.toFixed(2)}%)
                  <span style={{ color: TEXT_3, fontWeight: 400, marginLeft: 8 }}>
                    {period}
                  </span>
                </div>
              )}
            </div>

            {/* Chart */}
            <ResponsiveContainer width="100%" height={220}>
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
                  tickFormatter={(t: number) => formatTimeLabel(t, period)}
                  axisLine={{ stroke: BORDER }}
                  tickLine={false}
                  tick={{ fill: TEXT_3, fontFamily: MONO, fontSize: 11 }}
                />
                <YAxis
                  domain={[yMin - yPad, yMax + yPad]}
                  tickFormatter={formatAxisPrice}
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: TEXT_3, fontFamily: MONO, fontSize: 11 }}
                  width={54}
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
          </>
        )}
      </div>
    </div>
  );
}
