import { useEffect, useState } from "react";
import { fetchTreasuryMetrics, TreasuryMetrics, fmtSats } from "../api/client";

const REFRESH_MS = 30_000;

const panelStyle: React.CSSProperties = {
  backgroundColor: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 8,
  padding: 20,
};

const headerStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  margin: "0 0 16px",
  color: "#111827",
};

function netSatsColor(n: number): string {
  if (n > 0) return "#16a34a";
  if (n < 0) return "#dc2626";
  return "#111827";
}

interface YieldColumnProps {
  label: string;
  net_sats: number;
  forwarded_fees_sats: number;
  rebalance_costs_sats: number;
}

function YieldColumn({ label, net_sats, forwarded_fees_sats, rebalance_costs_sats }: YieldColumnProps) {
  return (
    <div style={{ flex: 1 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "#6b7280",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 8,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: netSatsColor(net_sats),
          marginBottom: 10,
          lineHeight: 1.1,
        }}
      >
        {net_sats >= 0 ? "" : "\u2212"}
        {Math.abs(net_sats).toLocaleString()} sats
      </div>

      <div
        style={{
          fontSize: 13,
          color: "#374151",
          marginBottom: 4,
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ color: "#6b7280" }}>Forwarded fees:</span>
        <span>{forwarded_fees_sats.toLocaleString()} sats</span>
      </div>

      <div
        style={{
          fontSize: 13,
          color: "#374151",
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <span style={{ color: "#6b7280" }}>Rebalance costs:</span>
        <span style={{ color: rebalance_costs_sats > 0 ? "#dc2626" : "#374151" }}>
          {rebalance_costs_sats > 0 ? "\u2212" : ""}
          {rebalance_costs_sats.toLocaleString()} sats
        </span>
      </div>
    </div>
  );
}

export default function NetYieldPanel() {
  const [data, setData] = useState<TreasuryMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const metrics = await fetchTreasuryMetrics();
        if (!cancelled) {
          setData(metrics);
          setError(null);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (loading) {
    return (
      <div style={panelStyle}>
        <p style={headerStyle}>Net Yield</p>
        <div style={{ fontSize: 14, color: "#6b7280" }}>Loading…</div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={panelStyle}>
        <p style={headerStyle}>Net Yield</p>
        <div style={{ fontSize: 14, color: "#dc2626" }}>
          Error: {error ?? "No data returned"}
        </div>
      </div>
    );
  }

  const { last_24h, all_time, capital_efficiency } = data;

  return (
    <div style={panelStyle}>
      <p style={headerStyle}>Net Yield</p>

      <div style={{ display: "flex", gap: 24 }}>
        <YieldColumn
          label="Last 24h"
          net_sats={last_24h.net_sats}
          forwarded_fees_sats={last_24h.forwarded_fees_sats}
          rebalance_costs_sats={last_24h.rebalance_costs_sats}
        />

        <div
          style={{
            width: 1,
            backgroundColor: "#e5e7eb",
            alignSelf: "stretch",
            flexShrink: 0,
          }}
        />

        <YieldColumn
          label="All-time"
          net_sats={all_time.net_sats}
          forwarded_fees_sats={all_time.forwarded_fees_sats}
          rebalance_costs_sats={all_time.rebalance_costs_sats}
        />
      </div>

      <div
        style={{
          borderTop: "1px solid #e5e7eb",
          margin: "16px 0",
        }}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div
          style={{
            fontSize: 13,
            color: "#374151",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ color: "#6b7280" }}>Capital deployed:</span>
          <span>{fmtSats(capital_efficiency.capital_deployed_sats)}</span>
        </div>

        <div
          style={{
            fontSize: 13,
            color: "#374151",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ color: "#6b7280" }}>Revenue / 1M sats deployed:</span>
          <span>
            {capital_efficiency.revenue_per_1m_sats_deployed.toFixed(2)} sats
          </span>
        </div>
      </div>
    </div>
  );
}
