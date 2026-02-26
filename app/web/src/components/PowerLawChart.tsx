import { useMemo } from "react";
import {
  ComposedChart,
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

type Period = "1Y" | "5Y" | "All" | "2042";

type RawDataPoint = {
  date: string;
  btc: number | null;
  trend: number;
  p2_5: number;
  p16_5: number;
  p83_5: number;
  p97_5: number;
};

type ChartPoint = RawDataPoint & {
  ts: number;
};

interface PowerLawChartProps {
  period: Period;
  currentPrice: number;
}

// ─── Constants ───────────────────────────────────────────────────────────

const LINE_COLORS = {
  p97_5: "#ef4444",
  p83_5: "#f97316",
  trend: "#22c55e",
  p16_5: "#3b82f6",
  p2_5: "#8b5cf6",
  btcPrice: "#f59e0b",
};

const BAND_LABELS: Record<string, string> = {
  btc: "BTC Price",
  trend: "Power Law Trend",
  p97_5: "97.5th Percentile",
  p83_5: "83.5th Percentile",
  p16_5: "16.5th Percentile",
  p2_5: "2.5th Percentile",
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

function getDateRange(period: Period): { start: string; end: string } {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  switch (period) {
    case "1Y": {
      const start = new Date(today);
      start.setFullYear(start.getFullYear() - 1);
      return { start: start.toISOString().slice(0, 10), end: todayStr };
    }
    case "5Y": {
      const start = new Date(today);
      start.setFullYear(start.getFullYear() - 5);
      return { start: start.toISOString().slice(0, 10), end: todayStr };
    }
    case "All":
      return { start: "2015-01-01", end: todayStr };
    case "2042":
      return { start: "2015-01-01", end: "2042-12-31" };
  }
}

function downsample(data: ChartPoint[]): ChartPoint[] {
  const len = data.length;
  if (len <= 365) return data;

  const step = len <= 1825 ? 7 : 30;
  const last90Cutoff = data.length > 90 ? data[data.length - 90].ts : 0;

  const result: ChartPoint[] = [];
  for (let i = 0; i < len; i++) {
    if (i % step === 0 || data[i].ts >= last90Cutoff || i === len - 1) {
      result.push(data[i]);
    }
  }
  return result;
}

// ─── Custom Tooltip ──────────────────────────────────────────────────────

function PowerLawTooltip({
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
        const label = BAND_LABELS[entry.dataKey] ?? entry.dataKey;
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

export default function PowerLawChart({ period, currentPrice }: PowerLawChartProps) {
  const chartData = useMemo(() => {
    const { start, end } = getDateRange(period);
    const todayStr = new Date().toISOString().slice(0, 10);

    const filtered = (powerLawData as RawDataPoint[])
      .filter((d) => d.date >= start && d.date <= end)
      .map((d) => ({
        ...d,
        btc:
          d.btc != null
            ? d.btc
            : d.date <= todayStr && currentPrice > 0
              ? currentPrice
              : null,
        ts: parseISO(d.date).getTime(),
      }));

    return downsample(filtered);
  }, [period, currentPrice]);

  // Compute Y domain from visible data
  const allValues = chartData.flatMap((d) => [
    d.btc,
    d.trend,
    d.p2_5,
    d.p16_5,
    d.p83_5,
    d.p97_5,
  ]).filter((v): v is number => v != null && v > 0);

  const yMin = Math.max(10, Math.min(...allValues) * 0.5);
  const yMax = Math.max(...allValues) * 2;

  // Generate log-scale ticks
  const logTicks: number[] = [];
  let tick = 10;
  while (tick <= yMax * 10) {
    if (tick >= yMin * 0.5) logTicks.push(tick);
    tick *= 10;
  }

  // X axis ticks — aligned to year or month boundaries
  const xTicks = useMemo(() => {
    if (chartData.length === 0) return [];
    const first = chartData[0].ts;
    const last = chartData[chartData.length - 1].ts;
    const ticks: number[] = [];

    if (period === "1Y") {
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
      // Start at a clean multiple of step
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
      <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={BORDER} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          domain={["dataMin", "dataMax"]}
          ticks={xTicks}
          tickFormatter={(ts: number) => {
            const d = new Date(ts);
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
          scale="log"
          domain={[yMin, yMax]}
          ticks={logTicks}
          tickFormatter={formatPrice}
          axisLine={false}
          tickLine={false}
          tick={{ fill: TEXT_3, fontFamily: MONO, fontSize: 11 }}
          width={60}
          allowDataOverflow
        />
        <Tooltip content={<PowerLawTooltip />} />

        {/* Percentile bands (dashed) */}
        <Line
          type="monotone"
          dataKey="p97_5"
          stroke={LINE_COLORS.p97_5}
          strokeDasharray="4 2"
          strokeWidth={1}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="p83_5"
          stroke={LINE_COLORS.p83_5}
          strokeDasharray="4 2"
          strokeWidth={1}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="trend"
          stroke={LINE_COLORS.trend}
          strokeWidth={2}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="p16_5"
          stroke={LINE_COLORS.p16_5}
          strokeDasharray="4 2"
          strokeWidth={1}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="p2_5"
          stroke={LINE_COLORS.p2_5}
          strokeDasharray="4 2"
          strokeWidth={1}
          dot={false}
          activeDot={false}
          isAnimationActive={false}
        />

        {/* Actual BTC price (amber, solid) */}
        <Line
          type="monotone"
          dataKey="btc"
          stroke={LINE_COLORS.btcPrice}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3, fill: LINE_COLORS.btcPrice, stroke: "#0a0a0c", strokeWidth: 2 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
