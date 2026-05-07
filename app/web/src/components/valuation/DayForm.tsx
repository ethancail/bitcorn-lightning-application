import { useEffect, useState } from "react";
import { api, type DayValues, type ManualMetricKey } from "../../api/client";

// Same metric metadata as the existing flat form. We intentionally re-declare
// rather than import from ValuationInput.tsx so this component has zero
// coupling to the old page during the migration. Once Task B5 swaps the page
// shell to be calendar-driven, the duplicate declaration in ValuationInput.tsx
// goes away.
interface MetricConfig {
  key: ManualMetricKey;
  label: string;
  description: string;
  chartUrl: string;
  typicalRange: string;
  decimals: number;
  tier: "free" | "paid" | "missing";
  tierNote: string;
}

const METRICS: MetricConfig[] = [
  { key: "mvrv",              label: "MVRV Z-Score",            description: "Market Value / Realised Value deviation",       chartUrl: "https://studio.glassnode.com/charts/market.MvrvZScore",                      typicalRange: "−0.5 to +10",  decimals: 3, tier: "paid",    tierNote: "Paid tier required" },
  { key: "puell",             label: "Puell Multiple",          description: "Miner revenue / 365-day MA",                    chartUrl: "https://studio.glassnode.com/charts/indicators.PuellMultiple",               typicalRange: "0.3 to 4",     decimals: 3, tier: "paid",    tierNote: "Paid tier required" },
  { key: "sopr",              label: "SOPR (30d MA)",           description: "Spent Output Profit Ratio, 30-day MA",          chartUrl: "https://studio.glassnode.com/charts/indicators.Sopr",                        typicalRange: "0.97 to 1.05", decimals: 4, tier: "free",    tierNote: "Free chart view" },
  { key: "reserve_risk",      label: "Reserve Risk",            description: "Confidence-weighted HODL score",                chartUrl: "https://studio.glassnode.com/charts/indicators.ReserveRisk",                 typicalRange: "0.002 to 0.02", decimals: 4, tier: "paid",    tierNote: "Paid tier required" },
  { key: "nvt",               label: "NVT Signal",              description: "Network Value / Transaction Volume (90d)",      chartUrl: "https://studio.glassnode.com/charts/indicators.Nvts",                        typicalRange: "30 to 200",    decimals: 2, tier: "paid",    tierNote: "Paid tier required" },
  { key: "hash_ribbons",      label: "Hash Ribbons",            description: "30D MA ÷ 60D MA of hashrate",              chartUrl: "https://studio.glassnode.com/charts/indicators.HashRibbon",                  typicalRange: "0.9 to 1.1",   decimals: 3, tier: "paid",    tierNote: "Paid tier required" },
  { key: "difficulty_ribbon", label: "Difficulty Ribbon",       description: "Compression of 9 difficulty MAs",               chartUrl: "https://studio.glassnode.com/charts/indicators.DifficultyRibbonCompression", typicalRange: "0.005 to 0.08", decimals: 4, tier: "paid",    tierNote: "Paid tier required" },
  { key: "miner_outflows",    label: "Miner Outflows",          description: "Daily BTC volume from miner-tagged addresses",  chartUrl: "https://studio.glassnode.com/charts/transactions.MinersOutflowVolumeSum",    typicalRange: "verify on chart", decimals: 2, tier: "paid",    tierNote: "Verify chart URL + tier on Glassnode before use" },
  { key: "hodl_waves",        label: "Realized Cap HODL Waves", description: "% of realized cap held in 1y–2y band",          chartUrl: "https://studio.glassnode.com/charts/supply.RcapHodlWaves",                    typicalRange: "0.05 to 0.25", decimals: 3, tier: "paid",    tierNote: "Paid tier required (URL fixed: Rcap not Realized)" },
];

interface Props {
  date: string;       // "YYYY-MM-DD"
  onSaved: () => void;
}

export default function DayForm({ date, onSaved }: Props) {
  const [day, setDay] = useState<DayValues | null>(null);
  const [inputs, setInputs] = useState<Record<ManualMetricKey, string>>(() =>
    METRICS.reduce((acc, m) => ({ ...acc, [m.key]: "" }), {} as Record<ManualMetricKey, string>),
  );
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error" | "partial"; msg: string } | null>(null);

  // Apply a server day-payload to local form state. Used by the initial
  // mount-effect (cancel-aware) and by post-submit refresh (fire-and-forget).
  const applyDay = (d: DayValues) => {
    setDay(d);
    const next: Record<ManualMetricKey, string> = {} as Record<ManualMetricKey, string>;
    for (const m of METRICS) {
      const v = d.metrics[m.key]?.value;
      next[m.key] = v == null ? "" : String(v);
    }
    setInputs(next);
  };

  // Initial fetch + re-fetch on date change. Uses a cancellation flag so that
  // a slow response for an old date can't clobber state after the user has
  // already navigated to a new date.
  useEffect(() => {
    let cancelled = false;
    api.getValuationDay(date)
      .then((d) => {
        if (cancelled) return;
        applyDay(d);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[DayForm]", err);
      });
    return () => {
      cancelled = true;
    };
    // applyDay is recreated every render but only consumes setters which are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  // Post-submit refresh. Fire-and-forget; if the user has already navigated
  // away the cancel-aware effect above will overwrite anyway when this resolves.
  const refresh = () => {
    api.getValuationDay(date)
      .then(applyDay)
      .catch((err) => console.error("[DayForm:refresh]", err));
  };

  const submit = async (req: { values?: Partial<Record<ManualMetricKey, number>>; delete?: ManualMetricKey[] }) => {
    setBusy(true);
    setToast(null);
    try {
      const res = await api.submitValuationDay({ date, ...req });
      if (res.ok) setToast({ kind: "success", msg: "Saved" });
      else setToast({ kind: "partial", msg: `Local saved, Worker failed: ${res.worker_error ?? "unknown"}` });
      refresh();
      onSaved();
    } catch (err) {
      setToast({ kind: "error", msg: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const saveAll = () => {
    const values: Partial<Record<ManualMetricKey, number>> = {};
    for (const m of METRICS) {
      const raw = inputs[m.key];
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        setToast({ kind: "error", msg: `Invalid number for ${m.label}` });
        return;
      }
      const existing = day?.metrics[m.key]?.value;
      if (existing === n) continue;
      values[m.key] = n;
    }
    if (Object.keys(values).length === 0) {
      setToast({ kind: "error", msg: "No changes to save" });
      return;
    }
    submit({ values });
  };

  const saveOne = (m: MetricConfig) => {
    const raw = inputs[m.key];
    if (raw === "") {
      setToast({ kind: "error", msg: `${m.label}: enter a value first` });
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      setToast({ kind: "error", msg: `Invalid number for ${m.label}` });
      return;
    }
    submit({ values: { [m.key]: n } as Partial<Record<ManualMetricKey, number>> });
  };

  const deleteOne = (m: MetricConfig) => {
    if (!confirm(`Delete ${m.label} for ${date}?`)) return;
    submit({ delete: [m.key] });
  };

  return (
    <div>
      <div style={{ marginBottom: 16, fontSize: "0.875rem", color: "var(--text-2)" }}>
        Entries for <strong>{date}</strong>. Editing any value upserts (replaces) the existing entry for that day.
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {METRICS.map((m) => {
          const status = day?.metrics[m.key];
          const existing = status?.value;
          return (
            <div key={m.key} className="panel" style={{
              display: "grid",
              gridTemplateColumns: "2fr 1fr 8rem auto auto",
              gap: 12,
              alignItems: "center",
              padding: "10px 14px",
            }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>{m.label}</div>
                <div style={{ color: "var(--text-3)", fontSize: "0.75rem", marginTop: 2 }}>
                  range: {m.typicalRange} ·{" "}
                  <a href={m.chartUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>chart ↗</a>
                </div>
              </div>
              <div style={{ textAlign: "right", fontSize: "0.8125rem", color: "var(--text-3)" }}>
                {existing != null ? `current: ${existing.toFixed(m.decimals)}` : "no entry"}
              </div>
              <input
                type="number"
                step="any"
                value={inputs[m.key]}
                onChange={(e) => setInputs({ ...inputs, [m.key]: e.target.value })}
                placeholder={existing != null ? String(existing) : "—"}
                disabled={busy}
                style={{ padding: "6px 10px", fontFamily: "var(--mono)", textAlign: "right" }}
              />
              <button onClick={() => saveOne(m)} disabled={busy} style={{ padding: "4px 10px" }}>Save</button>
              <button
                onClick={() => deleteOne(m)}
                disabled={busy || existing == null}
                style={{ padding: "4px 10px", color: existing != null ? "var(--red)" : "var(--text-3)" }}
                title={existing == null ? "Nothing to delete" : "Delete this entry"}
              >
                Delete
              </button>
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 16 }}>
        {toast && (
          <span style={{ fontSize: "0.8125rem", color: toast.kind === "success" ? "#22c55e" : toast.kind === "partial" ? "#fbbf24" : "#ef4444" }}>
            {toast.msg}
          </span>
        )}
        <button onClick={saveAll} disabled={busy} className="btn btn-primary">Save All Changes</button>
      </div>
    </div>
  );
}
