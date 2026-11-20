// The Connect card (member-first-run-ui slice 2, Ethan's rulings relayed
// 2026-11-16). Its state and handlers are useConnectToHub.ts; its words are
// connectToHubDescriptor.ts. MemberDashboard renders it in one panel, with no
// panel title (the card has its own header), at two sites: no connection yet,
// and upgrade mode.
//
//   ONE container: no nested callouts, no coloured left border, no eyebrow.
//   header — the heading, one lead line, and the reachability dot.
//   two columns — "How big" (the joined size control, each size in dollars
//     with sats under it; the box in sats with dollars under it; then the
//     hint or the error) and "How fast" (slice 1's Choice: time and cost;
//     the cost is FeeCost's, "about $0.59" over "~770 sats").
//   footer — Technical details on the left; on the right any error, the
//     summary ("<sats> · network fee about <fee>") and the connect button.
//
// fee-estimates (2026-11-18): the "How fast" options are live
// (components/fees): each option's time is the rounded first-confirmation
// range (P12, "· estimate" under the LND fallback), its cost the live rate ×
// 155 vB (P14), and the checked option is held by key (F3). No estimate → one
// plain line (COPY.feeUnavailable, not red), no figure, the footer "<sats>
// sats" alone, submit blocked (O7; Ethan's "recs", 2026-11-18); above 200
// sat/vB shows its figure, disabled, with the ceiling as the reason (P15).
// From 10 min old, the data's age shows beside the figures (P18).
//
// Locked (the treasury's verified verdict is false): the form is HIDDEN; the
// locked line and the Activate/Renew membership button show instead.
// Upgrade mode: the heading, the current size on its own line (dollars over
// sats), then one sentence; NO form, until Ethan decides who pays. It makes
// no requests.
// The card renders NO NoRateNote: the page shows the no-price sentence once.

import { Fragment, useId } from "react";
import { useNavigate } from "react-router-dom";
import type { ExchangeRate } from "../../api/client";
import ActionConfirmModal from "../actionConfirm/ActionConfirmModal";
import { Choice } from "../Choice";
import TechnicalDetails, { TechRow } from "../TechnicalDetails";
import { Amount, usableUsd } from "../amount/Amount";
import { FeeCost } from "../amount/FeeCost";
import { formatSats, formatUsd } from "../amount/amountDescriptor";
import {
  FEE_COPY,
  FEE_OPTION_LABEL,
  isAboveCeiling,
  ratesDetail,
  shownDataAgeMinutes,
  timeText,
} from "../fees/feeEstimatesDescriptor";
import type { FeeOptionKey } from "../../api/client";
import {
  ACTIVATE_MEMBERSHIP_PATH,
  CAPACITY_PRESETS,
  CONNECT_TO_HUB_COPY as COPY,
} from "./connectToHubDescriptor";
import { useConnectToHub } from "./useConnectToHub";

export { HUB_PUBKEY } from "./connectToHubDescriptor";

type Rate = ExchangeRate | null | undefined;

export default function ConnectToHub({
  isPeered, initialCapacity, rate, upgrade,
}: {
  isPeered: boolean;
  initialCapacity?: number;
  /** undefined while the page's rate loads; null when its read failed. */
  rate: Rate;
  /** Upgrade mode: the member's current connection size. Shows no form. */
  upgrade?: { currentSats: number };
}) {
  if (upgrade) return <UpgradeCard currentSats={upgrade.currentSats} rate={rate} />;
  return <ConnectForm isPeered={isPeered} initialCapacity={initialCapacity} rate={rate} />;
}

/** "Connection submitted": the card's success, and the page's pending panel. */
export function ConnectSubmitted({ txid }: { txid?: string }) {
  return (
    <div className="connect-card">
      <div className="connect-head-text">
        <h2 className="connect-title">{COPY.submittedTitle}</h2>
        <p className="connect-lead">{COPY.submittedMessage}</p>
      </div>
      {txid && (
        <div>
          <div className="connect-label">{COPY.fundingTransaction}</div>
          <div className="connect-txid ident">{txid}</div>
        </div>
      )}
    </div>
  );
}

function UpgradeCard({ currentSats, rate }: { currentSats: number; rate: Rate }) {
  return (
    <div className="connect-card">
      <div className="connect-head-text">
        <h2 className="connect-title">{COPY.upgradeHeading}</h2>
        <div className="connect-upgrade-size"><Amount sats={currentSats} rate={rate} /></div>
        <p className="connect-lead">{COPY.upgradeBody}</p>
      </div>
    </div>
  );
}

type Reach = "reachable" | "addressKnown" | "checking" | "notReachable";

function ConnectForm({ isPeered, initialCapacity, rate }: { isPeered: boolean; initialCapacity?: number; rate: Rate }) {
  const s = useConnectToHub({ isPeered, initialCapacity, rate });
  const id = useId();
  const navigate = useNavigate();

  if (s.success) return <ConnectSubmitted txid={s.success !== "submitted" ? s.success : undefined} />;

  const reach: Reach = isPeered ? "reachable"
    : s.hasAutoSocket ? "addressKnown"
    : s.treasuryInfoLoading ? "checking"
    : "notReachable";

  const header = (
    <header className="connect-head">
      <div className="connect-head-text">
        <h2 className="connect-title">{COPY.heading}</h2>
        <p className="connect-lead">{COPY.lead}</p>
      </div>
      <span className={`connect-reach connect-reach-${reach}`}>
        <span className="connect-dot" aria-hidden />
        {COPY[reach]}
      </span>
    </header>
  );

  if (s.membershipLocked) {
    return (
      <div className="connect-card">
        {header}
        <p className="connect-locked">{COPY.membershipNotPaid}</p>
        <div>
          <button type="button" className="btn btn-primary" onClick={() => navigate(ACTIVATE_MEMBERSHIP_PATH)}>
            {s.membershipLabel}
          </button>
        </div>
      </div>
    );
  }

  const usd = usableUsd(rate);
  const preset = CAPACITY_PRESETS.find((p) => p.value === s.capacity);
  const est = s.fees.estimates;
  const feeSats = s.selectedFee?.cost_sats.open ?? null;
  const feeText = feeSats == null ? null : usd != null ? formatUsd(feeSats, usd).text : formatSats(feeSats);
  const dataAge = shownDataAgeMinutes(est, s.fees.fetchedAtMs, Date.now());

  return (
    <div className="connect-card">
      {header}

      <div className="connect-cols">
        <section className="connect-col">
          <div className="form-label" id={`${id}-size`}>{COPY.howBig}</div>
          <div className="connect-sizes">
            <Choice
              name={`${id}-size-choice`}
              labelledBy={`${id}-size`}
              value={preset?.key ?? null}
              onChange={(key) => {
                const p = CAPACITY_PRESETS.find((q) => q.key === key);
                if (p) s.setCapacity(p.value);
              }}
              options={CAPACITY_PRESETS.map((p) => ({ value: p.key, label: <Amount sats={p.value} rate={rate} /> }))}
            />
          </div>
          <div className="connect-box">
            <div className="connect-input">
              <input
                aria-label={COPY.sizeAriaLabel}
                className="form-input"
                type="text"
                inputMode="numeric"
                value={s.capacity == null ? "" : s.capacity.toLocaleString()}
                onChange={(e) => s.setCapacityFromInput(e.target.value)}
              />
              <span className="connect-unit">{COPY.satsUnit}</span>
            </div>
            {usd != null && s.capacity != null && (
              <div className="connect-box-usd">{formatUsd(s.capacity, usd).text}</div>
            )}
          </div>
          {s.belowMinimum
            ? <div className="connect-error">{COPY.capacityBelowMinimum}</div>
            : <div className="connect-hint">{COPY.capacityHint}</div>}
        </section>

        <section className="connect-col">
          <div className="form-label" id={`${id}-speed`}>{COPY.howFast}</div>
          {/* The value is the option KEY (F3), never the rate: tied rates
              each show their own figure and the checked option stays put. */}
          {s.feeOptions && est ? (
            <Choice<FeeOptionKey>
              name={`${id}-speed-choice`}
              labelledBy={`${id}-speed`}
              value={s.feeKey}
              onChange={(key) => s.setFeeKey(key)}
              options={s.feeOptions.map((opt) => ({
                value: opt.key,
                label: FEE_OPTION_LABEL[opt.key],
                description: timeText(opt),
                meta: <FeeCost sats={opt.cost_sats.open} rate={rate} />,
                disabled: isAboveCeiling(est, opt),
                disabledReason: FEE_COPY.aboveCeiling(est.ceiling_sat_per_vbyte),
              }))}
            />
          ) : s.fees.status === "unavailable" ? (
            <p className="connect-fee-unavailable fee-unavailable">{COPY.feeUnavailable}</p>
          ) : null}
          {dataAge != null && <div className="connect-hint fee-data-age">{FEE_COPY.dataAge(dataAge)}</div>}
        </section>
      </div>

      <footer className="connect-foot">
        <div className="connect-foot-tech">
          <TechnicalDetails>
            <TechRow label={COPY.nodeId}><span className="ident">{s.hubPubkey}</span></TechRow>
            {/* Each unit stays whole (.fee-rate-token, nowrap): TechRow's value
                is break-all, which split "sat/vB" at 390 px. Each "·" is bound
                to the item AFTER it ("· Normal ~4 sat/vB"; the first item
                bare), so the row breaks only at the plain space between units
                and no line ends on a dangling "·" (relayed ruling (b),
                2026-11-19). */}
            <TechRow label={COPY.feeRates}>
              {ratesDetail(est).map((token, i) => (
                <Fragment key={token}>
                  {i > 0 && " "}
                  <span className="fee-rate-token">{i > 0 ? `· ${token}` : token}</span>
                </Fragment>
              ))}
            </TechRow>
            {reach === "notReachable" && (
              <div className="connect-address">
                <label className="form-label">
                  {COPY.addressLabel} <span className="connect-optional">{COPY.optional}</span>
                </label>
                <input
                  aria-label={COPY.addressLabel}
                  className="form-input"
                  type="text"
                  placeholder={COPY.addressPlaceholder}
                  value={s.socket}
                  onChange={(e) => s.setSocket(e.target.value)}
                />
                <div className="connect-hint">{COPY.addressHint}</div>
              </div>
            )}
          </TechnicalDetails>
        </div>
        <div className="connect-foot-act">
          {s.error && <div className="connect-error">{s.error}</div>}
          {s.feeBlocked && s.feeBlocked !== FEE_COPY.unavailable && (
            <div className="connect-error">{s.feeBlocked}</div>
          )}
          {s.capacity != null && s.fees.status !== "loading" && (
            <div className="connect-summary">
              {formatSats(s.capacity)}{feeText != null && ` · ${COPY.networkFeeAbout} ${feeText}`}
            </div>
          )}
          <button className="btn btn-primary" onClick={s.openChannelConfirm} disabled={s.openDisabled}>
            {s.submitting ? COPY.connecting : COPY.connect}
          </button>
        </div>
      </footer>

      <ActionConfirmModal controller={s.confirm} onConfirm={s.handleOpen} />
    </div>
  );
}
