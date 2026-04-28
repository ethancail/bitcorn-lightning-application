import { useEffect, useState } from "react";
import {
  api,
  type ManualMetricKey,
  type ManualMetricStatus,
  type SubmitValuationInputsRequest,
} from "../api/client";
import InputsTab from "../components/autoBuy/InputsTab";

interface MetricConfig {
  key: ManualMetricKey;
  label: string;
  description: string;
  chartUrl: string;
  typicalRange: string;
  decimals: number;
  // Confirmed Glassnode access required to read this value, verified by the
  // operator on 2026-04-28. "missing" = the chart URL on Glassnode either
  // 404s or the metric has been removed/renamed (Cael needs to investigate).
  tier: "free" | "paid" | "missing";
  tierNote: string;
}

// Descriptions + public charts the operator reads values from.
// Tier values verified by walking each chart link on 2026-04-28.
const METRICS: MetricConfig[] = [
  { key: "mvrv",              label: "MVRV Z-Score",            description: "Market Value / Realised Value deviation",       chartUrl: "https://studio.glassnode.com/charts/market.MvrvZScore",                      typicalRange: "−0.5 to +10",  decimals: 3, tier: "paid",    tierNote: "Paid tier required" },
  { key: "puell",             label: "Puell Multiple",          description: "Miner revenue / 365-day MA",                    chartUrl: "https://studio.glassnode.com/charts/indicators.PuellMultiple",               typicalRange: "0.3 to 4",     decimals: 3, tier: "paid",    tierNote: "Paid tier required" },
  { key: "sopr",              label: "SOPR (30d MA)",           description: "Spent Output Profit Ratio, 30-day MA",          chartUrl: "https://studio.glassnode.com/charts/indicators.Sopr",                        typicalRange: "0.97 to 1.05", decimals: 4, tier: "free",    tierNote: "Free chart view" },
  { key: "reserve_risk",      label: "Reserve Risk",            description: "Confidence-weighted HODL score",                chartUrl: "https://studio.glassnode.com/charts/indicators.ReserveRisk",                 typicalRange: "0.002 to 0.02", decimals: 4, tier: "paid",    tierNote: "Paid tier required" },
  { key: "nvt",               label: "NVT Signal",              description: "Network Value / Transaction Volume (90d)",      chartUrl: "https://studio.glassnode.com/charts/indicators.Nvts",                        typicalRange: "30 to 200",    decimals: 2, tier: "paid",    tierNote: "Paid tier required" },
  { key: "hash_ribbons",      label: "Hash Ribbons",            description: "30d/60d hashrate crossover",                    chartUrl: "https://studio.glassnode.com/charts/indicators.HashRibbon",                  typicalRange: "0.9 to 1.1",   decimals: 3, tier: "paid",    tierNote: "Paid tier required" },
  { key: "difficulty_ribbon", label: "Difficulty Ribbon",       description: "Compression of 9 difficulty MAs",               chartUrl: "https://studio.glassnode.com/charts/indicators.DifficultyRibbonCompression", typicalRange: "0.005 to 0.08", decimals: 4, tier: "paid",    tierNote: "Paid tier required" },
  { key: "hodl_waves",        label: "Realized Cap HODL Waves", description: "1y-2y age-band realized cap share",             chartUrl: "https://studio.glassnode.com/charts/supply.RcapHodlWaves",                    typicalRange: "0.05 to 0.25", decimals: 3, tier: "paid",    tierNote: "Paid tier required (URL fixed: Rcap not Realized)" },
];

function formatRelative(unix: number | null): string {
  if (unix == null) return "never";
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export default function ValuationInput() {
  const [status, setStatus] = useState<ManualMetricStatus[]>([]);
  const [inputs, setInputs] = useState<Record<ManualMetricKey, string>>(() =>
    METRICS.reduce((acc, m) => ({ ...acc, [m.key]: "" }), {} as Record<ManualMetricKey, string>),
  );
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error" | "partial"; message: string } | null>(null);

  const refresh = () => {
    api.getValuationInputStatus()
      .then((r) => setStatus(r.metrics))
      .catch((err) => console.error("[valuation-input] fetch status", err));
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setToast(null);
    try {
      const parsed = {} as SubmitValuationInputsRequest["values"];
      for (const m of METRICS) {
        const n = Number(inputs[m.key]);
        if (!Number.isFinite(n)) {
          setToast({ kind: "error", message: `Invalid number for ${m.label}` });
          setSaving(false);
          return;
        }
        parsed[m.key] = n;
      }
      const res = await api.submitValuationInputs({ values: parsed });
      if (res.ok) {
        setToast({ kind: "success", message: `Saved at ${res.submitted_at}` });
      } else {
        setToast({
          kind: "partial",
          message: `Local saved, Worker failed: ${res.worker_error ?? "unknown"} (HTTP ${res.worker_status})`,
        });
      }
      refresh();
      setInputs(METRICS.reduce((acc, m) => ({ ...acc, [m.key]: "" }), {} as Record<ManualMetricKey, string>));
    } catch (err) {
      setToast({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  const staleOrMissing = status.filter((m) => {
    if (m.submitted_at == null) return true;
    return Math.floor(Date.now() / 1000) - m.submitted_at > 24 * 60 * 60;
  });

  return (
    <div className="page">
      <div className="page-header" style={{ marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Daily Valuation Inputs</h1>
        <p style={{ color: "var(--text-3)", fontSize: "0.875rem", marginTop: 4 }}>
          Enter the 8 Glassnode-sourced metrics once per day. Read each value from the linked chart;
          submissions flow to the Cloudflare Worker which updates the composite Z-score used by Auto-Buy.
        </p>
      </div>

      <GlassnodeAccessSummary />

      {staleOrMissing.length > 0 && (
        <div
          style={{
            padding: "10px 14px",
            background: "rgba(251, 191, 36, 0.1)",
            border: "1px solid rgba(251, 191, 36, 0.3)",
            color: "#fbbf24",
            borderRadius: 6,
            marginBottom: 16,
            fontSize: "0.875rem",
          }}
        >
          <strong>
            {staleOrMissing.length} metric{staleOrMissing.length === 1 ? "" : "s"} need attention:
          </strong>{" "}
          {staleOrMissing.map((m) => m.metric_key).join(", ")}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {METRICS.map((m) => {
          const s = status.find((x) => x.metric_key === m.key);
          return (
            <div
              key={m.key}
              className="panel"
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 1fr 10rem",
                gap: 16,
                alignItems: "center",
                padding: "12px 16px",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.9375rem" }}>{m.label}</div>
                <div style={{ color: "var(--text-3)", fontSize: "0.8125rem", marginTop: 2 }}>
                  {m.description}
                </div>
                <div style={{ color: "var(--text-3)", fontSize: "0.75rem", marginTop: 4 }}>
                  typical range: {m.typicalRange}{" · "}
                  <a href={m.chartUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
                    chart ↗
                  </a>
                  {" · "}
                  <span
                    style={{
                      color:
                        m.tier === "free" ? "#22c55e" :
                        m.tier === "paid" ? "#fbbf24" :
                        "#ef4444",
                      fontWeight: 500,
                    }}
                    title="Glassnode access required (verified by operator 2026-04-28)"
                  >
                    {m.tierNote}
                  </span>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                {s?.value != null ? (
                  <>
                    <div style={{ fontFamily: "var(--mono)", fontSize: "1.0625rem" }}>
                      {s.value.toFixed(m.decimals)}
                    </div>
                    <div style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>
                      {formatRelative(s.submitted_at)}
                      {s.worker_sync_status === "failed" && (
                        <span title={s.worker_sync_error ?? ""} style={{ color: "var(--red)", marginLeft: 4 }}>
                          · worker sync failed
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <div style={{ color: "var(--text-3)", fontSize: "0.875rem" }}>never entered</div>
                )}
              </div>
              <input
                type="number"
                step="any"
                value={inputs[m.key]}
                onChange={(e) => setInputs({ ...inputs, [m.key]: e.target.value })}
                placeholder="—"
                disabled={saving}
                style={{
                  padding: "6px 10px",
                  fontFamily: "var(--mono)",
                  fontSize: "0.9375rem",
                  textAlign: "right",
                  background: "var(--surface-1)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  color: "var(--text-1)",
                }}
              />
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 16, alignItems: "center" }}>
        {toast && (
          <div
            style={{
              padding: "8px 12px",
              borderRadius: 4,
              fontSize: "0.875rem",
              background:
                toast.kind === "success"
                  ? "rgba(34, 197, 94, 0.1)"
                  : toast.kind === "partial"
                  ? "rgba(251, 191, 36, 0.1)"
                  : "rgba(239, 68, 68, 0.1)",
              color:
                toast.kind === "success" ? "#22c55e" : toast.kind === "partial" ? "#fbbf24" : "#ef4444",
              border: `1px solid ${
                toast.kind === "success"
                  ? "rgba(34, 197, 94, 0.3)"
                  : toast.kind === "partial"
                  ? "rgba(251, 191, 36, 0.3)"
                  : "rgba(239, 68, 68, 0.3)"
              }`,
            }}
          >
            {toast.message}
          </div>
        )}
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? "Saving…" : "Save All"}
        </button>
      </div>

      {/* Composite Model Inputs — read-only view of all 12 inputs (8 manual
          above + 3 locally-computed + 1 CryptoQuant). Treasury-only; was
          previously on the Auto-Buy page but that page is visible to member
          nodes, which leaked which metrics the treasury tracks. */}
      <div style={{ marginTop: 48 }}>
        <h2 style={{ marginBottom: 16 }}>Composite Model Inputs</h2>
        <InputsTab />
      </div>
    </div>
  );
}

// Glassnode access summary — surfaces the verified tier requirement for the
// 8 manual inputs. Tier values were walked-and-checked by the operator on
// 2026-04-28 (Kevin clicked each chart link and recorded the gating result).
function GlassnodeAccessSummary() {
  const freeCount = METRICS.filter((m) => m.tier === "free").length;
  const paidCount = METRICS.filter((m) => m.tier === "paid").length;
  const missingCount = METRICS.filter((m) => m.tier === "missing").length;

  return (
    <div
      className="panel"
      style={{
        marginBottom: 16,
        padding: "12px 16px",
        borderLeft: `3px solid ${missingCount > 0 ? "#ef4444" : "#fbbf24"}`,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: "0.9375rem", marginBottom: 4 }}>
        Glassnode access required — paid subscription needed
      </div>
      <div style={{ color: "var(--text-2)", fontSize: "0.8125rem", marginBottom: 8 }}>
        <strong style={{ color: "#22c55e" }}>{freeCount} free</strong> ·{" "}
        <strong style={{ color: "#fbbf24" }}>{paidCount} paid tier</strong>
        {missingCount > 0 && (
          <>
            {" · "}
            <strong style={{ color: "#ef4444" }}>{missingCount} chart missing</strong>
          </>
        )}
        . Verified by operator walking each chart link 2026-04-28.
      </div>
      <div style={{ color: "var(--text-3)", fontSize: "0.75rem" }}>
        With {paidCount} of 8 metrics behind Glassnode's paywall, a paid
        subscription is required to run the SAGE composite as designed. The
        entry-level Glassnode plan (Hobbyist or Standard, ~$30–40/mo at last
        check) typically covers chart viewing for all paid metrics; Pro /
        Enterprise tiers exist mainly for API access. Cael should pick the
        cheapest plan that grants chart access to all {paidCount} paid
        metrics — confirm by signing up for the trial and clicking each
        link below.
        {missingCount > 0 && (
          <>
            {" "}
            <strong style={{ color: "#ef4444" }}>
              ⚠ HODL Waves chart link is broken on Glassnode (2026-04-28).
            </strong>{" "}
            Cael needs to provide either the correct chart slug or a
            substitute metric source before this input can be re-enabled.
          </>
        )}
      </div>
    </div>
  );
}
