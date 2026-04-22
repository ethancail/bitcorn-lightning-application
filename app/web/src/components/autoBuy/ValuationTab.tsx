// app/web/src/components/autoBuy/ValuationTab.tsx
import { useEffect, useState } from "react";
import { api, type ValuationCurrent, type ValuationZone } from "../../api/client";

interface Props {
  valuation: ValuationCurrent | null;
}

// Zone thresholds — mirror of `cloudflare-worker/src/valuation/zones.ts` on the frontend.
// Kept in sync manually; change both if thresholds ever move.
const ZONE_BANDS: Array<{ zone: ValuationZone; label: string; minZ: number; maxZ: number; color: string }> = [
  { zone: "extreme_buy",  label: "Extreme Buy",  minZ: -Infinity, maxZ: -2, color: "#10b981" },
  { zone: "undervalued",  label: "Undervalued",  minZ: -2,        maxZ: -1, color: "#34d399" },
  { zone: "fair_value",   label: "Fair Value",   minZ: -1,        maxZ:  1, color: "#94a3b8" },
  { zone: "elevated",     label: "Elevated",     minZ:  1,        maxZ:  2, color: "#fbbf24" },
  { zone: "overvalued",   label: "Overvalued",   minZ:  2,        maxZ:  3, color: "#f97316" },
  { zone: "extreme_sell", label: "Extreme Sell", minZ:  3,        maxZ:  Infinity, color: "#ef4444" },
];

const DEFAULT_MULTIPLIERS: Record<ValuationZone, number> = {
  extreme_buy: 3,
  undervalued: 2,
  fair_value: 1,
  elevated: 0.5,
  overvalued: 0.25,
  extreme_sell: 0,
};

function zoneColor(zone: ValuationZone): string {
  return ZONE_BANDS.find((b) => b.zone === zone)?.color ?? "#94a3b8";
}

function zoneLabel(zone: ValuationZone): string {
  return ZONE_BANDS.find((b) => b.zone === zone)?.label ?? zone;
}

function formatUsd(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${n.toFixed(2)}`;
}

function formatZ(n: number | null | undefined, decimals = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
}

export default function ValuationTab({ valuation }: Props) {
  const [history, setHistory] = useState<Array<{ date: string; z_score: number; zone: string; price_usd?: number }> | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.getValuationHistory()
      .then((r) => { if (!cancelled) setHistory(r.series); })
      .catch((err) => { if (!cancelled) setHistoryError(err?.message ?? "history_unavailable"); });
    return () => { cancelled = true; };
  }, []);

  if (!valuation) {
    return (
      <div className="panel">
        <div className="panel-body">
          <em className="text-dim">Valuation data unavailable. Check that the Worker is deployed and reachable.</em>
        </div>
      </div>
    );
  }

  // Historical percentile — prefer Worker-computed stats over client-side recompute.
  // If the Worker hasn't published stats yet (old KV), fall back to counting the
  // local history series; if that's also empty, show "—".
  const percentile = history && history.length > 0
    ? (history.filter((p) => p.z_score >= valuation.z_score).length / history.length) * 100
    : null;

  const peakFromHistory = history && history.length > 0
    ? history.reduce((max, p) => (p.z_score > max.z_score ? p : max), history[0])
    : null;
  const peakZ = valuation.stats?.max_z ?? peakFromHistory?.z_score ?? null;
  const peakDate = valuation.stats?.max_z_date ?? peakFromHistory?.date ?? null;

  const currentMultiplier = DEFAULT_MULTIPLIERS[valuation.zone] ?? 0;

  const ath = history && history.length > 0
    ? Math.max(...history.map((p) => p.price_usd ?? 0))
    : null;

  return (
    <div>
      {/* Hero cards row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
        <HeroCard label="Z-Score" value={valuation.z_score.toFixed(2)} sub={zoneLabel(valuation.zone)} color={zoneColor(valuation.zone)} />
        <HeroCard label="Bitcoin Price" value={formatUsd(valuation.price_usd)} sub={ath ? `ATH ${formatUsd(ath)}` : ""} />
        <HeroCard label="Historical Percentile" value={percentile != null ? `${percentile.toFixed(1)}%` : "—"} sub={percentile != null ? "of days at/above current Z" : "loading…"} />
        <HeroCard label="Peak Z-Score" value={formatZ(peakZ)} sub={peakDate ?? ""} />
        <HeroCard label="Current Multiplier" value={`${currentMultiplier}x`} sub="vs. base unit" color={zoneColor(valuation.zone)} />
      </div>

      {/* Zone gauge + zone definitions side by side */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-header">Valuation Zone</div>
        <div className="panel-body" style={{ display: "grid", gridTemplateColumns: "minmax(280px, 360px) 1fr", gap: 24, alignItems: "center" }}>
          <SemicircleGauge z={valuation.z_score} zone={valuation.zone} />
          <ZoneDefinitions currentZone={valuation.zone} />
        </div>
      </div>

      {/* Distribution Statistics panel */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-header">Distribution Statistics</div>
        <div className="panel-body">
          <DistributionStats
            stats={valuation.stats ?? null}
            currentZ={valuation.z_score}
            currentMultiplier={currentMultiplier}
          />
        </div>
      </div>

      {/* Placeholder for the log-price chart (deferred) */}
      <div className="panel">
        <div className="panel-header">BTC Log Price (deferred)</div>
        <div className="panel-body">
          <em className="text-dim">
            Zone-colored log-price chart to be added in a follow-up plan. Historical valuation series is loaded
            ({history?.length ?? 0} datapoints{historyError ? `, error: ${historyError}` : ""}).
          </em>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Hero card
// ───────────────────────────────────────────────────────────────────────

function HeroCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="panel" style={{ padding: 16 }}>
      <div className="text-dim" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: "1.75rem", fontWeight: 600, color: color ?? "var(--text)", lineHeight: 1.1 }}>{value}</div>
      {sub && <div className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Semicircle gauge (SVG)
// ───────────────────────────────────────────────────────────────────────

function SemicircleGauge({ z, zone }: { z: number; zone: ValuationZone }) {
  // Fixed viewBox: 200×120 (2:1.2 ratio). Gauge sweeps 180° from 9 o'clock
  // (Z = -3) through 12 o'clock (Z = 0) to 3 o'clock (Z = +3).
  const VB_W = 200;
  const VB_H = 130;
  const CX = VB_W / 2;      // 100
  const CY = 110;           // needle pivot near bottom
  const R = 88;             // outer radius of the arc
  const STROKE = 18;        // arc thickness

  // Map a Z value to an angle in degrees.
  //   Z = -3 → 180° (pointing left)
  //   Z =  0 →  90° (pointing up)
  //   Z = +3 →   0° (pointing right)
  // SVG angles measured from positive X-axis (right) counterclockwise.
  const zToAngleDeg = (zVal: number): number => {
    const clamped = Math.max(-3, Math.min(3, zVal));
    return 180 - ((clamped + 3) / 6) * 180;
  };

  const polar = (angleDeg: number, radius: number) => {
    const rad = (angleDeg * Math.PI) / 180;
    return { x: CX + Math.cos(rad) * radius, y: CY - Math.sin(rad) * radius };
  };

  // Build arc segments for each zone band.
  // An SVG arc from (x1,y1) to (x2,y2) uses the endpoints + a sweep flag.
  const arcSegment = (startZ: number, endZ: number, color: string, key: string) => {
    const startDeg = zToAngleDeg(startZ);
    const endDeg = zToAngleDeg(endZ);
    const start = polar(startDeg, R);
    const end = polar(endDeg, R);
    // largeArcFlag = 0 (our sweeps are always < 180° per segment)
    // sweepFlag = 0 (counterclockwise in SVG's Y-flipped coord system = visually left-to-right along the top)
    const d = `M ${start.x} ${start.y} A ${R} ${R} 0 0 1 ${end.x} ${end.y}`;
    return <path key={key} d={d} stroke={color} strokeWidth={STROKE} fill="none" strokeLinecap="butt" />;
  };

  // Clamp segment boundaries to the gauge range [-3, +3].
  const clampedBands = ZONE_BANDS.map((b) => ({
    ...b,
    minZ: b.minZ === -Infinity ? -3 : b.minZ,
    maxZ: b.maxZ === Infinity ? 3 : b.maxZ,
  }));

  // Needle
  const needleAngle = zToAngleDeg(z);
  const needleTip = polar(needleAngle, R - 4);
  const needleBase1 = polar(needleAngle + 90, 4);
  const needleBase2 = polar(needleAngle - 90, 4);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} style={{ width: "100%", maxWidth: 320, height: "auto" }} aria-label="Valuation Z-score gauge">
        {/* Arc segments */}
        {clampedBands.map((b) => arcSegment(b.minZ, b.maxZ, b.color, b.zone))}

        {/* Axis labels */}
        <text x={CX - R - 2} y={CY + 12} fontSize="10" fill="currentColor" fontFamily="var(--mono, monospace)" opacity="0.6">Z=−3</text>
        <text x={CX} y={10} fontSize="10" fill="currentColor" fontFamily="var(--mono, monospace)" opacity="0.6" textAnchor="middle">Z=0</text>
        <text x={CX + R + 2} y={CY + 12} fontSize="10" fill="currentColor" fontFamily="var(--mono, monospace)" opacity="0.6" textAnchor="end">Z=+3</text>

        {/* Center value */}
        <text x={CX} y={CY - 18} fontSize="26" fontWeight="600" fill={zoneColor(zone)} textAnchor="middle" fontFamily="var(--mono, monospace)">
          {z.toFixed(2)}
        </text>

        {/* Needle */}
        <polygon
          points={`${needleTip.x},${needleTip.y} ${needleBase1.x},${needleBase1.y} ${needleBase2.x},${needleBase2.y}`}
          fill="currentColor"
        />
        <circle cx={CX} cy={CY} r="5" fill="currentColor" />
      </svg>

      {/* Zone label pill */}
      <div
        style={{
          padding: "4px 14px",
          borderRadius: 999,
          background: `${zoneColor(zone)}22`,
          color: zoneColor(zone),
          border: `1px solid ${zoneColor(zone)}66`,
          fontSize: "0.875rem",
          fontWeight: 600,
          letterSpacing: "0.02em",
        }}
      >
        {zoneLabel(zone)}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Zone Definitions panel
// ───────────────────────────────────────────────────────────────────────

function ZoneDefinitions({ currentZone }: { currentZone: ValuationZone }) {
  const fmtBand = (minZ: number, maxZ: number): string => {
    const left = minZ === -Infinity ? "Z < " + maxZ : `${minZ} ≤ Z`;
    const right = maxZ === Infinity ? `${minZ} ≤ Z` : `Z < ${maxZ}`;
    if (minZ === -Infinity) return `Z < ${maxZ}`;
    if (maxZ === Infinity) return `Z ≥ ${minZ}`;
    return `${minZ} ≤ Z < ${maxZ}`;
    // (unused duplicate vars eliminated by TS lint, left here for clarity)
    void left; void right;
  };

  return (
    <div>
      <div className="text-dim" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 12 }}>
        Zone Definitions
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {ZONE_BANDS.map((b) => {
          const isActive = b.zone === currentZone;
          return (
            <div
              key={b.zone}
              style={{
                display: "grid",
                gridTemplateColumns: "14px 1fr auto auto",
                gap: 10,
                alignItems: "center",
                padding: "6px 10px",
                borderRadius: 4,
                background: isActive ? `${b.color}15` : "transparent",
                border: `1px solid ${isActive ? `${b.color}55` : "transparent"}`,
                fontSize: "0.8125rem",
              }}
            >
              <div style={{ width: 10, height: 10, borderRadius: "50%", background: b.color }} />
              <div style={{ fontWeight: isActive ? 600 : 400 }}>{b.label}</div>
              <div className="text-dim" style={{ fontFamily: "var(--mono, monospace)", fontSize: "0.75rem" }}>
                {fmtBand(b.minZ, b.maxZ)}
              </div>
              <div className="text-dim" style={{ fontFamily: "var(--mono, monospace)", fontSize: "0.75rem" }}>
                {DEFAULT_MULTIPLIERS[b.zone]}×
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────
// Distribution Statistics panel
// ───────────────────────────────────────────────────────────────────────

function DistributionStats({
  stats,
  currentZ,
  currentMultiplier,
}: {
  stats: NonNullable<ValuationCurrent["stats"]> | null;
  currentZ: number;
  currentMultiplier: number;
}) {
  if (!stats || stats.n === 0) {
    return (
      <em className="text-dim" style={{ fontSize: "0.875rem" }}>
        Distribution statistics populate once historical composite data accumulates. First datapoint appears after the
        Worker's 00:15 UTC cron following manual-input submission.
      </em>
    );
  }

  const rows: Array<[string, string, string?]> = [
    ["Mean (historical)",   formatZ(stats.mean)],
    ["Std Dev",             formatZ(stats.std_dev)],
    ["Min Z",               formatZ(stats.min_z),   stats.min_z_date],
    ["Max Z",               formatZ(stats.max_z),   stats.max_z_date],
    ["Current Z",           formatZ(currentZ)],
    ["DCA Multiplier",      `${currentMultiplier}×`],
    ["Sample size (days)",  String(stats.n)],
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
      {rows.map(([label, value, sub]) => (
        <div key={label} style={{ padding: "10px 14px", background: "var(--panel-alt, rgba(255,255,255,0.02))", borderRadius: 4, border: "1px solid var(--border)" }}>
          <div className="text-dim" style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{label}</div>
          <div style={{ fontFamily: "var(--mono, monospace)", fontSize: "1rem", fontWeight: 600 }}>{value}</div>
          {sub && <div className="text-dim" style={{ fontSize: "0.7rem", marginTop: 2 }}>{sub}</div>}
        </div>
      ))}
    </div>
  );
}
