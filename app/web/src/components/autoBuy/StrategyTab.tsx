// app/web/src/components/autoBuy/StrategyTab.tsx
import { useEffect, useRef, useState } from "react";
import { api, type AutoBuyStatus, type AutoBuyZoneMultipliers, type ValuationCurrent } from "../../api/client";
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
  // DCA_HIDE (v1.13.0): `valuation` is still fetched by parent for the
  // backend's zone-multiplier lookup, but no longer rendered. Retain the
  // prop so un-hiding is a reversal of this patch without a type change.
  void valuation;

  if (!status?.config) {
    return (
      <div className="panel"><div className="panel-body">
        <em className="text-dim">Config unavailable. Backend may not be initialized.</em>
      </div></div>
    );
  }
  const cfg = status.config;

  // Flat DCA preview: base_unit × 1.0 (zone multipliers default to Fair
  // Value = 1x until un-hidden and tuned by operator). Accurate given the
  // hidden UI — the backend uses whatever multipliers are stored.
  const nextBuyUsd = cfg.base_unit_usd;

  return (
    <div>
      <MasterControl status={status} onRefresh={onRefresh} />

      {/* Summary banner — simplified for v1.13.0 DCA_HIDE. Previously referenced
          Z-score and zone multiplier; now just shows the configured base unit
          and the cadence. Restore the old copy when un-hiding DCA. */}
      <div className="panel" style={{ marginBottom: 16, background: "var(--panel)", borderLeft: "4px solid var(--green)" }}>
        <div className="panel-body">
          <div style={{ fontSize: "0.875rem", color: "var(--text-dim)", marginBottom: 4 }}>Next scheduled buy</div>
          <div style={{ fontSize: "1.25rem" }}>
            <strong>${nextBuyUsd.toFixed(2)}</strong> every {cfg.frequency}
          </div>
        </div>
      </div>

      <StrategyEditor config={cfg} onSaved={onRefresh} />

      <HistoryTable />
      <CoinbaseCard status={status} onRefresh={onRefresh} />
    </div>
  );
}

// DCA_HIDE (v1.13.0): was `MultipliersEditor`. Renamed to `StrategyEditor`
// and the zone multipliers grid is hidden in the render (state + save logic
// retained so the backend's zone_multipliers row stays populated and the
// scheduler continues to work). To un-hide: revert the JSX block around the
// `DCA_HIDE: zone multipliers` marker below.
function StrategyEditor({ config, onSaved }: { config: NonNullable<AutoBuyStatus["config"]>; onSaved: () => Promise<unknown> }) {
  const [baseUnit, setBaseUnit] = useState(String(config.base_unit_usd));
  const [frequency, setFrequency] = useState(config.frequency);
  const [mult, setMult] = useState<AutoBuyZoneMultipliers>(config.zone_multipliers);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  // Only sync from server when the user has NO unsaved edits. A background
  // 30s poll tick can re-render with a fresh `config` object reference; without
  // this guard, it would clobber in-progress edits. Detect "clean" state by
  // comparing current local form state to the last-applied server config.
  const lastAppliedRef = useRef<typeof config | null>(null);
  useEffect(() => {
    const applied = lastAppliedRef.current;
    const localMatchesApplied = applied
      ? String(applied.base_unit_usd) === baseUnit
        && applied.frequency === frequency
        && JSON.stringify(applied.zone_multipliers) === JSON.stringify(mult)
      : true; // first mount: no local edits yet

    if (localMatchesApplied) {
      setBaseUnit(String(config.base_unit_usd));
      setFrequency(config.frequency);
      setMult(config.zone_multipliers);
      lastAppliedRef.current = config;
    }
    // else: preserve the user's unsaved edits, ignore this server update
  }, [config, baseUnit, frequency, mult]);

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

        {/* DCA_HIDE (v1.13.0): zone multipliers grid — restore when DCA
            valuation UI is re-enabled. State + save of `mult` is retained
            above so the backend's zone_multipliers field stays populated
            with whatever the database currently has (defaults to the
            Fair-Value-centered curve, all buys effectively 1× base_unit
            while hidden). To restore:
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
        */}
        {/* Suppress unused-var warning while the multipliers editor UI is hidden. */}
        {(() => { void mult; void setMult; void ZONE_ORDER; return null; })()}

        <button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save Strategy"}</button>
      </div>
    </div>
  );
}

function MasterControl({ status, onRefresh }: { status: AutoBuyStatus; onRefresh: () => Promise<unknown> }) {
  const cfg = status.config;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  if (!cfg) return null;
  const enabled = cfg.enabled;
  const pausedReason = cfg.paused_reason;
  const canEnable = !!status.credentials && !!cfg.withdraw_address_whitelisted_at && cfg.consecutive_failures < 3;

  const doEnable = async () => {
    setBusy(true); setToast(null);
    try { await api.enableAutoBuy(); setToast({ kind: "success", message: "Auto-Buy enabled." }); await onRefresh(); }
    catch (err) { setToast({ kind: "error", message: err instanceof Error ? err.message : "Enable failed." }); }
    finally { setBusy(false); }
  };
  const doPause = async () => {
    setBusy(true); setToast(null);
    try { await api.pauseAutoBuy(); setToast({ kind: "success", message: "Auto-Buy paused." }); await onRefresh(); }
    catch (err) { setToast({ kind: "error", message: err instanceof Error ? err.message : "Pause failed." }); }
    finally { setBusy(false); }
  };
  const doExecuteNow = async () => {
    if (!confirm("Run a buy tick now? This respects all caps and will only place a buy if the schedule is due.")) return;
    setBusy(true); setToast(null);
    try { await api.executeAutoBuyNow(); setToast({ kind: "success", message: "Tick executed. Check history." }); await onRefresh(); }
    catch (err) { setToast({ kind: "error", message: err instanceof Error ? err.message : "Execute failed." }); }
    finally { setBusy(false); }
  };

  return (
    <>
      {pausedReason && <PausedBanner reason={pausedReason} />}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: 2 }}>
              {enabled ? <span style={{ color: "var(--green)" }}>● Enabled</span> : <span className="text-dim">○ Paused</span>}
            </div>
            <div className="text-dim" style={{ fontSize: "0.75rem" }}>
              {enabled
                ? cfg.next_run_at
                  ? `Next scheduled tick: ${new Date(cfg.next_run_at * 1000).toLocaleString()}`
                  : "No scheduled tick yet"
                : pausedReason ? `Paused: ${pausedReason}` : "Master switch is off"}
            </div>
            {cfg.consecutive_failures > 0 && (
              <div style={{ fontSize: "0.75rem", color: "var(--amber)", marginTop: 2 }}>
                {cfg.consecutive_failures} consecutive failure{cfg.consecutive_failures === 1 ? "" : "s"} (auto-pause at 3)
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {enabled ? (
              <>
                <button onClick={doExecuteNow} disabled={busy}>{busy ? "…" : "Execute Now"}</button>
                <button onClick={doPause} disabled={busy}>{busy ? "…" : "Pause"}</button>
              </>
            ) : (
              <button onClick={doEnable} disabled={busy || !canEnable} title={!canEnable ? "Connect + whitelist credentials first" : ""}>
                {busy ? "…" : "Enable"}
              </button>
            )}
          </div>
        </div>
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", margin: "0 16px 16px" }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}
      </div>
    </>
  );
}

function PausedBanner({ reason }: { reason: string }) {
  const { title, body } = PAUSED_MESSAGES[reason] ?? { title: "Auto-Buy paused", body: `paused_reason=${reason}` };
  return (
    <div className="alert warning" style={{ marginBottom: 16 }}>
      <span className="alert-icon">⚠</span>
      <div className="alert-body">
        <div className="alert-type">{title}</div>
        <div className="alert-msg">{body}</div>
      </div>
    </div>
  );
}

const PAUSED_MESSAGES: Record<string, { title: string; body: string }> = {
  user_paused:             { title: "Paused by operator",          body: "You can resume Auto-Buy from the master control." },
  no_credentials:          { title: "No Coinbase credentials",     body: "Connect a Coinbase Cloud Key in the integration panel below." },
  credentials_invalid:     { title: "Coinbase credentials invalid", body: "Coinbase rejected the API key. Rotate the key and re-connect." },
  credentials_corrupted:   { title: "Credentials corrupted",       body: "The encrypted key could not be decrypted. Reconnect to repair." },
  address_not_whitelisted: { title: "Withdrawal address not whitelisted", body: "Add the displayed address to Coinbase's allowlist and confirm via the integration panel below." },
  consecutive_failures:    { title: "Auto-paused after 3 failures", body: "Review the purchase history for error messages, then re-enable." },
};
