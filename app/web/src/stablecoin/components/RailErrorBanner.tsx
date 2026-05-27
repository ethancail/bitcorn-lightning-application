// RailErrorBanner — the single reachable backend-error state per spec
// amendment §9 (revised 2026-05-27, Path A): `network_unreachable`, i.e. the
// browser cannot reach the Bitcorn API container itself.
//
// Worker degradation (JWT rejected or upstream BASE RPC down) does NOT
// surface here. The API serves cached reads, so a degraded Worker shows only
// as the §7 staleness gradient (StaleBanner) — not as a distinct error
// banner. The originally-prescribed `auth_failure` and `upstream_rpc` states
// were dropped in the §9 revision (unreachable under the cache +
// background-sync architecture); they would only return with a future
// "Path B" propagate-through layer.
//
// Copy is split per the revision: a short, scannable primary message (the
// "app is down" contract), with the architectural-honesty detail (the rail
// is non-custodial — the wallet can hit the SettlementRouter on BASE
// directly) behind a "Why?" affordance.

import { useState } from "react";

export default function RailErrorBanner({
  detail,
  onRetry,
}: {
  detail?: string;
  onRetry?: () => void;
}) {
  const [showWhy, setShowWhy] = useState(false);
  return (
    <div className="sub-alert sub-alert-dim-red stablecoin-banner">
      <span className="sub-alert-icon" aria-hidden>✕</span>
      <div className="sub-alert-body">
        <strong>Bitcorn is offline.</strong> Settlement initiation is disabled until reconnected.
        {detail && <span className="sub-error-detail"> ({detail})</span>}
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            className="sub-link sub-link-button"
            aria-expanded={showWhy}
            onClick={() => setShowWhy((v) => !v)}
          >
            {showWhy ? "Hide" : "Why?"}
          </button>
        </div>
        {showWhy && (
          <p className="stablecoin-banner-detail">
            Your wallet can still interact with the SettlementRouter contract on Base directly —
            settlements made this way won't appear in your Bitcorn history until the app is back online.
          </p>
        )}
        {onRetry && (
          <div style={{ marginTop: 8 }}>
            <button className="btn btn-outline btn-sm" onClick={onRetry}>Retry now</button>
          </div>
        )}
      </div>
    </div>
  );
}
