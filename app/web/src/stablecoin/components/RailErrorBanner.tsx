// RailErrorBanner — single component, three variants per spec amendment §9.
//
//   kind="auth_failure"        — JWT auth failure after silent retry
//   kind="upstream_rpc"        — Worker → BASE RPC degraded; reads stale
//                                but write-path through user's wallet
//                                still works
//   kind="network_unreachable" — node can't reach the Worker at all;
//                                full UI block with form disabled
//
// Distinct copy + visual register per spec — the spec calls out that
// merging these would confuse the rare-but-real case where on-chain
// settlement works but Bitcorn's observation is degraded.

export type RailErrorKind = "auth_failure" | "upstream_rpc" | "network_unreachable";

const COPY: Record<RailErrorKind, { headline: string; body: string; alertVariant: "amber" | "dim-red"; }> = {
  auth_failure: {
    headline: "Couldn't authenticate with Bitcorn services.",
    body: "This is usually temporary. Try again in a moment, or check your network.",
    alertVariant: "dim-red",
  },
  upstream_rpc: {
    headline: "BASE network data is temporarily unavailable.",
    body: "Settlement history and balances may be out of date. Sending settlements still works — your wallet talks directly to BASE.",
    alertVariant: "amber",
  },
  network_unreachable: {
    headline: "Bitcorn is offline.",
    body: "Reconnect to the network to view settlements. You can't initiate settlement from this UI while offline.",
    alertVariant: "dim-red",
  },
};

export default function RailErrorBanner({
  kind,
  detail,
  onRetry,
}: {
  kind: RailErrorKind;
  detail?: string;
  onRetry?: () => void;
}) {
  const { headline, body, alertVariant } = COPY[kind];
  return (
    <div className={`sub-alert sub-alert-${alertVariant} stablecoin-banner`}>
      <span className="sub-alert-icon" aria-hidden>
        {alertVariant === "amber" ? "⚠" : "✕"}
      </span>
      <div className="sub-alert-body">
        <strong>{headline}</strong> {body}
        {detail && <span className="sub-error-detail"> ({detail})</span>}
        {onRetry && (
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-outline btn-sm" onClick={onRetry}>Retry now</button>
          </div>
        )}
      </div>
    </div>
  );
}
