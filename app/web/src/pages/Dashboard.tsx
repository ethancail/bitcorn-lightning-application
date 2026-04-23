import { useState, useEffect } from "react";
import { api, type TreasuryMetrics, type TreasuryAlert, type NodeBalances } from "../api/client";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";
import ValuationInputAlertBanner from "../components/ValuationInputAlertBanner";

function fmt(n: number) {
  return n.toLocaleString();
}

function sats(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatSigned(n: number): { text: string; cls: "positive" | "negative" | "neutral" } {
  if (n > 0) return { text: `+${n.toLocaleString()}`, cls: "positive" };
  if (n < 0) return { text: `−${Math.abs(n).toLocaleString()}`, cls: "negative" };
  return { text: "0", cls: "neutral" };
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<TreasuryMetrics | null>(null);
  const [alerts, setAlerts] = useState<TreasuryAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [balances, setBalances] = useState<NodeBalances | null>(null);
  const [fundLoading, setFundLoading] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);

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

  // Balance polling (replaces <NodeBalancePanel />)
  useEffect(() => {
    api.getNodeBalances().then(setBalances).catch(() => {});
    const id = setInterval(() => {
      api.getNodeBalances().then(setBalances).catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  async function handleFund() {
    setFundLoading(true);
    setFundError(null);
    try {
      const { url } = await api.getCoinbaseOnrampUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      const msg = e?.message ?? "failed";
      setFundError(
        msg === "coinbase_not_configured"
          ? "Coinbase Onramp is not configured on this node."
          : msg,
      );
    } finally {
      setFundLoading(false);
    }
  }

  const m24 = metrics?.last_24h;
  const mAll = metrics?.all_time;
  const cap = metrics?.capital_efficiency;
  const liq = metrics?.liquidity.channels_total;

  // Filter out VALUATION_MANUAL_STALE — it has its own dedicated banner with a
  // "Enter now →" link, so skipping it from the generic list avoids double-render.
  const activeAlerts = alerts.filter(
    (a) =>
      (a.severity === "critical" || a.severity === "warning") &&
      a.type !== "VALUATION_MANUAL_STALE",
  );

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

      {/* ── Valuation input staleness banner (dedicated, links to /valuation-input) ── */}
      <ValuationInputAlertBanner alerts={alerts} />

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
