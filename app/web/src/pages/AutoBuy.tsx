import { useEffect, useState } from "react";
import { api, type AutoBuyStatus, type ValuationCurrent } from "../api/client";

export default function AutoBuy() {
  const [status, setStatus] = useState<AutoBuyStatus | null>(null);
  const [valuation, setValuation] = useState<ValuationCurrent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.allSettled([api.getAutoBuyStatus(), api.getValuationCurrent()])
      .then(([sR, vR]) => {
        if (sR.status === "fulfilled") setStatus(sR.value);
        if (vR.status === "fulfilled") setValuation(vR.value);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Auto-Buy Strategy</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Valuation-modulated dollar-cost averaging on Coinbase
        </p>
      </div>
      <div className="panel">
        <div className="panel-body">
          {loading ? <em className="text-dim">Loading…</em> : (
            <pre style={{ fontSize: "0.75rem", overflow: "auto" }}>
              {JSON.stringify({ status, valuation }, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
