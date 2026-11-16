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
//     hint or the error) and "How fast" (slice 1's Choice: time and cost).
//   footer — Technical details on the left; on the right any error, the
//     summary ("<sats> · network fee about <fee>", or with Economy "<sats> ·
//     network fee set by your node") and the connect button.
//
// Locked (the treasury's verified verdict is false): the form is HIDDEN; the
// locked line and the Activate/Renew membership button show instead.
// Upgrade mode: the heading and the current size only, NO form, until Ethan
// decides who pays. It makes no requests.
// The card renders NO NoRateNote: the page shows the no-price sentence once.

import { useId } from "react";
import { useNavigate } from "react-router-dom";
import type { ExchangeRate } from "../../api/client";
import ActionConfirmModal from "../actionConfirm/ActionConfirmModal";
import { Choice } from "../Choice";
import TechnicalDetails, { TechRow } from "../TechnicalDetails";
import { Amount, usableUsd } from "../amount/Amount";
import { formatSats, formatUsd } from "../amount/amountDescriptor";
import {
  ACTIVATE_MEMBERSHIP_PATH,
  CAPACITY_PRESETS,
  CONNECT_TO_HUB_COPY as COPY,
  FEE_SPEED_OPTIONS,
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
        <p className="connect-lead">
          {COPY.upgradeBefore} <Amount sats={currentSats} rate={rate} />{COPY.upgradeAfter}
        </p>
      </div>
    </div>
  );
}

type Reach = "reachable" | "addressKnown" | "checking" | "notReachable";

function ConnectForm({ isPeered, initialCapacity, rate }: { isPeered: boolean; initialCapacity?: number; rate: Rate }) {
  const s = useConnectToHub({ isPeered, initialCapacity });
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
  const fee = FEE_SPEED_OPTIONS.find((o) => o.rate === s.feeRate) ?? FEE_SPEED_OPTIONS[0];
  // Economy has no figure: the node sets its fee (ruling "a", 2026-11-16).
  const feeText = fee.feeSats == null ? null : usd != null ? formatUsd(fee.feeSats, usd).text : formatSats(fee.feeSats);

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
          {/* String keys mapped to rates; Economy's rate is undefined. */}
          <Choice
            name={`${id}-speed-choice`}
            labelledBy={`${id}-speed`}
            value={FEE_SPEED_OPTIONS.find((o) => o.rate === s.feeRate)?.key ?? null}
            onChange={(key) => s.setFeeRate(FEE_SPEED_OPTIONS.find((o) => o.key === key)?.rate)}
            options={FEE_SPEED_OPTIONS.map((opt) => ({ value: opt.key, label: opt.label, description: opt.time, meta: opt.cost }))}
          />
        </section>
      </div>

      <footer className="connect-foot">
        <div className="connect-foot-tech">
          <TechnicalDetails>
            <TechRow label={COPY.nodeId}><span className="ident">{s.hubPubkey}</span></TechRow>
            <TechRow label={COPY.feeRates}>{COPY.feeRatesDetail}</TechRow>
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
          {s.capacity != null && (
            <div className="connect-summary">
              {formatSats(s.capacity)} · {feeText == null ? COPY.networkFeeSetByNode : `${COPY.networkFeeAbout} ${feeText}`}
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
