// Severity-aware subscription banner for the member Dashboard (Direction B),
// extended for subscription auto-pay (spec 2026-06-12 §7B).
//
// Sources:
//   - specs/2026-06-11-subscription-discoverability-implementation.md §3 (tier banner)
//   - specs/2026-06-12-subscription-auto-pay-implementation.md §7B (price-change + alerts)
//
// Composition / precedence: the lapsed-tier banner (a standing state) renders
// first and takes visual priority; the price-change banner is independent and
// non-dismissible (acknowledge or opt out to clear); active auto-pay alert
// banners are dismissible (warnings) or a low-key info notice (SUCCEEDED). The
// tier banner path is unchanged — a healthy member with no auto-pay signal
// still sees nothing.

import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type SubscriptionStatus } from "../api/client";
import {
  bannerFor,
  priceChangeBannerFor,
  autoPayAlertContent,
  ALERT_VARIANT_CLASS,
  SEVERITY_ICON,
  type BannerSeverity,
} from "./subscriptionBanner";
import { useAutoPayConfig } from "./useAutoPayConfig";
import PayFromNodeModal from "./PayFromNodeModal";

export default function MemberSubscriptionBanner({
  status,
}: {
  status: SubscriptionStatus | null;
}) {
  const [payModalOpen, setPayModalOpen] = useState(false);
  const { cfg, reload } = useAutoPayConfig();

  const tier = bannerFor(status, Date.now());
  const tierRenders = tier.render && !!status && status.applicable === true;

  const priceChange = priceChangeBannerFor(cfg);
  const activeAlerts = cfg?.active_alerts ?? [];

  // Nothing to show — pixel-identical to a healthy member's dashboard.
  if (!tierRenders && !priceChange.render && activeAlerts.length === 0) return null;

  return (
    <>
      {tierRenders && status && status.applicable === true && (
        <div className={`alert ${ALERT_VARIANT_CLASS[tier.severity!]} member-sub-banner`}>
          <span className="alert-icon" aria-hidden>{SEVERITY_ICON[tier.severity!]}</span>
          <div className="member-sub-banner-body">
            <div className="member-sub-banner-headline">{tier.headline}</div>
            <div>{tier.body}</div>
            <Link className="member-sub-banner-link" to="/settings">
              View subscription →
            </Link>
          </div>
          <button
            className="btn btn-primary member-sub-banner-action"
            onClick={() => setPayModalOpen(true)}
          >
            {tier.actionLabel}
          </button>
        </div>
      )}

      {/* Price-change banner — non-dismissible until Acknowledge or Opt out (§6). */}
      {priceChange.render && (
        <div className="alert warning member-sub-banner">
          <span className="alert-icon" aria-hidden>⚠</span>
          <div className="member-sub-banner-body">
            <div className="member-sub-banner-headline">{priceChange.headline}</div>
            <div>{priceChange.body}</div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-primary member-sub-banner-action"
              onClick={() => void api.acknowledgePriceChange().then(reload).catch(() => {})}
            >
              Acknowledge
            </button>
            <button
              className="btn member-sub-banner-action"
              onClick={() => void api.setAutoPay(false).then(reload).catch(() => {})}
            >
              Opt out of auto-pay
            </button>
          </div>
        </div>
      )}

      {/* Active auto-pay alerts — warnings dismissible, SUCCEEDED a low-key notice (§5/§7B). */}
      {activeAlerts.map((a) => {
        const sev: BannerSeverity = a.severity === "warning" ? "amber" : "info";
        const content = autoPayAlertContent(a.type);
        return (
          <div key={a.id} className={`alert ${ALERT_VARIANT_CLASS[sev]} member-sub-banner`}>
            <span className="alert-icon" aria-hidden>{SEVERITY_ICON[sev]}</span>
            <div className="member-sub-banner-body">
              <div className="member-sub-banner-headline">{content.headline}</div>
              <div>{content.body}</div>
            </div>
            <button
              className="btn member-sub-banner-action"
              onClick={() => void api.dismissAutoPayAlert(a.id).then(reload).catch(() => {})}
            >
              Dismiss
            </button>
          </div>
        );
      })}

      {payModalOpen && status && status.applicable === true && (
        <PayFromNodeModal status={status} onClose={() => setPayModalOpen(false)} />
      )}
    </>
  );
}
