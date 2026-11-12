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

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtSats, type SubscriptionStatus } from "../api/client";
import {
  bannerFor,
  renewalAmount,
  priceChangeBannerFor,
  autoPayAlertContent,
  ALERT_VARIANT_CLASS,
  SEVERITY_ICON,
  type BannerSeverity,
} from "./subscriptionBanner";
import { useAutoPayConfig } from "./useAutoPayConfig";
import PayFromNodeModal from "./PayFromNodeModal";
import { payBlocked } from "./paymentTrust";
import { pendingPaymentCopy, pendingPaymentView } from "./pendingPayment";
import { usePendingPayment } from "./usePendingPayment";

/** The banner's read of the waiting state: the dashboard's status cadence. */
const PENDING_POLL_MS = 60_000;

/** R56 (2), G3 ruling R2: every amount in the banner's text renders as one
 *  unbreakable unit (.sub-amount, as on the panel and in the pay modal), so a
 *  phone never splits "$X (N sats)" between its lines. The words are unchanged: each
 *  occurrence of an amount is wrapped in place. Longest first, so "$X (N
 *  sats)" wins over its own "$X". */
function noWrapAmounts(text: string, amounts: string[]): React.ReactNode {
  const list = [...new Set(amounts.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (list.length === 0) return text;
  const re = new RegExp(`(${list.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);
  return text.split(re).map((part, i) =>
    list.includes(part) ? <span key={i} className="sub-amount">{part}</span> : part,
  );
}

export default function MemberSubscriptionBanner({
  status,
  usdRate = null,
  onWaitingChange,
}: {
  status: SubscriptionStatus | null;
  /** The dashboard's BTC/USD rate, for dollars first in the renewal copy
   *  (drive-mode P2 items 11-12); null shows sats. Passed in, not fetched. */
  usdRate?: number | null;
  /** Told whether the waiting strip shows, so the dashboard can poll the
   *  status faster meanwhile (R45 Polar follow-up, 2026-11-12). */
  onWaitingChange?: (waiting: boolean) => void;
}) {
  const [payModalOpen, setPayModalOpen] = useState(false);
  const { cfg, reload } = useAutoPayConfig();

  const tier = bannerFor(status, Date.now(), usdRate);
  const tierRenders = tier.render && !!status && status.applicable === true;
  // G3 finding 2 (ruled 2026-11-11): while payments are blocked, the tier
  // banner asks for no payment: its pay sentence is hidden and its button
  // disabled. The headline and the S-state alert banners stay.
  const blocked = payBlocked(status);
  const tierBody = blocked ? tier.context : tier.body;
  // drive-mode R45, ruling 1 (Q1): while this node's payment waits for its
  // confirmation, the tier banner is an info strip with no pay button. Read
  // only while a tier banner shows; hidden once a verified status shows the
  // credit (pendingPaymentView).
  const pending = usePendingPayment(tierRenders, PENDING_POLL_MS);
  const waiting = tierRenders ? pendingPaymentView(pending, status) : null;
  const waitingCopy = waiting ? pendingPaymentCopy(waiting, Date.now()) : null;
  const showsWaiting = tierRenders && waitingCopy != null;
  useEffect(() => {
    onWaitingChange?.(showsWaiting);
  }, [showsWaiting, onWaitingChange]);
  useEffect(() => () => onWaitingChange?.(false), [onWaitingChange]);
  // The amounts the banner's text can carry (R56 (2)).
  const price = status?.applicable === true ? renewalAmount(status.price_sats, usdRate) : null;
  const bannerAmounts = price ? [price.text, price.label] : [];

  const priceChange = priceChangeBannerFor(cfg);
  const activeAlerts = cfg?.active_alerts ?? [];

  // Nothing to show — pixel-identical to a healthy member's dashboard.
  if (!tierRenders && !priceChange.render && activeAlerts.length === 0) return null;

  return (
    <>
      {showsWaiting && waitingCopy && (
        <div className={`alert ${ALERT_VARIANT_CLASS.info} member-sub-banner`} data-pending-payment>
          <span className="alert-icon" aria-hidden>{SEVERITY_ICON.info}</span>
          <div className="member-sub-banner-body">
            <div className="member-sub-banner-headline">{waitingCopy.headline}</div>
            <div>{noWrapAmounts(waitingCopy.body, waiting ? [fmtSats(waiting.amount_sats)] : [])}</div>
            <Link className="member-sub-banner-link" to="/settings">
              View subscription →
            </Link>
          </div>
        </div>
      )}

      {tierRenders && !waitingCopy && status && status.applicable === true && (
        <div className={`alert ${ALERT_VARIANT_CLASS[tier.severity!]} member-sub-banner`}>
          <span className="alert-icon" aria-hidden>{SEVERITY_ICON[tier.severity!]}</span>
          <div className="member-sub-banner-body">
            <div className="member-sub-banner-headline">{tier.headline}</div>
            {tierBody && <div>{noWrapAmounts(tierBody, bannerAmounts)}</div>}
            <Link className="member-sub-banner-link" to="/settings">
              View subscription →
            </Link>
          </div>
          <button
            className="btn btn-primary member-sub-banner-action"
            onClick={() => setPayModalOpen(true)}
            disabled={blocked}
          >
            {/* One span for the whole label: .btn is inline-flex with a gap, so a
                text node + amount span would be two flex items with a gap
                between them (seen at the c2 re-shoot). */}
            <span className="sub-amount">{tier.actionLabel}</span>
          </button>
        </div>
      )}

      {/* Price-change banner — non-dismissible until Accept price or Opt out (§6). */}
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
              // Sends the price this banner shows; a 409 means it moved, so
              // reload and show the current one for a fresh acknowledgement.
              onClick={() =>
                void api.acknowledgePriceChange(cfg!.current_price!).then(reload).catch(() => reload())
              }
            >
              {/* "Accept", the word the auto-pay alerts use (G3 ruling R9). */}
              Accept price
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
        const content = autoPayAlertContent(a.type, a.context);
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
