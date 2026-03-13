import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { format, parseISO } from "date-fns";
import powerLawData from "../data/power-law-data.json";

// ─── Types ───────────────────────────────────────────────────────────────

type MAPeriod = "1M" | "1Y" | "5Y" | "10Y";

type RawDataPoint = {
  date: string;
  btc: number | null;
  trend: number;
  p2_5: number;
  p16_5: number;
  p83_5: number;
  p97_5: number;
};

type ChartPoint = {
  date: string;
  ts: number;
  btc: number | null;
  ma50: number | null;
  ma100: number | null;
  ma200: number | null;
};

interface MovingAveragesChartProps {
  period: MAPeriod;
  currentPrice: number;
  historicPrices: Map<string, number>;
}

// ─── Constants ───────────────────────────────────────────────────────────

const COLORS = {
  btc: "#f59e0b",
  ma50: "#06b6d4",
  ma100: "#a78bfa",
  ma200: "#22c55e",
};

const LABELS: Record<string, string> = {
  btc: "BTC Price",
  ma50: "50-day MA",
  ma100: "100-day MA",
  ma200: "200-day MA",
};

const BG_2 = "#17171e";
const BORDER = "#2a2a38";
const TEXT_3 = "#5a5a70";
const TEXT = "#e8e8f0";
const MONO = "'IBM Plex Mono', monospace";

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatPrice(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getDateRange(period: MAPeriod): { start: string; end: string } {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const start = new Date(today);
  switch (period) {
    case "1M":
      start.setDate(start.getDate() - 30);
      break;
    case "1Y":
      start.setFullYear(start.getFullYear() - 1);
      break;
    case "5Y":
      start.setFullYear(start.getFullYear() - 5);
      break;
    case "10Y":
      start.setFullYear(start.getFullYear() - 10);
      break;
  }
  return { start: start.toISOString().slice(0, 10), end: todayStr };
}

export function computeMA(prices: (number | null)[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(prices.length).fill(null);
  let sum = 0;
  let count = 0;

  for (let i = 0; i < prices.length; i++) {
    if (prices[i] != null) {
      sum += prices[i]!;
      count++;
    }
    if (i >= window) {
      if (prices[i - window] != null) {
        sum -= prices[i - window]!;
        count--;
      }
    }
    if (count >= window) {
      result[i] = sum / window;
    }
  }
  return result;
}

function downsample(data: ChartPoint[]): ChartPoint[] {
  const len = data.length;
  if (len <= 400) return data;
  // Keep every 7th point, always keep last 90 days and endpoints
  const last90 = len > 90 ? data[len - 90].ts : 0;
  const result: ChartPoint[] = [];
  for (let i = 0; i < len; i++) {
    if (i % 7 === 0 || data[i].ts >= last90 || i === len - 1) {
      result.push(data[i]);
    }
  }
  return result;
}

// ─── Custom Tooltip ──────────────────────────────────────────────────────

function MATooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number | null; color: string }>;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as ChartPoint | undefined;
  if (!point) return null;

  return (
    <div
      style={{
        background: BG_2,
        border: `1px solid ${BORDER}`,
        borderRadius: 6,
        padding: "10px 14px",
        fontFamily: MONO,
        fontSize: "0.75rem",
      }}
    >
      <div style={{ color: TEXT_3, marginBottom: 6 }}>
        {format(parseISO(point.date), "MMMM d, yyyy")}
      </div>
      {payload.map((entry) => {
        if (entry.value == null) return null;
        const label = LABELS[entry.dataKey] ?? entry.dataKey;
        return (
          <div
            key={entry.dataKey}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 16,
              marginBottom: 2,
            }}
          >
            <span style={{ color: entry.color }}>{label}</span>
            <span style={{ color: TEXT, fontWeight: 500 }}>
              {formatUsd(entry.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────

export default function MovingAveragesChart({ period, currentPrice, historicPrices }: MovingAveragesChartProps) {
  const chartData = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10);
    const { start, end } = getDateRange(period);

    // Build full price array (fill gap days with historic API prices, fall back to spot)
    const allData = (powerLawData as RawDataPoint[])
      .filter((d) => d.date <= end)
      .map((d) => ({
        date: d.date,
        btc: d.btc != null
          ? d.btc
          : d.date <= todayStr
            ? historicPrices.get(d.date) ?? (currentPrice > 0 ? currentPrice : null)
            : null,
      }));

    // Extract prices for MA computation
    const prices = allData.map((d) => d.btc);
    const ma50 = computeMA(prices, 50);
    const ma100 = computeMA(prices, 100);
    const ma200 = computeMA(prices, 200);

    // Combine and filter to visible range
    const points: ChartPoint[] = allData
      .map((d, i) => ({
        date: d.date,
        ts: parseISO(d.date).getTime(),
        btc: d.btc,
        ma50: ma50[i],
        ma100: ma100[i],
        ma200: ma200[i],
      }))
      .filter((d) => d.date >= start && d.date <= end);

    return downsample(points);
  }, [period, currentPrice, historicPrices]);

  // Y domain from visible data
  const allValues = chartData
    .flatMap((d) => [d.btc, d.ma50, d.ma100, d.ma200])
    .filter((v): v is number => v != null && v > 0);

  const yMin = Math.min(...allValues) * 0.95;
  const yMax = Math.max(...allValues) * 1.05;

  // X axis ticks — aligned to boundaries
  const xTicks = useMemo(() => {
    if (chartData.length === 0) return [];
    const first = chartData[0].ts;
    const last = chartData[chartData.length - 1].ts;
    const ticks: number[] = [];

    if (period === "1M") {
      // Weekly ticks
      const d = new Date(first);
      d.setDate(d.getDate() + (7 - d.getDay()) % 7); // next Sunday
      while (d.getTime() <= last) {
        ticks.push(d.getTime());
        d.setDate(d.getDate() + 7);
      }
    } else if (period === "1Y") {
      // Monthly ticks — every 2 months
      const d = new Date(first);
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      while (d.getTime() <= last) {
        ticks.push(d.getTime());
        d.setMonth(d.getMonth() + 2);
      }
    } else {
      // Yearly ticks
      const startYear = new Date(first).getFullYear();
      const endYear = new Date(last).getFullYear();
      const span = endYear - startYear;
      const step = span <= 6 ? 1 : span <= 15 ? 2 : 5;
      const firstTick = Math.ceil(startYear / step) * step;
      for (let y = firstTick; y <= endYear; y += step) {
        const t = new Date(y, 0, 1).getTime();
        if (t >= first && t <= last) ticks.push(t);
      }
    }
    return ticks;
  }, [chartData, period]);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={BORDER} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          domain={["dataMin", "dataMax"]}
          ticks={xTicks}
          tickFormatter={(ts: number) => {
            const d = new Date(ts);
            if (period === "1M") {
              return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
            }
            if (period === "1Y") {
              return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
            }
            return d.getFullYear().toString();
          }}
          axisLine={{ stroke: BORDER }}
          tickLine={false}
          tick={{ fill: TEXT_3, fontFamily: MONO, fontSize: 11 }}
        />
        <YAxis
          domain={[yMin, yMax]}
          tickFormatter={formatPrice}
          axisLine={false}
          tickLine={false}
          tick={{ fill: TEXT_3, fontFamily: MONO, fontSize: 11 }}
          width={60}
        />
        <Tooltip content={<MATooltip />} />

        {/* 200-day MA (green, behind) */}
        <Line
          type="monotone"
          dataKey="ma200"
          stroke={COLORS.ma200}
          strokeWidth={1.5}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        {/* 100-day MA (purple) */}
        <Line
          type="monotone"
          dataKey="ma100"
          stroke={COLORS.ma100}
          strokeWidth={1.5}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        {/* 50-day MA (cyan) */}
        <Line
          type="monotone"
          dataKey="ma50"
          stroke={COLORS.ma50}
          strokeWidth={1.5}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        {/* BTC Price (amber, on top) */}
        <Line
          type="monotone"
          dataKey="btc"
          stroke={COLORS.btc}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3, fill: COLORS.btc, stroke: "#0a0a0c", strokeWidth: 2 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
