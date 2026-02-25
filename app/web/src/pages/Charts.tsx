import { useState, useEffect } from "react";
import PowerLawChart from "../components/PowerLawChart";
import TradingViewMiniChart from "../components/TradingViewMiniChart";

// ─── Types ───────────────────────────────────────────────────────────────

type Period = "1Y" | "5Y" | "All" | "2042";

type CoinbaseSpotResponse = {
  data: { amount: string };
};

// ─── Constants ───────────────────────────────────────────────────────────

const PERIODS: Period[] = ["1Y", "5Y", "All", "2042"];

const MARKET_WIDGETS = [
  { symbol: "COINBASE:BTCUSD", label: "Bitcoin" },
  { symbol: "AMEX:GLD", label: "Gold" },
  { symbol: "AMEX:CORN", label: "Corn" },
  { symbol: "AMEX:SOYB", label: "Soybeans" },
  { symbol: "AMEX:WEAT", label: "Wheat" },
];

const COINBASE_SPOT = "https://api.coinbase.com/v2/prices/BTC-USD/spot";

// ─── Component ───────────────────────────────────────────────────────────

export default function Charts() {
  const [period, setPeriod] = useState<Period>("All");
  const [currentPrice, setCurrentPrice] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(COINBASE_SPOT)
      .then((r) => r.json())
      .then((json: CoinbaseSpotResponse) => {
        setCurrentPrice(parseFloat(json.data.amount));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Charts</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Bitcoin price analysis and power law trend
        </p>
      </div>

      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">⟠</span>Bitcoin Price &amp; Power Law Trend
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            {PERIODS.map((p) => (
              <button
                key={p}
                className={`btn btn-sm ${p === period ? "btn-primary" : "btn-outline"}`}
                onClick={() => setPeriod(p)}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
        <div className="panel-body">
          {loading ? (
            <div
              className="power-law-chart-container"
              style={{ display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <div
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  color: "var(--text-3)",
                  fontSize: "0.8125rem",
                  letterSpacing: "0.06em",
                }}
              >
                LOADING…
              </div>
            </div>
          ) : (
            <div className="power-law-chart-container">
              <PowerLawChart period={period} currentPrice={currentPrice} />
            </div>
          )}

          {/* Legend */}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "12px 20px",
              marginTop: 16,
              fontFamily: "'IBM Plex Mono', monospace",
              fontSize: "0.6875rem",
            }}
          >
            {[
              { color: "#f59e0b", label: "BTC Price", solid: true },
              { color: "#22c55e", label: "Power Law Trend", solid: true },
              { color: "#ef4444", label: "97.5th Pctl", solid: false },
              { color: "#f97316", label: "83.5th Pctl", solid: false },
              { color: "#3b82f6", label: "16.5th Pctl", solid: false },
              { color: "#8b5cf6", label: "2.5th Pctl", solid: false },
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div
                  style={{
                    width: 16,
                    height: 2,
                    background: item.color,
                    borderRadius: 1,
                    ...(item.solid
                      ? {}
                      : {
                          background: `repeating-linear-gradient(90deg, ${item.color} 0px, ${item.color} 4px, transparent 4px, transparent 6px)`,
                        }),
                  }}
                />
                <span style={{ color: "var(--text-2)" }}>{item.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Market Overview — TradingView Mini Charts */}
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">◈</span>Market Overview
          </span>
        </div>
        <div className="panel-body">
          <div className="tv-mini-chart-grid">
            {MARKET_WIDGETS.map((w) => (
              <TradingViewMiniChart key={w.symbol} symbol={w.symbol} label={w.label} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
