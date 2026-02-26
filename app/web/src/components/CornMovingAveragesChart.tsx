import { useMemo, useState, useEffect } from "react";
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
import { api, type CornHistoryEntry } from "../api/client";
import { computeMA } from "./MovingAveragesChart";
import { interpolateCornPrices } from "./CornBitcoinChart";

// ─── Types ───────────────────────────────────────────────────────────────

type CMAPeriod = "1M" | "1Y" | "5Y" | "10Y";

type ChartPoint = {
  date: string;
  ts: number;
  corn: number | null;
  ma50: number | null;
  ma100: number | null;
  ma200: number | null;
};

interface CornMovingAveragesChartProps {
  period: CMAPeriod;
}

// ─── Constants ───────────────────────────────────────────────────────────

const COLORS = {
  corn: "#22c55e",
  ma50: "#06b6d4",
  ma100: "#a78bfa",
  ma200: "#f59e0b",
};

const LABELS: Record<string, string> = {
  corn: "Corn Price",
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
  return `$${n.toFixed(2)}`;
}

function formatYAxis(n: number): string {
  return `$${n.toFixed(2)}`;
}

function getDateRange(period: CMAPeriod): { start: string; end: string } {
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

function downsample(data: ChartPoint[]): ChartPoint[] {
  const len = data.length;
  if (len <= 400) return data;
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

function CMATooltip({
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
              {formatPrice(entry.value)}/bu
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────

export default function CornMovingAveragesChart({ period }: CornMovingAveragesChartProps) {
  const [cornHistory, setCornHistory] = useState<CornHistoryEntry[]>([]);
  const [cornLoading, setCornLoading] = useState(true);

  useEffect(() => {
    api
      .getCornHistory()
      .then(setCornHistory)
      .catch(() => {})
      .finally(() => setCornLoading(false));
  }, []);

  const chartData = useMemo(() => {
    if (cornHistory.length === 0) return [];

    const todayStr = new Date().toISOString().slice(0, 10);
    const { start, end } = getDateRange(period);

    // Get all dates from power-law-data up to today
    const allDates = (powerLawData as Array<{ date: string }>)
      .filter((d) => d.date <= end && d.date <= todayStr)
      .map((d) => d.date);

    // Interpolate corn prices to daily
    const cornDaily = interpolateCornPrices(cornHistory, allDates);

    // Build full price array for MA computation
    const allData = allDates.map((date) => ({
      date,
      corn: cornDaily.get(date) ?? null,
    }));

    // Compute MAs over full dataset before filtering to visible window
    const prices = allData.map((d) => d.corn);
    const ma50 = computeMA(prices, 50);
    const ma100 = computeMA(prices, 100);
    const ma200 = computeMA(prices, 200);

    // Combine and filter to visible range
    const points: ChartPoint[] = allData
      .map((d, i) => ({
        date: d.date,
        ts: parseISO(d.date).getTime(),
        corn: d.corn,
        ma50: ma50[i],
        ma100: ma100[i],
        ma200: ma200[i],
      }))
      .filter((d) => d.date >= start && d.date <= end && d.corn != null);

    return downsample(points);
  }, [period, cornHistory]);

  // Y domain
  const allValues = chartData
    .flatMap((d) => [d.corn, d.ma50, d.ma100, d.ma200])
    .filter((v): v is number => v != null && v > 0);

  const yMin = allValues.length > 0 ? Math.min(...allValues) * 0.95 : 0;
  const yMax = allValues.length > 0 ? Math.max(...allValues) * 1.05 : 10;

  // X axis ticks
  const xTicks = useMemo(() => {
    if (chartData.length === 0) return [];
    const first = chartData[0].ts;
    const last = chartData[chartData.length - 1].ts;
    const ticks: number[] = [];

    if (period === "1M") {
      const d = new Date(first);
      d.setDate(d.getDate() + (7 - d.getDay()) % 7);
      while (d.getTime() <= last) {
        ticks.push(d.getTime());
        d.setDate(d.getDate() + 7);
      }
    } else if (period === "1Y") {
      const d = new Date(first);
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      while (d.getTime() <= last) {
        ticks.push(d.getTime());
        d.setMonth(d.getMonth() + 2);
      }
    } else {
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

  if (cornLoading) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: MONO,
          color: TEXT_3,
          fontSize: "0.8125rem",
          letterSpacing: "0.06em",
        }}
      >
        LOADING…
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: MONO,
          color: TEXT_3,
          fontSize: "0.8125rem",
        }}
      >
        No corn price data available
      </div>
    );
  }

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
          tickFormatter={formatYAxis}
          axisLine={false}
          tickLine={false}
          tick={{ fill: TEXT_3, fontFamily: MONO, fontSize: 11 }}
          width={60}
        />
        <Tooltip content={<CMATooltip />} />

        {/* 200-day MA (amber, behind) */}
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
        {/* Corn Price (green, on top) */}
        <Line
          type="monotone"
          dataKey="corn"
          stroke={COLORS.corn}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3, fill: COLORS.corn, stroke: "#0a0a0c", strokeWidth: 2 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
