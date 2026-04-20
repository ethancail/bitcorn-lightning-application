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

  // Historical percentile: what fraction of past Z-scores were AT OR ABOVE today's Z?
  // Higher percentile = today is rarer-on-the-high-side.
  const percentile = history && history.length > 0
    ? (history.filter((p) => p.z_score >= valuation.z_score).length / history.length) * 100
    : null;

  const peak = history && history.length > 0
    ? history.reduce((max, p) => (p.z_score > max.z_score ? p : max), history[0])
    : null;

  const currentMultiplier = (() => {
    const defaults: Record<ValuationZone, number> = {
      extreme_buy: 3,
      undervalued: 2,
      fair_value: 1,
      elevated: 0.5,
      overvalued: 0.25,
      extreme_sell: 0,
    };
    return defaults[valuation.zone] ?? 0;
  })();

  return (
    <div>
      {/* Hero cards row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
        <HeroCard label="Z-Score" value={valuation.z_score.toFixed(2)} sub={zoneLabel(valuation.zone)} color={zoneColor(valuation.zone)} />
        <HeroCard label="Bitcoin Price" value={formatUsd(valuation.price_usd)} sub={history && history.length > 0 ? `ATH ${formatUsd(Math.max(...history.map((p) => p.price_usd ?? 0)))}` : ""} />
        <HeroCard label="Historical Percentile" value={percentile != null ? `${percentile.toFixed(1)}%` : "—"} sub={percentile != null ? "of days at/above current Z" : "loading…"} />
        <HeroCard label="Peak Z-Score" value={peak ? peak.z_score.toFixed(2) : "—"} sub={peak ? peak.date : ""} />
        <HeroCard label="Current Multiplier" value={`${currentMultiplier}x`} sub="vs. base unit" color={zoneColor(valuation.zone)} />
      </div>

      {/* Zone gauge */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-header">Valuation Zone</div>
        <div className="panel-body">
          <ZoneGauge z={valuation.z_score} />
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

function HeroCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="panel" style={{ padding: 16 }}>
      <div className="text-dim" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: "1.75rem", fontWeight: 600, color: color ?? "var(--text)", lineHeight: 1.1 }}>{value}</div>
      {sub && <div className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function ZoneGauge({ z }: { z: number }) {
  // Map z from [-3, +3] onto [0, 100] for the needle.
  const clamped = Math.max(-3, Math.min(3, z));
  const pct = ((clamped + 3) / 6) * 100;

  return (
    <div>
      <div style={{ position: "relative", height: 32, borderRadius: 4, overflow: "hidden", display: "flex" }}>
        {ZONE_BANDS.map((b) => {
          const minPct = b.minZ === -Infinity ? 0 : ((b.minZ + 3) / 6) * 100;
          const maxPct = b.maxZ === Infinity ? 100 : ((b.maxZ + 3) / 6) * 100;
          const width = Math.max(0, maxPct - minPct);
          return <div key={b.zone} style={{ background: b.color, width: `${width}%`, height: "100%" }} title={`${b.label} (Z ${b.minZ} → ${b.maxZ})`} />;
        })}
        {/* Needle */}
        <div style={{
          position: "absolute",
          left: `${pct}%`,
          top: 0,
          bottom: 0,
          width: 2,
          background: "var(--text)",
          transform: "translateX(-1px)",
          boxShadow: "0 0 4px rgba(0,0,0,0.4)",
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: "0.75rem", color: "var(--text-dim)" }}>
        <span>Z = −3</span>
        <span>Z = 0</span>
        <span>Z = +3</span>
      </div>
    </div>
  );
}
