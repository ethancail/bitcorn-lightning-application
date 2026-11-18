// SubscriptionPanel — the member's Membership panel on Settings.
//
// Source of truth:
//   - specs/2026-05-11-subscription-stage-5a-jwt-fix-and-member-ui.md §6
//   - specs/2026-05-12-subscription-panel-state-signal-system.md
//   - member-first-run-ui slice 4, the simplified Membership panel: the ruled
//     design (decisions/2026-11-13-member-first-run-ui-four-designs-ruled-…
//     §2–§4) and Ethan's "recs", relayed 2026-11-18 (R1–R9). Its words and
//     its three tiers are membership/membershipDescriptor.ts's.
//
// One panel per state of the discriminated SubscriptionStatus, each laid out
// in the same three tiers: always visible (the mark, the plain sentences, the
// big amount, the cadence, one button, the "Renew automatically" switch); one
// tap away as closed rows; and, only when they apply, the trust notice, the
// waiting notice and the errors.
//
// Polls /api/subscription/status every 15s (§6.4). On 401/503 the panel
// renders a degraded state (loading skeleton or "couldn't load") without
// blocking the rest of the UI.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import {
  api,
  type ExchangeRate,
  type SubscriptionStatus,
  type SubscriptionStatusApplicable,
  type SubscriptionStatusNotApplicable,
} from "../api/client";
import { Pill, type PillKind } from "./Pill";
import PayFromNodeModal from "./PayFromNodeModal";
import PaymentTrustNotice from "./PaymentTrustNotice";
import { depositAddressDisplay, payBlocked } from "./paymentTrust";
import { AutoRenewAbout, AutoRenewSwitch, useAutoRenew, type AutoRenew } from "./AutoPaySection";
import { onrampErrorMessage } from "./subscriptionPayMessages";
import { copyText } from "./copyText";
import { bip21Uri } from "./bip21";
import { rateNote } from "../api/rate";
import { pendingPaymentCopy, pendingPaymentView, type PendingView } from "./pendingPayment";
import { usePendingPayment } from "./usePendingPayment";
import { Amount, usableUsd } from "./amount/Amount";
import { NoRateNote } from "./amount/NoRateNote";
import { inlineAmount } from "./amount/inlineAmount";
import { MEMBERSHIP_COPY as COPY } from "./membership/membershipDescriptor";
import { Sentence } from "./membership/Sentence";
import { holdRate } from "./membership/heldRate";

// The panel's BTC/USD rate, read by every amount through context, so the panel
// shows one price format and the rate's lines once: undefined while it loads
// (sats, no sentence), null when the read failed with no good rate to keep
// (the sentence), or a rate (membership/heldRate.ts, R8).
const RateContext = createContext<ExchangeRate | null | undefined>(undefined);

/** An amount in a sentence: "$X (N sats)", or "N sats" with no rate; one
 *  unbreakable unit on a phone (G3 ruling R2, .sub-amount). */
function useInline(): (sats: number) => string {
  const rate = useContext(RateContext);
  return (sats) => inlineAmount(sats, usableUsd(rate));
}

/** The rate's lines, once per panel, by the big amount: "Price as of …" when
 *  the rate is stale, and the page's one no-price sentence (NoRateNote: never
 *  while the rate loads). */
function RateLines() {
  const rate = useContext(RateContext);
  const dated = rate && rate.state === "stale" ? rateNote(rate) : null;
  return (
    <>
      {dated && <p className="sub-fineprint sub-rate-note">{dated}</p>}
      <NoRateNote rate={rate} />
    </>
  );
}

// drive-mode R45, ruling 1: the payment this node sent that the treasury
// hasn't credited yet, or null (pendingPaymentView decides).
const PendingContext = createContext<PendingView | null>(null);

/** "Payment sent, waiting for confirmation": only when it applies, directly
 *  above the button. The button stays — the pay modal's repeat step already
 *  guards a second send. */
function PendingNotice() {
  const view = useContext(PendingContext);
  if (!view) return null;
  const copy = pendingPaymentCopy(view, Date.now());
  return (
    <div className="sub-alert sub-alert-dashed" role="status" data-pending-payment>
      <span className="sub-alert-icon" aria-hidden>i</span>
      <div className="sub-alert-body">
        <strong>{copy.headline}</strong>
        <div>{copy.body}</div>
      </div>
    </div>
  );
}

/** Handlers shared by every applicable state. */
interface ActionHandlers {
  /** R1: opens the pay modal straight at "Pay from this node". */
  onRenew: () => void;
  onOnramp: () => void;
  onrampLoading: boolean;
  onrampError: string | null;
  /** R4: "Check again" reads the status again (was "Refresh token"). */
  onCheckAgain: () => void;
}

const POLL_INTERVAL_MS = 15_000;
const PENDING_STUCK_THRESHOLD_MS = 90_000; // §6.1 escalation
const RETRY_INDICATOR_TICK_MS = 1_000;

type ViewState =
  | { kind: "loading" }
  | { kind: "ok"; status: SubscriptionStatus }
  | { kind: "auth_error"; statusCode: number; detail?: string }
  | { kind: "infrastructure_error"; detail?: string }
  | { kind: "transport_unreachable"; detail?: string }
  | { kind: "network_error"; detail?: string };

/** Derive a stable string key from a view state — the signal that
 *  identifies which polled-error state the panel is currently in.
 *  Returns null for healthy/transient views that don't render the
 *  state-duration indicator. */
function deriveStateKey(view: ViewState): string | null {
  if (view.kind === "infrastructure_error") return "infrastructure_error";
  if (view.kind === "transport_unreachable") return "transport_unreachable";
  if (view.kind === "network_error") return "network_error";
  if (
    view.kind === "ok" &&
    !view.status.applicable &&
    view.status.reason === "missing"
  ) {
    return "missing";
  }
  return null;
}

/** Track when a non-null stateKey was first entered. Preserves the
 *  timestamp across polls that keep stateKey the same; resets on state
 *  change; clears when stateKey is null. State-entry timestamps persist
 *  across polls, so the indicator reflects real time-in-state (the Stage 5a
 *  units-flip fix). */
function useStateEnteredAt(stateKey: string | null): number | null {
  const [enteredAt, setEnteredAt] = useState<number | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (stateKey === null) {
      lastKeyRef.current = null;
      setEnteredAt(null);
    } else if (stateKey !== lastKeyRef.current) {
      lastKeyRef.current = stateKey;
      setEnteredAt(Date.now());
    }
    // else: same state, preserve enteredAt across this poll
  }, [stateKey]);
  return enteredAt;
}

export default function SubscriptionPanel({ onLoaded }: { onLoaded?: () => void } = {}) {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [pendingSinceMs, setPendingSinceMs] = useState<number | null>(null);
  const [payModalOpen, setPayModalOpen] = useState(false);
  const [onrampLoading, setOnrampLoading] = useState(false);
  const [onrampError, setOnrampError] = useState<string | null>(null);
  const handleOnramp = useCallback(async () => {
    setOnrampLoading(true);
    setOnrampError(null);
    try {
      const { url } = await api.getCoinbaseOnrampUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      // Visible error — NOT the sidebar's silent-catch (decision §3).
      setOnrampError(onrampErrorMessage(e?.code, e?.message));
    } finally {
      setOnrampLoading(false);
    }
  }, []);
  const stateEnteredAt = useStateEnteredAt(deriveStateKey(view));
  // Local pubkey used by the missing state's support-context block. Fetched
  // once on mount; LND identity doesn't change post-boot.
  const [localPubkey, setLocalPubkey] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getNode()
      .then((node) => { if (!cancelled) setLocalPubkey(node.pubkey ?? null); })
      .catch(() => { /* leave null; render falls back gracefully */ });
    return () => { cancelled = true; };
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const status = await api.getSubscriptionStatus();
      setView({ kind: "ok", status });

      // Track stuck-in-not_yet_allocated for the 90s escalation copy.
      if (!status.applicable && status.reason === "not_yet_allocated") {
        setPendingSinceMs((prev) => prev ?? Date.now());
      } else {
        setPendingSinceMs(null);
      }
    } catch (err: any) {
      const statusCode: number | undefined = err?.status;
      const detail: string | undefined = err?.detail ?? err?.message;
      const code: string | undefined = err?.code;
      if (statusCode === 401) {
        setView({ kind: "auth_error", statusCode, detail });
      } else if (statusCode === 503 && code === "treasury_unreachable") {
        // Spec §10 #4 — upstream-service recovery: automatic when the
        // connection restores; Refresh now has no lockout.
        setView({ kind: "transport_unreachable", detail });
      } else if (statusCode === 503) {
        // no_local_token / no_treasury_key — local-side prerequisites.
        setView({ kind: "infrastructure_error", detail });
      } else {
        setView({ kind: "network_error", detail });
      }
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const id = setInterval(() => void fetchStatus(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // The rate, polled with the status. R8: a failed read keeps the last good
  // rate until it is genuinely stale (holdRate), rather than dropping it.
  const [rate, setRate] = useState<ExchangeRate | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .getExchangeRate()
        .then((r) => { if (!cancelled) setRate(r); })
        .catch(() => { if (!cancelled) setRate((prev) => holdRate(prev, Date.now())); });
    void load();
    const id = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // R2 / R8: the auto-pay settings, read ONCE for the panel and passed to the
  // switch, the "About automatic renewal" row and the not-applicable price.
  const auto = useAutoRenew();

  // R45 ruling 1: the waiting state, read with the status, only while the
  // status is applicable.
  const applicableStatus = view.kind === "ok" && view.status.applicable ? view.status : null;
  const pending = usePendingPayment(applicableStatus != null, POLL_INTERVAL_MS);
  const pendingView = applicableStatus ? pendingPaymentView(pending, applicableStatus) : null;

  // Settings' ?focus=membership waits for this (membership-gating B1): the
  // loading skeleton's header is replaced when the status lands, so focus
  // moved to it earlier would be lost.
  const loaded = view.kind !== "loading" && view.kind !== "auth_error";
  useEffect(() => {
    if (loaded) onLoaded?.();
  }, [loaded, onLoaded]);

  // Dispatch.
  if (view.kind === "loading" || view.kind === "auth_error") {
    // 401 path: the token will be re-issued by the refresh scheduler; the
    // skeleton shows so the UI doesn't flash an error before recovery.
    return <LoadingPanel />;
  }
  if (view.kind === "infrastructure_error" || view.kind === "network_error") {
    return (
      <ErrorPanel
        message={view.kind === "infrastructure_error" ? COPY.infraError : COPY.networkError}
        detail={view.detail}
        onRetry={fetchStatus}
        stateEnteredAt={stateEnteredAt}
      />
    );
  }
  if (view.kind === "transport_unreachable") {
    return <TransportUnreachablePanel detail={view.detail} onRetry={fetchStatus} stateEnteredAt={stateEnteredAt} />;
  }

  const { status } = view;
  if (status.applicable) {
    const handlers: ActionHandlers = {
      onRenew: () => setPayModalOpen(true),
      onOnramp: handleOnramp,
      onrampLoading,
      onrampError,
      onCheckAgain: () => void fetchStatus(),
    };
    return (
      <RateContext.Provider value={rate}>
        <PaymentTrustNotice status={status} />
        <PendingContext.Provider value={pendingView}>
          <ApplicablePanel status={status} auto={auto} handlers={handlers} />
        </PendingContext.Provider>
        {payModalOpen && (
          <PayFromNodeModal status={status} startAt="this-node" onClose={() => setPayModalOpen(false)} />
        )}
      </RateContext.Provider>
    );
  }
  return (
    <RateContext.Provider value={rate}>
      <NotApplicablePanel
        status={status}
        pendingSinceMs={pendingSinceMs}
        stateEnteredAt={stateEnteredAt}
        localPubkey={localPubkey}
        monthly={auto.cfg?.current_price ?? null}
        onRetry={fetchStatus}
      />
    </RateContext.Provider>
  );
}

// ─── Shared pieces ──────────────────────────────────────────────

/** The heading and its status mark. */
function PanelHeader({ mark }: { mark?: { kind: PillKind; label: string } }) {
  return (
    <header className="sub-panel-header">
      <div className="sub-panel-title">
        <span className="sub-panel-glyph" aria-hidden>◆</span>
        {/* tabIndex -1: focusable by script only, for /settings?focus=membership. */}
        <h2 tabIndex={-1}>{COPY.heading}</h2>
      </div>
      {mark && <Pill kind={mark.kind} label={mark.label} />}
    </header>
  );
}

/** One closed row, one tap away (slice 3's row pattern). */
function Row({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <details className="membership-row" data-row={id}>
      <summary>{title}</summary>
      <div className="membership-row-body">{children}</div>
    </details>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <div className="membership-rows">{children}</div>;
}

function QrImage({ value, size = 176 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value.toUpperCase(), {
      width: size,
      margin: 1,
      color: { dark: "#18181b", light: "#fdfaf2" },
    })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => { /* ignore — degrades to no QR */ });
    return () => { cancelled = true; };
  }, [value, size]);
  return (
    <div className="sub-qr">
      {dataUrl
        ? <img src={dataUrl} alt="Subscription deposit address QR code" width={size} height={size} />
        : <div className="sub-qr-placeholder" style={{ width: size, height: size }} />}
    </div>
  );
}

function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function daysUntil(ms: number): number {
  return Math.ceil((ms - Date.now()) / 86_400_000);
}

// The negation of daysUntil, so every "N days ago" is one computation (a gate
// 1 screenshot showed 89 against 88 when two were used).
function daysAgo(ms: number): number {
  return -daysUntil(ms);
}

function chunkAddress(addr: string, size = 4): string {
  const out: string[] = [];
  for (let i = 0; i < addr.length; i += size) out.push(addr.slice(i, i + size));
  return out.join(" ");
}

/** Returns the time since `sinceMs` as "N seconds" / "1 minute" / "N minutes",
 *  re-rendering every second (signal system §10). */
function useLiveDuration(sinceMs: number): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), RETRY_INDICATOR_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const ageSec = Math.floor((Date.now() - sinceMs) / 1000);
  if (ageSec < 60) return `${ageSec} second${ageSec === 1 ? "" : "s"}`;
  const ageMin = Math.floor(ageSec / 60);
  return `${ageMin} minute${ageMin === 1 ? "" : "s"}`;
}

function AlertBox({
  variant,
  icon,
  children,
}: {
  variant: "amber" | "orange" | "red" | "dim-red" | "dashed";
  icon: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`sub-alert sub-alert-${variant}`}>
      <span className="sub-alert-icon" aria-hidden>{icon}</span>
      <div className="sub-alert-body">{children}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//   Applicable: true (current / prepay / the lapsed family)
// ═══════════════════════════════════════════════════════════════

/** The "still open / stays open / remains open" sentences are true only while
 *  the treasury's Tier 3 can't close a channel. A missing field (an older
 *  treasury) counts as "dry_run". When "live", they are omitted and nothing
 *  replaces them (L2 / T3). */
function connectionStaysOpen(status: SubscriptionStatusApplicable): boolean {
  return status.close_enforcement !== "live";
}

type Shape = "overdue" | "paidUp" | "due" | "prepay";

function shapeOf(status: SubscriptionStatusApplicable, nowMs: number): Shape | null {
  switch (status.current_tier) {
    // R6: worker_lapsed has the overdue layout, with its own mark.
    case "worker_lapsed":
    case "routing_lapsed":
    // L2: close_due matches routing_lapsed because Tier 3 issues no close
    // (tier3Scheduler.ts is dry-run only). Stage 6 restores close copy only
    // once a close is real.
    case "close_due":
      return "overdue";
    case "prepay":
      return "prepay";
    case "current":
      // drive-mode P2 item 11: from P (paid_through) until hosted services
      // pause the tier is still "current", so "paid up" would be false.
      return nowMs >= status.paid_through ? "due" : "paidUp";
    default:
      return null;
  }
}

function markOf(status: SubscriptionStatusApplicable, shape: Shape): { kind: PillKind; label: string } {
  if (status.current_tier === "worker_lapsed") return { kind: "amber", label: COPY.mark.servicesPaused };
  if (shape === "overdue") return { kind: "orange", label: COPY.mark.overdue };
  if (shape === "prepay") return { kind: "blue", label: COPY.mark.notActive };
  // R34 item 6: due soon is not good news, so its mark is quiet, not green.
  if (shape === "due") return { kind: "quiet", label: COPY.mark.due };
  return { kind: "emerald", label: COPY.mark.paidUp };
}

function ApplicablePanel({
  status,
  auto,
  handlers,
}: {
  status: SubscriptionStatusApplicable;
  auto: AutoRenew;
  handlers: ActionHandlers;
}) {
  const rate = useContext(RateContext);
  const inline = useInline();
  const shape = shapeOf(status, Date.now());
  if (!shape) return null;
  // G3 (ruled 2026-11-11): while payments are blocked, nothing asks for a
  // payment the node won't make; the button is disabled.
  const blocked = payBlocked(status);
  const stay = connectionStaysOpen(status);
  const price = inline(status.price_sats);
  const period = status.period_days;

  const lead =
    shape === "overdue" ? (
      <>
        <p className="membership-lead">{COPY.overdueLead}</p>
        {stay && <p className="membership-lead">{COPY.stillOpen}</p>}
      </>
    ) : shape === "paidUp" ? (
      <p className="membership-lead">{COPY.paidUpLead}</p>
    ) : shape === "due" ? (
      <p className="membership-lead">
        {COPY.dueLead(formatDate(status.grace.worker_until))}
        {!blocked && ` ${COPY.dueAsk}`}
      </p>
    ) : (
      <p className="membership-lead">
        {COPY.prepayLead}
        {!blocked && <> <Sentence text={COPY.prepayAsk(price)} amounts={[price]} /></>}
      </p>
    );

  const amountLabel = shape === "prepay" ? COPY.activateFor : shape === "paidUp" ? COPY.renewsFor : COPY.renewFor;
  const cadence =
    shape === "prepay" ? COPY.cadencePrepay(period)
    : shape === "paidUp" ? COPY.cadenceAhead(period, formatDate(status.paid_through), daysUntil(status.paid_through))
    : COPY.cadencePast(period, formatDate(status.paid_through), daysAgo(status.paid_through));

  return (
    <section className="sub-panel membership-panel" data-shape={shape}>
      <PanelHeader mark={markOf(status, shape)} />
      {lead}

      <div className="membership-amount">
        <div className="membership-amount-label">{amountLabel}</div>
        <Amount sats={status.price_sats} rate={rate} size="hero" />
        <RateLines />
      </div>
      <p className="membership-cadence" data-cadence>{cadence}</p>

      <PendingNotice />
      <div className="membership-action">
        <button className="sub-btn membership-button" onClick={handlers.onRenew} disabled={blocked}>
          {shape === "prepay" ? COPY.payButton : COPY.renewButton}
        </button>
        {!blocked && (
          <p className="membership-button-line"><Sentence text={COPY.uses(price)} amounts={[price]} /></p>
        )}
      </div>

      <AutoRenewSwitch auto={auto} payBlocked={blocked} rate={rate} />

      <Rows>
        <Row title={COPY.row.otherWays} id="other-ways">
          <DepositBlock
            status={status}
            helper={shape === "prepay" ? COPY.sendExactlyActivate(status.price_sats) : COPY.sendExactly(status.price_sats, period)}
            fineprint={shape === "prepay" ? COPY.fineprintPrepay : shape === "overdue" ? COPY.fineprintLapsed : COPY.fineprintCurrent}
          />
          <div className="membership-row-actions">
            <button className="sub-btn" onClick={handlers.onOnramp} disabled={handlers.onrampLoading}>
              {handlers.onrampLoading ? COPY.onrampOpening : <>{COPY.onramp} <span aria-hidden>↗</span></>}
            </button>
            <button className="sub-btn" onClick={handlers.onCheckAgain}>{COPY.checkAgain}</button>
          </div>
          {handlers.onrampError && (
            <p className="sub-error-detail" role="alert">{handlers.onrampError}</p>
          )}
        </Row>

        {shape === "overdue" && (
          <Row title={COPY.row.paused} id="paused">
            {/* R45 Q5 (ruling 5): the services by the names a member sees. */}
            <p>
              {COPY.services}
              {!blocked && <> <Sentence text={COPY.restoreAsk(price)} amounts={[price]} /></>}
            </p>
            <p>{COPY.stillUse}</p>
          </Row>
        )}
        {shape === "prepay" && (
          <Row title={COPY.row.included} id="included">
            <ul className="sub-prepay-bullets">
              {!blocked && <li><span className="sub-bullet-tick">✓</span> {COPY.availableNow}</li>}
              <li><span className="sub-bullet-plus">+</span> {COPY.activatesOnFirst}</li>
            </ul>
          </Row>
        )}

        {shape !== "prepay" && (
          <Row title={COPY.row.next} id="next">
            {shape === "overdue" ? (
              <>
                {/* R45 Q4 (ruling 4): the treasury credits at the first
                    confirmation (api detector.ts, pinned by detector.test.ts). */}
                <p>{COPY.ifRenew(period)}</p>
                {stay && (
                  <>
                    <p>{COPY.ifNotRenew}</p>
                    <p>{COPY.rightNow}</p>
                  </>
                )}
              </>
            ) : (
              <>
                <p>{COPY.renewCounts(period)}</p>
                <p>{COPY.pausesOn(formatDate(status.grace.worker_until))}</p>
              </>
            )}
          </Row>
        )}

        <Row title={COPY.row.about} id="about">
          <AutoRenewAbout auto={auto} pausesOn={status.grace.worker_until} payBlocked={blocked} rate={rate} />
        </Row>

        <Row title={COPY.row.history} id="history">
          <p>{status.last_payment_at ? COPY.lastPayment(formatDate(status.last_payment_at)) : COPY.noPayment}</p>
          <Link className="sub-link" to="/subscription/payments">
            {COPY.seeAll} <span aria-hidden>→</span>
          </Link>
        </Row>
      </Rows>
    </section>
  );
}

function DepositBlock({
  status,
  helper,
  fineprint,
}: {
  status: SubscriptionStatusApplicable;
  helper: string;
  fineprint: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void copyText(status.deposit_address).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [status.deposit_address]);
  // treasury-price-trust C15: no address, QR, URI or copy unless the status is
  // verified and the address is the pinned one. One S-state per panel screen
  // (accepted by Ethan 2026-11-11): the full S-state is the notice above the
  // panel; here, only a pointer to it.
  if (!depositAddressDisplay(status).show) {
    return payBlocked(status) ? <p className="sub-deposit-helper">{COPY.addressHidden}</p> : null;
  }
  return (
    <div className="sub-deposit">
      {/* The QR / BIP-21 amount is the sats, exactly. */}
      <QrImage value={bip21Uri(status.deposit_address, status.price_sats)} />
      <div className="sub-deposit-right">
        <div className="sub-stat-label">{COPY.addressLabel}</div>
        <code className="sub-deposit-address">{chunkAddress(status.deposit_address)}</code>
        <button className="sub-btn sub-deposit-copy" onClick={handleCopy}>
          {copied ? COPY.copied : COPY.copyAddress}
        </button>
        <p className="sub-deposit-helper">{helper}</p>
        <p className="sub-fineprint">{fineprint}</p>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//   Applicable: false (5 reasons)
// ═══════════════════════════════════════════════════════════════

function NotApplicablePanel({
  status,
  pendingSinceMs,
  stateEnteredAt,
  localPubkey,
  monthly,
  onRetry,
}: {
  status: SubscriptionStatusNotApplicable;
  pendingSinceMs: number | null;
  stateEnteredAt: number | null;
  localPubkey: string | null;
  monthly: number | null;
  onRetry: () => void;
}) {
  switch (status.reason) {
    case "external_peer":     return <ExternalPeerRender />;
    case "unclassified":      return <UnclassifiedRender monthly={monthly} />;
    case "not_yet_allocated": return <PendingInitialSyncRender pendingSinceMs={pendingSinceMs} channelAgeSec={status.channel_age_seconds ?? 0} monthly={monthly} onRetry={onRetry} />;
    case "missing":           return <UnexpectedMissingRowRender stateEnteredAt={stateEnteredAt} localPubkey={localPubkey} onRetry={onRetry} />;
    case "no_channel":        return <NoChannelRender />;
  }
}

function ExternalPeerRender() {
  // Signal system §1 + §3: compact, body copy only, no mark, no actions.
  return (
    <section className="sub-panel sub-panel-quiet">
      <PanelHeader />
      <p className="sub-body-copy">{COPY.externalPeer}</p>
    </section>
  );
}

/** The price for a state with no price in its status (drive-mode P2 item 10,
 *  R27(8)): auto-pay's current_price, never a literal; a closed row. */
function PriceRow({ monthly }: { monthly: number | null }) {
  const inline = useInline();
  const price = monthly != null ? inline(monthly) : null;
  return (
    <Rows>
      <Row title={COPY.row.price} id="price">
        <p>{price ? <Sentence text={COPY.priceIs(price)} amounts={[price]} /> : COPY.priceUnknown}</p>
        <RateLines />
      </Row>
    </Rows>
  );
}

function UnclassifiedRender({ monthly }: { monthly: number | null }) {
  return (
    <section className="sub-panel">
      <PanelHeader mark={{ kind: "muted-amber", label: COPY.mark.unclassified }} />
      <AlertBox variant="dashed" icon="i">{COPY.unclassified}</AlertBox>
      {/* No actions: the "Contact operator" button (a dead mailto placeholder)
          was removed by Ethan's ruling, 2026-11-11; the alert says to contact
          BitCorn. */}
      <PriceRow monthly={monthly} />
    </section>
  );
}

function PendingInitialSyncRender({
  pendingSinceMs,
  channelAgeSec,
  monthly,
  onRetry,
}: {
  pendingSinceMs: number | null;
  channelAgeSec: number;
  monthly: number | null;
  onRetry: () => void;
}) {
  const stuck =
    pendingSinceMs !== null &&
    Date.now() - pendingSinceMs > PENDING_STUCK_THRESHOLD_MS;
  return (
    <section className="sub-panel">
      <PanelHeader mark={{ kind: "gray-pulsing", label: COPY.mark.settingUp }} />
      {/* Centered-figure alert per signal system §3. */}
      <div className="sub-centered-figure">
        <div className="sub-pulsing-dots" aria-hidden>
          <span /><span /><span />
        </div>
        <h3 className="sub-centered-headline">{COPY.settingUpHeadline}</h3>
        <p className="sub-centered-body">{COPY.settingUpBody}</p>
        {stuck && (
          <p className="sub-stuck-escalation">
            {COPY.stuck}{" "}
            <button className="sub-link sub-link-button" onClick={onRetry}>
              {COPY.refreshNow} <span aria-hidden>→</span>
            </button>
          </p>
        )}
        <p className="sub-pending-channel-age">{COPY.connectionAge(channelAgeSec)}</p>
      </div>
      <PriceRow monthly={monthly} />
    </section>
  );
}

function UnexpectedMissingRowRender({
  stateEnteredAt,
  localPubkey,
  onRetry,
}: {
  stateEnteredAt: number | null;
  localPubkey: string | null;
  onRetry: () => void;
}) {
  const duration = useLiveDuration(stateEnteredAt ?? Date.now());
  const [locked, setLocked] = useState(false);
  const handleRetry = () => {
    if (locked) return;
    setLocked(true);
    onRetry();
    setTimeout(() => setLocked(false), 2500);
  };
  // The pubkey is the support-context identifier this state's job revolves
  // around (signal system §5): always visible (R6).
  const memberPubkey = localPubkey ?? "—";
  const copyPubkey = useCallback(() => {
    if (!memberPubkey || memberPubkey === "—") return;
    void copyText(memberPubkey);
  }, [memberPubkey]);
  return (
    <section className="sub-panel">
      <PanelHeader mark={{ kind: "dim-red", label: COPY.mark.unavailable }} />
      <AlertBox variant="dim-red" icon="✕">{COPY.missing}</AlertBox>
      <div className="sub-member-id">
        <div className="sub-stat-label">{COPY.memberIdLabel}</div>
        <code className="sub-pubkey">{memberPubkey}</code>
        <button className="sub-btn" onClick={copyPubkey}>{COPY.copyPubkey}</button>
        <p className="sub-fineprint">{COPY.shareWithSupport}</p>
      </div>
      <div className="membership-action">
        <button className="sub-btn" onClick={handleRetry} disabled={locked}>
          {locked ? COPY.trying : <>{COPY.tryNow} <span aria-hidden>→</span></>}
        </button>
      </div>
      <Rows>
        <Row title={COPY.row.details} id="details">
          <p className="sub-retry-indicator">{COPY.checkingEvery(duration)}</p>
          <p>{COPY.missingFooter}</p>
        </Row>
      </Rows>
    </section>
  );
}

function NoChannelRender() {
  return (
    <section className="sub-panel sub-panel-quiet">
      <PanelHeader />
      <p className="sub-body-copy">{COPY.noChannel}</p>
      {/* R45 Q6, as ruled by Ethan 2026-11-11 ("recs" 3). */}
      <div className="membership-action">
        <Link className="sub-btn" to="/dashboard">{COPY.connect} <span aria-hidden>→</span></Link>
      </div>
    </section>
  );
}

// ─── Loading + error variants ───────────────────────────────────

function LoadingPanel() {
  return (
    <section className="sub-panel sub-panel-skeleton">
      <PanelHeader />
      <div className="sub-skeleton-line" style={{ width: "60%" }} />
    </section>
  );
}

function ErrorPanel({
  message,
  detail,
  onRetry,
  stateEnteredAt,
}: {
  message: string;
  detail?: string;
  onRetry: () => void;
  stateEnteredAt: number | null;
}) {
  const duration = useLiveDuration(stateEnteredAt ?? Date.now());
  return (
    <section className="sub-panel">
      <PanelHeader mark={{ kind: "dim-red", label: COPY.mark.couldntLoad }} />
      <AlertBox variant="dim-red" icon="✕">{message}</AlertBox>
      <div className="membership-action">
        <button className="sub-btn" onClick={onRetry}>{COPY.refreshNow} <span aria-hidden>→</span></button>
      </div>
      <Rows>
        <Row title={COPY.row.details} id="details">
          {detail ? <p className="sub-error-detail">({detail})</p> : null}
          <p className="sub-retry-indicator">{COPY.inStateFor(duration)}</p>
        </Row>
      </Rows>
    </section>
  );
}

// Spec §10 #4 — distinct from ErrorPanel (local-side prerequisites) and from
// the missing state (the treasury answers applicable:false, reason:missing).
// Refresh now has no lockout: retry timing is non-deterministic and resolves
// when the tunnel reconnects.
function TransportUnreachablePanel({
  detail,
  onRetry,
  stateEnteredAt,
}: {
  detail?: string;
  onRetry: () => void;
  stateEnteredAt: number | null;
}) {
  const duration = useLiveDuration(stateEnteredAt ?? Date.now());
  return (
    <section className="sub-panel">
      <PanelHeader mark={{ kind: "dim-red", label: COPY.mark.unreachable }} />
      <AlertBox variant="dim-red" icon="✕">{COPY.unreachable}</AlertBox>
      <div className="membership-action">
        <button className="sub-btn" onClick={onRetry}>{COPY.refreshNow} <span aria-hidden>→</span></button>
      </div>
      <Rows>
        <Row title={COPY.row.details} id="details">
          {detail ? <p className="sub-error-detail">({detail})</p> : null}
          <p className="sub-retry-indicator">{COPY.checkingEvery(duration)}</p>
        </Row>
      </Rows>
    </section>
  );
}
