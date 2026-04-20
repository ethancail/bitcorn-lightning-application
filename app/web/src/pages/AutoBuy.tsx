import { useCallback, useEffect, useState } from "react";
import { api, type AutoBuyStatus, type ValuationCurrent } from "../api/client";
import ValuationTab from "../components/autoBuy/ValuationTab";
import StrategyTab from "../components/autoBuy/StrategyTab";
import InputsTab from "../components/autoBuy/InputsTab";

type TabId = "valuation" | "strategy" | "inputs";

export default function AutoBuy() {
  const [tab, setTab] = useState<TabId>("valuation");
  const [status, setStatus] = useState<AutoBuyStatus | null>(null);
  const [valuation, setValuation] = useState<ValuationCurrent | null>(null);
  const [loading, setLoading] = useState(true);
  const [valuationError, setValuationError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return Promise.allSettled([api.getAutoBuyStatus(), api.getValuationCurrent()]).then(
      ([sR, vR]) => {
        if (sR.status === "fulfilled") setStatus(sR.value);
        if (vR.status === "fulfilled") {
          setValuation(vR.value);
          setValuationError(null);
        } else {
          setValuationError(vR.reason?.message || "valuation_unavailable");
        }
      },
    );
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Auto-Buy Strategy</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Valuation-modulated dollar-cost averaging on Coinbase. Reads the composite Z-score, sizes each buy
          by zone multiplier, parks BTC on Coinbase for the 72h withdraw hold, sweeps weekly to your node's on-chain wallet.
        </p>
      </div>

      {valuationError && tab === "valuation" && (
        <div className="alert warning" style={{ marginBottom: 16 }}>
          <span className="alert-icon">⚠</span>
          <div className="alert-body">
            <div className="alert-type">Valuation unavailable</div>
            <div className="alert-msg">
              Worker returned no data. {valuationError}. The scheduler will refuse to buy if no fresh valuation is available.
            </div>
          </div>
        </div>
      )}

      <div className="tab-bar" style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid var(--border)" }}>
        {(["valuation", "strategy", "inputs"] as TabId[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "10px 16px",
              background: "none",
              border: "none",
              borderBottom: tab === t ? "2px solid var(--text)" : "2px solid transparent",
              color: tab === t ? "var(--text)" : "var(--text-dim)",
              fontWeight: tab === t ? 600 : 400,
              cursor: "pointer",
              fontSize: "0.9375rem",
              marginBottom: -1,
            }}
          >
            {t === "valuation" ? "Valuation Chart" : t === "strategy" ? "DCA Strategy" : "Model Inputs"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading-shimmer" style={{ height: 320, borderRadius: 6 }} />
      ) : (
        <>
          {tab === "valuation" && <ValuationTab valuation={valuation} />}
          {tab === "strategy" && <StrategyTab status={status} valuation={valuation} onRefresh={refresh} />}
          {tab === "inputs" && <InputsTab />}
        </>
      )}
    </div>
  );
}
