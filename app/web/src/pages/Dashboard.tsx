import { useState, useEffect } from "react";
import { api, type TreasuryMetrics, type TreasuryAlert } from "../api/client";
import NodeBalancePanel from "../components/NodeBalancePanel";
import FundNodePanel from "../components/FundNodePanel";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";

function fmt(n: number) {
  return n.toLocaleString();
}

function sats(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<TreasuryMetrics | null>(null);
  const [alerts, setAlerts] = useState<TreasuryAlert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([
      api.getTreasuryMetrics(),
      api.getAlerts(),
    ]).then(([mR, aR]) => {
      if (mR.status === "fulfilled") setMetrics(mR.value);
      if (aR.status === "fulfilled") setAlerts(aR.value);
      setLoading(false);
    });
  }, []);

  // Poll alerts every 60s
  useEffect(() => {
    const id = setInterval(() => {
      api.getAlerts().then(setAlerts).catch(() => {});
      api.getTreasuryMetrics().then(setMetrics).catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const m24 = metrics?.last_24h;
  const mAll = metrics?.all_time;
  const cap = metrics?.capital_efficiency;
  const liq = metrics?.liquidity.channels_total;

  const activeAlerts = alerts.filter((a) => a.severity === "critical" || a.severity === "warning");

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Treasury Dashboard</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Capital allocation engine
        </p>
      </div>

      <NodeBalancePanel />
      <FundNodePanel />
      <BitcoinPriceGraph />

      {/* ── Alerts (only if present) ──────────────────────────────── */}
      {activeAlerts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
          {activeAlerts.map((a, i) => (
            <div key={i} className={`alert ${a.severity === "critical" ? "critical" : "warning"}`} style={{ marginBottom: 0 }}>
              <span className="alert-icon">{a.severity === "critical" ? "✕" : "⚠"}</span>
              <div className="alert-body">
                <div className="alert-type">{a.title}</div>
                <div className="alert-msg">{a.message}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Treasury Revenue ──────────────────────────────────────── */}
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">◈</span>Treasury Revenue</span>
          {!loading && activeAlerts.length === 0 && (
            <span className="badge badge-green">All systems healthy</span>
          )}
        </div>
        <div className="panel-body">
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[1, 2, 3].map((i) => <div key={i} className="loading-shimmer" style={{ height: 48, borderRadius: 6 }} />)}
            </div>
          ) : !metrics ? (
            <div className="empty-state">Unable to load treasury metrics.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Revenue table */}
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th style={{ textAlign: "right" }}>Last 24h</th>
                      <th style={{ textAlign: "right" }}>All Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ fontWeight: 500 }}>Forwarding Fees</td>
                      <td className="td-num td-mono" style={{ color: "var(--green)" }}>
                        +{fmt(m24?.forwarded_fees_sats ?? 0)}
                      </td>
                      <td className="td-num td-mono" style={{ color: "var(--green)" }}>
                        +{fmt(mAll?.forwarded_fees_sats ?? 0)}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ fontWeight: 500 }}>Rebalance Costs</td>
                      <td className="td-num td-mono" style={{ color: "var(--red)" }}>
                        -{fmt(Math.abs(m24?.rebalance_costs_sats ?? 0))}
                      </td>
                      <td className="td-num td-mono" style={{ color: "var(--red)" }}>
                        -{fmt(Math.abs(mAll?.rebalance_costs_sats ?? 0))}
                      </td>
                    </tr>
                    <tr style={{ borderTop: "2px solid var(--border)" }}>
                      <td style={{ fontWeight: 600 }}>Net Revenue</td>
                      <td className="td-num td-mono" style={{
                        fontWeight: 600,
                        color: (m24?.net_sats ?? 0) >= 0 ? "var(--green)" : "var(--red)",
                      }}>
                        {(m24?.net_sats ?? 0) >= 0 ? "+" : ""}{fmt(m24?.net_sats ?? 0)}
                      </td>
                      <td className="td-num td-mono" style={{
                        fontWeight: 600,
                        color: (mAll?.net_sats ?? 0) >= 0 ? "var(--green)" : "var(--red)",
                      }}>
                        {(mAll?.net_sats ?? 0) >= 0 ? "+" : ""}{fmt(mAll?.net_sats ?? 0)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Capital stats */}
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <div className="stat-card" style={{ flex: "1 1 140px" }}>
                  <div className="stat-label">Capital Deployed</div>
                  <div className="stat-value" style={{ fontSize: "1.125rem" }}>
                    {sats(cap?.capital_deployed_sats ?? 0)}
                  </div>
                  <div className="stat-sub">sats</div>
                </div>
                <div className="stat-card" style={{ flex: "1 1 140px" }}>
                  <div className="stat-label">Active Channels</div>
                  <div className="stat-value" style={{ fontSize: "1.125rem" }}>
                    {liq?.active_count ?? 0}
                  </div>
                  <div className="stat-sub">of {liq?.total_count ?? 0} total</div>
                </div>
                <div className="stat-card" style={{ flex: "1 1 140px" }}>
                  <div className="stat-label">Revenue Yield</div>
                  <div className="stat-value" style={{ fontSize: "1.125rem", color: (cap?.revenue_yield ?? 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                    {fmt(Math.round(cap?.revenue_yield ?? 0))}
                  </div>
                  <div className="stat-sub">sats per 1M deployed</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
