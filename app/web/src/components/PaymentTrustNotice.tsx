// The S1–S6 notice above the subscription panel (treasury-price-trust spec §8).
// Renders nothing when this node may pay. Copy and states: paymentTrust.ts
// (DRAFT until the screenshot gate). Dollars first for S4: the BTC/USD rate
// is fetched only when that state shows; with none, sats alone.

import { useEffect, useState } from "react";
import { api, type ExchangeRate, type SubscriptionStatus } from "../api/client";
import { trustCopy, trustStateOfStatus } from "./paymentTrust";
import { renewalAmount } from "./subscriptionBanner";

export default function PaymentTrustNotice({ status }: { status: SubscriptionStatus }) {
  const state = trustStateOfStatus(status);
  const needsRate = state?.state === "S4_price_above_cap";
  const [rate, setRate] = useState<ExchangeRate | null>(null);
  useEffect(() => {
    if (!needsRate) return;
    let cancelled = false;
    api.getExchangeRate().then((r) => { if (!cancelled) setRate(r); }).catch(() => {});
    return () => { cancelled = true; };
  }, [needsRate]);
  if (!state) return null;
  const usd = rate && rate.state !== "none" ? rate.usd : null;
  const copy = trustCopy(
    state,
    state.state === "S4_price_above_cap" ? renewalAmount(state.price_sats, usd).text : undefined,
  );
  return (
    <div className="sub-alert sub-alert-amber" role="status" data-trust-state={state.state} style={{ marginBottom: 14 }}>
      <span className="sub-alert-icon" aria-hidden>!</span>
      <div className="sub-alert-body">
        <strong>{copy.headline}</strong>
        {copy.body ? <> {copy.body}</> : null}
      </div>
    </div>
  );
}
