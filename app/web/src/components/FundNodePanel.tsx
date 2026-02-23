import { useEffect, useState } from "react";
import { api, type NodeBalances } from "../api/client";

export default function FundNodePanel() {
  const [balances, setBalances] = useState<NodeBalances | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getNodeBalances().then(setBalances).catch(() => {});
  }, []);

  async function handleFund() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await api.getCoinbaseOnrampUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      setError(e.message ?? "Failed to get funding URL");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="panel fade-in" style={{ marginBottom: 16 }}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">⚡</span>Fund Node
        </span>
      </div>
      <div
        className="panel-body"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}
      >
        <div>
          <div
            style={{
              fontSize: "0.75rem",
              color: "var(--text-3)",
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              marginBottom: 4,
            }}
          >
            On-chain Balance
          </div>
          {balances === null ? (
            <div className="loading-shimmer" style={{ height: 24, width: 140 }} />
          ) : (
            <div style={{ fontFamily: "var(--mono)", fontSize: "1.125rem", color: "var(--text-1)" }}>
              {balances.onchain_sats.toLocaleString()}{" "}
              <span style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>sats</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <button className="btn btn-primary" onClick={handleFund} disabled={loading}>
            {loading ? "Opening…" : "Fund Node via Coinbase →"}
          </button>
          {error && (
            <span style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</span>
          )}
        </div>
      </div>
    </div>
  );
}
