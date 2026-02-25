import { useState, useEffect } from "react";
import { api, type CommodityPrice } from "../api/client";

// ─── Constants ───────────────────────────────────────────────────────────

const COMMODITIES = ["gold", "corn", "soybeans", "wheat"] as const;
type CommodityKey = (typeof COMMODITIES)[number];

const REFRESH_INTERVAL = 60 * 60 * 1000; // 60 minutes

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

// ─── Component ───────────────────────────────────────────────────────────

export default function CommodityPricesPanel() {
  const [prices, setPrices] = useState<Record<CommodityKey, CommodityPrice> | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const load = () => {
      api
        .getCommodityPrices()
        .then((data) => {
          setPrices(data);
          setError(false);
        })
        .catch(() => setError(true));
    };

    load();
    const id = setInterval(load, REFRESH_INTERVAL);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="panel fade-in">
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">◈</span>Commodity Prices
        </span>
      </div>
      <div className="panel-body">
        {error && !prices ? (
          <div className="empty-state">Commodity prices unavailable</div>
        ) : (
          <div className="dashboard-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            {COMMODITIES.map((key) => {
              const item = prices?.[key];
              return (
                <div key={key} className="stat-card">
                  {!prices ? (
                    <>
                      <div className="loading-shimmer" style={{ height: 14, width: "40%", marginBottom: 8 }} />
                      <div className="loading-shimmer" style={{ height: 28, width: "70%" }} />
                    </>
                  ) : item ? (
                    <>
                      <div className="stat-label">{item.label}</div>
                      <div className="stat-value">
                        ${item.price.toFixed(2)}
                      </div>
                      <div className="stat-sub">{item.unit}</div>
                      <div
                        className="stat-sub"
                        style={{ fontSize: "0.625rem", color: "var(--text-3)", marginTop: 2 }}
                      >
                        Updated: {formatDate(item.updated_at)}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="stat-label" style={{ textTransform: "capitalize" }}>
                        {key}
                      </div>
                      <div className="stat-value" style={{ color: "var(--text-3)" }}>
                        Unavailable
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
