import { useEffect, useState } from "react";
import { api, type NodeBalances } from "../api/client";

function toBtc(sats: number): string {
  return (sats / 100_000_000).toFixed(8);
}

export default function NodeBalancePanel() {
  const [balances, setBalances] = useState<NodeBalances | null>(null);

  useEffect(() => {
    api.getNodeBalances().then(setBalances).catch(() => {});
    const id = setInterval(() => {
      api.getNodeBalances().then(setBalances).catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, []);

  const cards = [
    { label: "Total Node Balance", sats: balances?.total_sats ?? null },
    { label: "Bitcoin Balance",    sats: balances?.onchain_sats ?? null },
    { label: "Lightning Wallet",   sats: balances?.lightning_sats ?? null },
  ];

  return (
    <div className="panel fade-in" style={{ marginBottom: 16 }}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">₿</span>Node Balances
        </span>
      </div>
      <div className="panel-body">
        <div className="dashboard-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
          {cards.map(({ label, sats }) => (
            <div key={label} className="stat-card">
              <div className="stat-label">{label}</div>
              {sats === null ? (
                <div className="loading-shimmer" style={{ height: 28, width: "70%", marginBottom: 6 }} />
              ) : (
                <>
                  <div className="stat-value">{sats.toLocaleString()}</div>
                  <div className="stat-sub">{toBtc(sats)} BTC</div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
