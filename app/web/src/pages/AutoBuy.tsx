import { useCallback, useEffect, useState } from "react";
import { api, type AutoBuyStatus, type ValuationCurrent } from "../api/client";
import ValuationTab from "../components/autoBuy/ValuationTab";
import StrategyTab from "../components/autoBuy/StrategyTab";

// Model Inputs tab removed in v1.11.4 — the full input table leaks which
// metrics the treasury tracks, and this page is visible to member nodes.
// The table now lives on the treasury-only /valuation-input page instead.
type TabId = "valuation" | "strategy";

// Shape of a structured error from the /api/valuation/* routes — apiFetch
// attaches { code, status, detail } to the Error it throws. `code` matches
// the API's error-kind discriminator (scope_insufficient / auth_missing /
// auth_invalid / upstream_error / worker_unreachable / worker_not_configured).
interface ApiError extends Error {
  code?: string;
  status?: number;
  detail?: string;
}

// Maps the API's structured error code to a user-facing banner. Each
// branch describes WHY the call failed and what the user can do, not
// the underlying HTTP plumbing — error_kinds collapse into one of
// three operator intents (subscription tier, infra setup, transient).
function describeValuationError(err: ApiError | null): {
  type: string;
  msg: string;
  severity: "warning" | "info";
} | null {
  if (!err) return null;
  switch (err.code) {
    case "scope_insufficient":
      return {
        type: "Subscription tier insufficient",
        msg:
          "Valuation reads require an active subscription. Your token has payment-scope " +
          "only, which authorizes Coinbase Onramp but not the Auto-Buy composite model. " +
          "Pay the monthly subscription to restore full-scope access.",
        severity: "warning",
      };
    case "auth_missing":
      return {
        type: "Not subscribed",
        msg:
          "This node has no subscription token cached. If you've just installed, the first " +
          "refresh runs ~10s after boot — try reloading shortly. If the issue persists, " +
          "your subscription row may not have been allocated yet on the treasury.",
        severity: "info",
      };
    case "auth_invalid":
      return {
        type: "Subscription token issue",
        msg:
          `Your subscription token failed validation (${err.detail ?? "unknown reason"}). ` +
          "Transient signature or expiry failures self-heal on the next refresh; persistent " +
          "errors indicate a treasury key mismatch — contact your operator.",
        severity: "warning",
      };
    case "upstream_error":
      return {
        type: "Worker upstream error",
        msg:
          `The Coinbase Worker is reachable but its upstream returned an error ` +
          `(${err.detail ?? "unknown"}). Usually transient; the scheduler will retry on the ` +
          `next tick.`,
        severity: "warning",
      };
    case "worker_unreachable":
      return {
        type: "Worker unreachable",
        msg:
          "Couldn't reach the Coinbase Worker over the network. Check your node's outbound " +
          "connectivity and that the Worker is deployed at COINBASE_WORKER_URL.",
        severity: "warning",
      };
    case "worker_not_configured":
      return {
        type: "Worker not configured",
        msg:
          "COINBASE_WORKER_URL is not set on this node. Your operator needs to configure it " +
          "via the Umbrel app settings or env_file.",
        severity: "warning",
      };
    default:
      // Fallback for unmapped errors — preserves prior generic-banner UX
      // when the API returns a status we haven't taught the UI about yet.
      return {
        type: "Valuation unavailable",
        msg:
          `Worker returned no data (${err.code ?? "unknown"}). The scheduler will refuse to ` +
          `buy if no fresh valuation is available.`,
        severity: "warning",
      };
  }
}

export default function AutoBuy() {
  const [tab, setTab] = useState<TabId>("valuation");
  const [status, setStatus] = useState<AutoBuyStatus | null>(null);
  const [valuation, setValuation] = useState<ValuationCurrent | null>(null);
  const [loading, setLoading] = useState(true);
  const [valuationError, setValuationError] = useState<ApiError | null>(null);

  const refresh = useCallback(() => {
    return Promise.allSettled([api.getAutoBuyStatus(), api.getValuationCurrent()]).then(
      ([sR, vR]) => {
        if (sR.status === "fulfilled") setStatus(sR.value);
        if (vR.status === "fulfilled") {
          setValuation(vR.value);
          setValuationError(null);
        } else {
          setValuationError(vR.reason as ApiError);
        }
      },
    );
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const errorBanner = describeValuationError(valuationError);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Auto-Buy Strategy</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Valuation-modulated dollar-cost averaging on Coinbase. Reads the composite Z-score, sizes each buy
          by zone multiplier, parks BTC on Coinbase for the 72h withdraw hold, sweeps weekly to your node's on-chain wallet.
        </p>
      </div>

      {errorBanner && tab === "valuation" && (
        <div className={`alert ${errorBanner.severity}`} style={{ marginBottom: 16 }}>
          <span className="alert-icon">{errorBanner.severity === "warning" ? "⚠" : "ⓘ"}</span>
          <div className="alert-body">
            <div className="alert-type">{errorBanner.type}</div>
            <div className="alert-msg">{errorBanner.msg}</div>
          </div>
        </div>
      )}

      <div className="tab-bar" style={{ display: "flex", gap: 4, marginBottom: 24, borderBottom: "1px solid var(--border)" }}>
        {(["valuation", "strategy"] as TabId[]).map((t) => (
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
            {t === "valuation" ? "Valuation Chart" : "DCA Strategy"}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="loading-shimmer" style={{ height: 320, borderRadius: 6 }} />
      ) : (
        <>
          {tab === "valuation" && <ValuationTab valuation={valuation} />}
          {tab === "strategy" && <StrategyTab status={status} valuation={valuation} onRefresh={refresh} />}
        </>
      )}
    </div>
  );
}
