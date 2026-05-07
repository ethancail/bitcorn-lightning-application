// app/web/src/components/autoBuy/InputsTab.tsx
import { useEffect, useState } from "react";
import { api, type ValuationInputsResponse } from "../../api/client";

const DISPLAY_ORDER: Array<{ key: string; label: string; category: string; source: string }> = [
  { key: "mvrv",              label: "MVRV Z-Score",          category: "On-chain",      source: "Manual entry" },
  { key: "nvt",               label: "NVT",                    category: "On-chain",      source: "Manual entry" },
  { key: "reserve_risk",      label: "Reserve Risk",           category: "On-chain",      source: "Manual entry" },
  { key: "sopr",              label: "SOPR (30d MA)",          category: "On-chain",      source: "Manual entry" },
  { key: "miner_outflows",    label: "Miner Outflow Multiple", category: "Miner",         source: "Manual entry" },
  { key: "puell",             label: "Puell Multiple",         category: "Miner",         source: "Manual entry" },
  { key: "hash_ribbons",      label: "Hash Ribbons",           category: "Miner",         source: "Manual entry" },
  { key: "difficulty_ribbon", label: "Difficulty Ribbon",      category: "Miner",         source: "Manual entry" },
  { key: "hodl_waves",        label: "HODL Waves",             category: "Behavior",      source: "Manual entry" },
  { key: "stock_to_flow",     label: "Stock-to-Flow",          category: "Market Model",  source: "Computed locally" },
  { key: "ma_200w",           label: "200W Moving Average",    category: "Price Model",   source: "Computed locally" },
  { key: "pi_cycle",           label: "Pi Cycle Top",           category: "Price Model",   source: "Computed locally" },
];

interface InputsTabProps {
  // Bump to trigger a re-fetch (e.g. after a manual Worker refresh).
  // Default 0 — when omitted, the table fetches once on mount.
  refreshKey?: number;
}

export default function InputsTab({ refreshKey = 0 }: InputsTabProps) {
  const [inputs, setInputs] = useState<ValuationInputsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getValuationInputs()
      .then(setInputs)
      .catch((err) => setError(err?.message ?? "unavailable"));
  }, [refreshKey]);

  if (error) {
    return (
      <div className="panel"><div className="panel-body">
        <em className="text-dim">Model inputs unavailable: {error}</em>
      </div></div>
    );
  }
  if (!inputs) {
    return <div className="loading-shimmer" style={{ height: 320, borderRadius: 6 }} />;
  }

  return (
    <div>
      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-header">Composite Valuation Model</div>
        <div className="panel-body">
          <p style={{ marginTop: 0 }}>
            The composite Z-score is a weighted sum of 12 inputs across 4 categories (on-chain, miner, behavior, price models).
            Each input is normalized to its own Z-score (how many standard deviations from its historical mean), then
            multiplied by the weight shown. A positive composite Z means bitcoin is unusually expensive by this model;
            a negative composite means it's unusually cheap.
          </p>
          <p style={{ marginBottom: 0 }}>
            Most inputs are manually entered weekly via the <strong>Valuation Inputs</strong> page (treasury-only).
            Three are computed locally on the Worker from public BTC price history. Weights are fixed in v1 and sum to 1.00.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-body" style={{ padding: 0 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: "0.8125rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "8px 12px" }}>Input</th>
                  <th style={{ padding: "8px 12px" }}>Category</th>
                  <th style={{ padding: "8px 12px" }}>Source</th>
                  <th style={{ padding: "8px 12px", textAlign: "right" }}>Value</th>
                  <th style={{ padding: "8px 12px", textAlign: "right" }}>Z</th>
                  <th style={{ padding: "8px 12px", textAlign: "right" }}>Weight</th>
                  <th style={{ padding: "8px 12px" }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {DISPLAY_ORDER.map(({ key, label, category, source }) => {
                  const row = inputs[key];
                  return (
                    <tr key={key} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "8px 12px", fontWeight: 500 }}>{label}</td>
                      <td style={{ padding: "8px 12px", color: "var(--text-dim)" }}>{category}</td>
                      <td style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: "0.75rem" }}>{row?.source ?? source}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{fmtNum(row?.value)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)", color: colorForZ(row?.z) }}>{fmtNum(row?.z)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{row?.weight != null ? row.weight.toFixed(3) : "—"}</td>
                      <td style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: "0.75rem" }}>{fmtDate(row?.updated_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.abs(n) < 100 ? n.toFixed(2) : n.toFixed(0);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
}

function colorForZ(z: number | null | undefined): string {
  if (z == null || !Number.isFinite(z)) return "var(--text)";
  if (z <= -2) return "#10b981";
  if (z <= -1) return "#34d399";
  if (z <   1) return "var(--text)";
  if (z <   2) return "#fbbf24";
  if (z <   3) return "#f97316";
  return "#ef4444";
}
