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

// ─── Types ───────────────────────────────────────────────────────────────

type CBPeriod = "1M" | "1Y" | "5Y" | "10Y";

type RawDataPoint = {
  date: string;
  btc: number | null;
};

type ChartPoint = {
  date: string;
  ts: number;
  ratio: number | null;
  btcPrice: number | null;
  cornPrice: number | null;
};

interface CornBitcoinChartProps {
  period: CBPeriod;
  currentPrice: number;
}

// ─── Constants ───────────────────────────────────────────────────────────

const LINE_COLOR = "#f59e0b";
const BG_2 = "#17171e";
const BORDER = "#2a2a38";
const TEXT_3 = "#5a5a70";
const TEXT = "#e8e8f0";
const MONO = "'IBM Plex Mono', monospace";

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatBushels(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

function formatUsd(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getDateRange(period: CBPeriod): { start: string; end: string } {
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

/** Interpolate monthly corn prices to daily using linear interpolation. */
function interpolateCornPrices(
  entries: CornHistoryEntry[],
  dates: string[],
): Map<string, number> {
  if (entries.length === 0) return new Map();

  // Build monthly map: "YYYY-MM" → price
  const monthlyMap = new Map<string, number>();
  for (const e of entries) {
    const key = `${e.year}-${String(e.month).padStart(2, "0")}`;
    monthlyMap.set(key, e.price);
  }

  // Sort unique months
  const months = [...monthlyMap.keys()].sort();
  if (months.length === 0) return new Map();

  // Build array of { ts, price } for interpolation
  const anchors: Array<{ ts: number; price: number }> = months.map((m) => ({
    ts: new Date(`${m}-15`).getTime(), // mid-month as anchor
    price: monthlyMap.get(m)!,
  }));

  const result = new Map<string, number>();
  for (const dateStr of dates) {
    const ts = parseISO(dateStr).getTime();

    // Before first anchor — use first price
    if (ts <= anchors[0].ts) {
      result.set(dateStr, anchors[0].price);
      continue;
    }
    // After last anchor — use last price
    if (ts >= anchors[anchors.length - 1].ts) {
      result.set(dateStr, anchors[anchors.length - 1].price);
      continue;
    }

    // Find surrounding anchors and interpolate
    for (let i = 0; i < anchors.length - 1; i++) {
      if (ts >= anchors[i].ts && ts <= anchors[i + 1].ts) {
        const t =
          (ts - anchors[i].ts) / (anchors[i + 1].ts - anchors[i].ts);
        const price =
          anchors[i].price + t * (anchors[i + 1].price - anchors[i].price);
        result.set(dateStr, price);
        break;
      }
    }
  }
  return result;
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

function CBTooltip({
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
      {point.btcPrice != null && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 2 }}>
          <span style={{ color: "#f59e0b" }}>BTC Price</span>
          <span style={{ color: TEXT, fontWeight: 500 }}>{formatUsd(point.btcPrice)}</span>
        </div>
      )}
      {point.cornPrice != null && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginBottom: 2 }}>
          <span style={{ color: "#22c55e" }}>Corn Price</span>
          <span style={{ color: TEXT, fontWeight: 500 }}>{formatUsd(point.cornPrice)}/bu</span>
        </div>
      )}
      {point.ratio != null && (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 16, marginTop: 4, paddingTop: 4, borderTop: `1px solid ${BORDER}` }}>
          <span style={{ color: "#f59e0b", fontWeight: 600 }}>Bushels / BTC</span>
          <span style={{ color: TEXT, fontWeight: 600 }}>{Math.round(point.ratio).toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────

export default function CornBitcoinChart({ period, currentPrice }: CornBitcoinChartProps) {
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

    // Build BTC daily data
    const btcData: RawDataPoint[] = (powerLawData as Array<{ date: string; btc: number | null }>)
      .filter((d) => d.date >= start && d.date <= end)
      .map((d) => ({
        date: d.date,
        btc: d.btc != null ? d.btc : d.date <= todayStr && currentPrice > 0 ? currentPrice : null,
      }));

    // Interpolate corn prices to daily
    const cornDaily = interpolateCornPrices(
      cornHistory,
      btcData.map((d) => d.date),
    );

    // Compute ratio
    const points: ChartPoint[] = btcData
      .map((d) => {
        const cornPrice = cornDaily.get(d.date) ?? null;
        const ratio = d.btc != null && cornPrice != null && cornPrice > 0 ? d.btc / cornPrice : null;
        return {
          date: d.date,
          ts: parseISO(d.date).getTime(),
          ratio,
          btcPrice: d.btc,
          cornPrice,
        };
      })
      .filter((d) => d.ratio != null);

    return downsample(points);
  }, [period, currentPrice, cornHistory]);

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

  // Y domain
  const allValues = chartData
    .map((d) => d.ratio)
    .filter((v): v is number => v != null && v > 0);

  const yMin = allValues.length > 0 ? Math.min(...allValues) * 0.9 : 0;
  const yMax = allValues.length > 0 ? Math.max(...allValues) * 1.1 : 1;

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
          tickFormatter={(v: number) => formatBushels(v) + " bu"}
          axisLine={false}
          tickLine={false}
          tick={{ fill: TEXT_3, fontFamily: MONO, fontSize: 11 }}
          width={80}
        />
        <Tooltip content={<CBTooltip />} />
        <Line
          type="monotone"
          dataKey="ratio"
          stroke={LINE_COLOR}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3, fill: LINE_COLOR, stroke: "#0a0a0c", strokeWidth: 2 }}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
