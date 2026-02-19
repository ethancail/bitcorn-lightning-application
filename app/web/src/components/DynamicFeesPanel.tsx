import { useEffect, useState } from "react";
import {
  fetchDynamicFeePreview,
  applyDynamicFees,
  ChannelFeeAdjustment,
  truncPubkey,
} from "../api/client";

const panelStyle: React.CSSProperties = {
  backgroundColor: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 20,
};

const headingStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  color: "#111827",
  margin: "0 0 16px 0",
};

const warningBoxStyle: React.CSSProperties = {
  padding: "10px 14px",
  backgroundColor: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: 6,
  fontSize: 13,
  color: "#92400e",
  marginBottom: 12,
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  borderBottom: "2px solid #e5e7eb",
  color: "#6b7280",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  whiteSpace: "nowrap",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderBottom: "1px solid #f3f4f6",
  verticalAlign: "middle",
  color: "#374151",
};

const monoStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 12,
  color: "#374151",
};

const applyButtonStyle: React.CSSProperties = {
  marginTop: 16,
  padding: "8px 20px",
  fontSize: 14,
  fontWeight: 500,
  color: "#fff",
  backgroundColor: "#111827",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
};

const applyButtonDisabledStyle: React.CSSProperties = {
  ...applyButtonStyle,
  opacity: 0.55,
  cursor: "not-allowed",
};

const successBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "10px 14px",
  backgroundColor: "#f0fdf4",
  border: "1px solid #86efac",
  borderRadius: 6,
  fontSize: 13,
  color: "#166534",
};

const errorBoxStyle: React.CSSProperties = {
  marginTop: 12,
  padding: "10px 14px",
  backgroundColor: "#fef2f2",
  border: "1px solid #fca5a5",
  borderRadius: 6,
  fontSize: 13,
  color: "#dc2626",
};

function healthBadgeStyle(classification: string): React.CSSProperties {
  const map: Record<string, { bg: string; color: string; border: string }> = {
    healthy:        { bg: "#f0fdf4", color: "#166534", border: "#86efac" },
    good:           { bg: "#f0fdf4", color: "#166534", border: "#86efac" },
    warning:        { bg: "#fffbeb", color: "#92400e", border: "#fcd34d" },
    poor:           { bg: "#fff7ed", color: "#9a3412", border: "#fdba74" },
    critical:       { bg: "#fef2f2", color: "#991b1b", border: "#fca5a5" },
    idle:           { bg: "#f9fafb", color: "#6b7280", border: "#d1d5db" },
    inactive:       { bg: "#f9fafb", color: "#6b7280", border: "#d1d5db" },
    outbound_starved: { bg: "#fee2e2", color: "#991b1b", border: "#fca5a5" },
    inbound_heavy:  { bg: "#dbeafe", color: "#3b82f6", border: "#93c5fd" },
    weak:           { bg: "#fef3c7", color: "#92400e", border: "#fcd34d" },
  };
  const theme = map[classification.toLowerCase()] ?? { bg: "#f9fafb", color: "#374151", border: "#d1d5db" };
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
    backgroundColor: theme.bg,
    color: theme.color,
    border: `1px solid ${theme.border}`,
    whiteSpace: "nowrap",
  };
}

function fmtImbalance(ratio: number): string {
  return (ratio * 100).toFixed(1) + "%";
}

function targetFeeStyle(target: number, base: number): React.CSSProperties {
  if (target < base) return { color: "#16a34a", fontWeight: 600 };
  if (target > base) return { color: "#dc2626", fontWeight: 600 };
  return { color: "#6b7280" };
}

export default function DynamicFeesPanel() {
  const [adjustments, setAdjustments] = useState<ChannelFeeAdjustment[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<Date | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    fetchDynamicFeePreview()
      .then((data) => {
        if (!cancelled) setAdjustments(data);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setFetchError(err instanceof Error ? err.message : "Failed to load fee preview");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleApplyFees() {
    const confirmed = window.confirm("Apply dynamic fee rates to all active channels in LND?");
    if (!confirmed) return;

    setApplying(true);
    setApplyError(null);
    try {
      await applyDynamicFees();
      setLastApplied(new Date());
    } catch (err: unknown) {
      setApplyError(err instanceof Error ? err.message : "Failed to apply fees");
    } finally {
      setApplying(false);
    }
  }

  const isConfigError =
    fetchError !== null &&
    (fetchError.toLowerCase().includes("base fee") ||
      fetchError.toLowerCase().includes("fee_rate_ppm") ||
      fetchError.toLowerCase().includes("not configured") ||
      fetchError.toLowerCase().includes("403") ||
      fetchError.toLowerCase().includes("setup"));

  const isEmpty = !loading && !fetchError && adjustments.length === 0;

  return (
    <div style={panelStyle}>
      <h2 style={headingStyle}>Dynamic Fee Preview</h2>

      {isConfigError && (
        <div style={warningBoxStyle}>
          Base fee rate not configured. Complete setup first.
        </div>
      )}

      {fetchError && !isConfigError && (
        <div style={errorBoxStyle}>{fetchError}</div>
      )}

      {loading && (
        <div style={{ color: "#6b7280", fontSize: 14 }}>Loading…</div>
      )}

      {isEmpty && (
        <div style={{ color: "#6b7280", fontSize: 14 }}>No active channels</div>
      )}

      {!loading && !fetchError && adjustments.length > 0 && (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Channel</th>
                  <th style={thStyle}>Health</th>
                  <th style={thStyle}>Imbalance</th>
                  <th style={thStyle}>Base</th>
                  <th style={thStyle}>&rarr; Target</th>
                  <th style={thStyle}>Multiplier</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((adj) => (
                  <tr key={adj.channel_id}>
                    <td style={tdStyle}>
                      <span style={monoStyle}>{truncPubkey(adj.channel_id)}</span>
                    </td>
                    <td style={tdStyle}>
                      <span style={healthBadgeStyle(adj.health_classification)}>
                        {adj.health_classification.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td style={tdStyle}>{fmtImbalance(adj.imbalance_ratio)}</td>
                    <td style={{ ...tdStyle, color: "#6b7280" }}>
                      {adj.base_fee_rate_ppm} ppm
                    </td>
                    <td style={tdStyle}>
                      <span style={targetFeeStyle(adj.target_fee_rate_ppm, adj.base_fee_rate_ppm)}>
                        {adj.target_fee_rate_ppm} ppm
                      </span>
                    </td>
                    <td style={tdStyle}>{adj.adjustment_factor}&times;</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            style={applying ? applyButtonDisabledStyle : applyButtonStyle}
            disabled={applying}
            onClick={handleApplyFees}
          >
            {applying ? "Applying…" : "Apply Fees to LND"}
          </button>

          {lastApplied !== null && (
            <div style={successBoxStyle}>
              Fee rates applied successfully at {lastApplied.toLocaleTimeString()}
            </div>
          )}

          {applyError !== null && (
            <div style={errorBoxStyle}>{applyError}</div>
          )}
        </>
      )}
    </div>
  );
}
