// app/web/src/components/autoBuy/StrategyTab.tsx
import { useEffect, useState } from "react";
import { api, type AutoBuyStatus, type AutoBuyZoneMultipliers, type ValuationCurrent, type ValuationZone } from "../../api/client";
import HistoryTable from "./HistoryTable";
import CoinbaseCard from "./CoinbaseCard";

interface Props {
  status: AutoBuyStatus | null;
  valuation: ValuationCurrent | null;
  onRefresh: () => Promise<unknown>;
}

const ZONE_ORDER: Array<{ key: keyof AutoBuyZoneMultipliers; label: string }> = [
  { key: "extreme_buy",  label: "Extreme Buy"  },
  { key: "undervalued",  label: "Undervalued"  },
  { key: "fair_value",   label: "Fair Value"   },
  { key: "elevated",     label: "Elevated"     },
  { key: "overvalued",   label: "Overvalued"   },
  { key: "extreme_sell", label: "Extreme Sell" },
];

export default function StrategyTab({ status, valuation, onRefresh }: Props) {
  if (!status?.config) {
    return (
      <div className="panel"><div className="panel-body">
        <em className="text-dim">Config unavailable. Backend may not be initialized.</em>
      </div></div>
    );
  }
  const cfg = status.config;

  // Next-buy banner
  const currentMultiplier = valuation ? cfg.zone_multipliers[valuation.zone as ValuationZone] ?? 0 : 0;
  const nextBuyUsd = Math.round(cfg.base_unit_usd * currentMultiplier * 100) / 100;

  return (
    <div>
      {/* Summary banner */}
      <div className="panel" style={{ marginBottom: 16, background: "var(--panel)", borderLeft: `4px solid ${nextBuyUsd > 0 ? "var(--green)" : "var(--text-dim)"}` }}>
        <div className="panel-body">
          <div style={{ fontSize: "0.875rem", color: "var(--text-dim)", marginBottom: 4 }}>At current Z-score</div>
          <div style={{ fontSize: "1.25rem" }}>
            {valuation ? (
              <>If base = <strong>${cfg.base_unit_usd.toFixed(2)}</strong> the next buy is <strong>${nextBuyUsd.toFixed(2)}</strong> (zone: {valuation.zone}, {currentMultiplier}×)</>
            ) : (
              <em className="text-dim">Valuation not loaded — next-buy calculation unavailable.</em>
            )}
          </div>
        </div>
      </div>

      {/* Multipliers editor */}
      <MultipliersEditor config={cfg} onSaved={onRefresh} />

      <HistoryTable />
      <CoinbaseCard status={status} onRefresh={onRefresh} />

      {/* TODO task 8: Pause/Resume controls */}
    </div>
  );
}

function MultipliersEditor({ config, onSaved }: { config: NonNullable<AutoBuyStatus["config"]>; onSaved: () => Promise<unknown> }) {
  const [baseUnit, setBaseUnit] = useState(String(config.base_unit_usd));
  const [frequency, setFrequency] = useState(config.frequency);
  const [mult, setMult] = useState<AutoBuyZoneMultipliers>(config.zone_multipliers);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  // Sync when parent config changes (e.g., after a save refreshes).
  useEffect(() => {
    setBaseUnit(String(config.base_unit_usd));
    setFrequency(config.frequency);
    setMult(config.zone_multipliers);
  }, [config]);

  const handleSave = async () => {
    setSaving(true); setToast(null);
    try {
      const base = Number(baseUnit);
      if (!Number.isFinite(base) || base <= 0) { setToast({ kind: "error", message: "Base unit must be a positive number." }); setSaving(false); return; }
      for (const { key, label } of ZONE_ORDER) {
        const v = mult[key];
        if (!Number.isFinite(v) || v < 0) { setToast({ kind: "error", message: `${label} multiplier must be ≥ 0.` }); setSaving(false); return; }
      }
      await api.patchAutoBuyConfig({
        base_unit_usd: base,
        frequency,
        zone_multipliers: mult,
      });
      setToast({ kind: "success", message: "Saved." });
      await onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error.";
      setToast({ kind: "error", message: msg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Strategy</div>
      <div className="panel-body">
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", marginBottom: 16 }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="text-dim" style={{ fontSize: "0.75rem" }}>Base unit (USD)</span>
            <input type="number" step="1" min="1" value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="text-dim" style={{ fontSize: "0.75rem" }}>Frequency</span>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
        </div>

        <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Zone Buy Multipliers</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
          {ZONE_ORDER.map(({ key, label }) => (
            <label key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="text-dim" style={{ fontSize: "0.75rem" }}>{label}</span>
              <input
                type="number"
                step="0.25"
                min="0"
                value={mult[key]}
                onChange={(e) => setMult({ ...mult, [key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>

        <button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save Strategy"}</button>
      </div>
    </div>
  );
}
