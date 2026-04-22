import { useCallback, useEffect, useState } from "react";
import { api, type AutoBuyStatus, type ValuationCurrent } from "../api/client";
import StrategyTab from "../components/autoBuy/StrategyTab";

// DCA_HIDE (v1.13.0): Valuation Chart tab hidden until a sustainable data
// source is sorted out (Glassnode tier, CryptoQuant alternative, or the
// free-data composite using only our locally-computed adapters). To restore:
//   1. Uncomment the ValuationTab import below
//   2. Restore the TabId union + tab state + tab bar render + conditional
//   3. Un-hide the sidebar link to /valuation-input in App.tsx
//   4. Un-hide the Zone Multipliers editor in StrategyTab.tsx
// Backend (scheduler, caps, Worker engine, all KV keys) is unchanged —
// it continues to fetch valuation and use zone multipliers, which default
// to 1.0 (Fair Value) until operators tune them. No code changes required
// to re-enable DCA; it's a UI-only hide.
// import ValuationTab from "../components/autoBuy/ValuationTab";

export default function AutoBuy() {
  const [status, setStatus] = useState<AutoBuyStatus | null>(null);
  const [valuation, setValuation] = useState<ValuationCurrent | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    return Promise.allSettled([api.getAutoBuyStatus(), api.getValuationCurrent()]).then(
      ([sR, vR]) => {
        if (sR.status === "fulfilled") setStatus(sR.value);
        if (vR.status === "fulfilled") setValuation(vR.value);
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
        <h1 style={{ marginBottom: 4 }}>Auto-Buy</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Automated Bitcoin buying on Coinbase. Buys on your configured schedule, parks on Coinbase for the
          72h withdrawal hold, sweeps weekly to your node's on-chain wallet.
        </p>
      </div>

      {loading ? (
        <div className="loading-shimmer" style={{ height: 320, borderRadius: 6 }} />
      ) : (
        <StrategyTab status={status} valuation={valuation} onRefresh={refresh} />
      )}
    </div>
  );
}
