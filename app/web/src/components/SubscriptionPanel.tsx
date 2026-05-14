// SubscriptionPanel — member-facing subscription surface.
//
// Source of truth:
//   - specs/2026-05-11-subscription-stage-5a-jwt-fix-and-member-ui.md §6
//   - specs/2026-05-12-subscription-panel-state-signal-system.md
//
// Renders one of eleven panel states dispatched by the discriminated
// SubscriptionStatus response shape. Signal-system rules are the
// authoritative reference for visual treatment per state.
//
// Polls /api/subscription/status every 15s (§6.4). On 401/503 the
// panel renders a degraded state (loading-skeleton or "couldn't load"
// error) without blocking the rest of the UI.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import {
  api,
  fmtSats,
  type SubscriptionStatus,
  type SubscriptionStatusApplicable,
  type SubscriptionStatusNotApplicable,
  type SubscriptionTier,
} from "../api/client";

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

export default function SubscriptionPanel() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [pendingSinceMs, setPendingSinceMs] = useState<number | null>(null);
  const [lastFetchAt, setLastFetchAt] = useState<number>(Date.now());
  // Local pubkey used by unexpected_missing_row's support-context block.
  // Fetched once on mount; LND identity doesn't change post-boot. Null
  // until first fetch completes — the render falls back to a neutral
  // placeholder during the brief window.
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
      setLastFetchAt(Date.now());

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
        // Spec §10 #4 — distinct view kind for upstream-service-recovery
        // shape: panel knows recovery is automatic when the connection
        // restores; Refresh-now action has no lockout (matching the
        // "upstream service recovery" UX expectation rather than
        // "deterministic retry against a definitive answer").
        setView({ kind: "transport_unreachable", detail });
      } else if (statusCode === 503) {
        // no_local_token / no_treasury_key — local-side prerequisites
        // not satisfied; recovery requires the local refresh scheduler
        // to complete a tick.
        setView({ kind: "infrastructure_error", detail });
      } else {
        setView({ kind: "network_error", detail });
      }
      setLastFetchAt(Date.now());
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const id = setInterval(() => void fetchStatus(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchStatus]);

  // Dispatch.
  if (view.kind === "loading") {
    return <LoadingPanel />;
  }
  if (view.kind === "auth_error") {
    // 401 path: token will be re-issued by the refresh scheduler;
    // panel shows loading-skeleton so the UI doesn't flash an error
    // before recovery.
    return <LoadingPanel />;
  }
  if (view.kind === "infrastructure_error") {
    // 503 + no_local_token / no_treasury_key — local-side prerequisites
    // not satisfied. Distinct from auth — show the error state with
    // retry affordance.
    return (
      <ErrorPanel
        message="Couldn't load subscription state — infrastructure not ready."
        detail={view.detail}
        onRetry={fetchStatus}
        lastFetchAt={lastFetchAt}
      />
    );
  }
  if (view.kind === "transport_unreachable") {
    // Spec §10 #4 — 503 + treasury_unreachable. Treasury can't be
    // reached from this node. Self-heals when the connection comes
    // back; Refresh-now action without lockout.
    return (
      <TransportUnreachablePanel
        detail={view.detail}
        onRetry={fetchStatus}
        lastFetchAt={lastFetchAt}
      />
    );
  }
  if (view.kind === "network_error") {
    return (
      <ErrorPanel
        message="Couldn't load subscription state."
        detail={view.detail}
        onRetry={fetchStatus}
        lastFetchAt={lastFetchAt}
      />
    );
  }

  const { status } = view;
  if (status.applicable) {
    return (
      <ApplicablePanel
        status={status}
        onRefresh={fetchStatus}
      />
    );
  }
  return (
    <NotApplicablePanel
      status={status}
      pendingSinceMs={pendingSinceMs}
      lastFetchAt={lastFetchAt}
      localPubkey={localPubkey}
      onRetry={fetchStatus}
    />
  );
}

// ─── Header (brand-stable per signal system §1) ──────────────────

function PanelHeader({ pill }: { pill?: React.ReactNode }) {
  return (
    <header className="sub-panel-header">
      <div className="sub-panel-title">
        <span className="sub-panel-glyph" aria-hidden>◆</span>
        <h2>Subscription</h2>
      </div>
      {pill}
    </header>
  );
}

// ─── Pill component (per signal system §2) ──────────────────────

type PillKind =
  | "emerald" | "blue" | "gray-pulsing" | "muted-amber"
  | "amber" | "orange" | "red" | "dim-red";

function Pill({ kind, label }: { kind: PillKind; label: string }) {
  return (
    <span className={`sub-pill sub-pill-${kind}`}>
      <span className="sub-pill-dot" aria-hidden />
      {label}
    </span>
  );
}

// ─── Bracket heading (per signal system §5) ─────────────────────

function BracketHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="sub-bracket-heading">
      <span className="sub-bracket-label">[ {children} ]</span>
      <span className="sub-bracket-rule" />
    </div>
  );
}

// ─── QR code (cream-on-dark per signal system §1) ───────────────

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

// ─── Helpers ─────────────────────────────────────────────────────

function formatDate(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function daysUntil(ms: number): number {
  return Math.ceil((ms - Date.now()) / 86_400_000);
}

function daysAgo(ms: number): number {
  return Math.ceil((Date.now() - ms) / 86_400_000);
}

function relativePaidThrough(ms: number): string {
  const days = daysUntil(ms);
  if (days < 0) return `${-days}d ago`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 60) return `in ${days}d`;
  return `in ${Math.round(days / 30)}mo`;
}

function chunkAddress(addr: string, size = 4): string {
  const out: string[] = [];
  for (let i = 0; i < addr.length; i += size) out.push(addr.slice(i, i + size));
  return out.join(" ");
}

function bip21Uri(address: string, amountSats: number): string {
  const btc = (amountSats / 1e8).toFixed(8);
  return `bitcoin:${address}?amount=${btc}`;
}

function tierToPill(tier: SubscriptionTier): { kind: PillKind; label: string } {
  switch (tier) {
    case "current":         return { kind: "emerald", label: "current" };
    case "prepay":          return { kind: "blue", label: "prepay" };
    case "worker_lapsed":   return { kind: "amber", label: "services paused" };
    case "routing_lapsed":  return { kind: "orange", label: "routing paused" };
    case "close_due":       return { kind: "red", label: "pay to halt close" };
  }
}

// ─── Live-updating "X seconds ago" (signal system §10) ──────────

function useLiveAgo(sinceMs: number): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), RETRY_INDICATOR_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const ageSec = Math.floor((Date.now() - sinceMs) / 1000);
  if (ageSec < 60) return `${ageSec} second${ageSec === 1 ? "" : "s"} ago`;
  const ageMin = Math.floor(ageSec / 60);
  return `${ageMin} minute${ageMin === 1 ? "" : "s"} ago`;
}

// ─── Stat cell (per signal system §6) ───────────────────────────

function Stat({
  label,
  value,
  suffix,
  accent,
  pendingValue,
}: {
  label: string;
  value: string;
  suffix?: string;
  accent?: PillKind;
  pendingValue?: boolean;
}) {
  return (
    <div className={`sub-stat${pendingValue ? " sub-stat-pending" : ""}`}>
      <div className="sub-stat-label">{label}</div>
      <div className={`sub-stat-value${accent ? ` sub-stat-accent-${accent}` : ""}`}>{value}</div>
      {suffix && <div className={`sub-stat-suffix${accent ? ` sub-stat-accent-${accent}` : ""}`}>{suffix}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//   Applicable: true (current / prepay / lapsed family)
// ═══════════════════════════════════════════════════════════════

function ApplicablePanel({
  status,
  onRefresh,
}: {
  status: SubscriptionStatusApplicable;
  onRefresh: () => void;
}) {
  if (status.current_tier === "current")        return <CurrentRender   status={status} onRefresh={onRefresh} />;
  if (status.current_tier === "prepay")         return <PrepayRender    status={status} onRefresh={onRefresh} />;
  if (status.current_tier === "worker_lapsed")  return <WorkerLapsedRender status={status} onRefresh={onRefresh} />;
  if (status.current_tier === "routing_lapsed") return <RoutingLapsedRender status={status} onRefresh={onRefresh} />;
  if (status.current_tier === "close_due")      return <CloseDueRender   status={status} onRefresh={onRefresh} />;
  return null;
}

// ─── current ─────────────────────────────────────────────────────

function CurrentRender({
  status,
  onRefresh,
}: {
  status: SubscriptionStatusApplicable;
  onRefresh: () => void;
}) {
  const pill = tierToPill("current");
  return (
    <section className="sub-panel">
      <PanelHeader pill={<Pill kind={pill.kind} label={pill.label} />} />
      <p className="sub-tagline">
        Your access to channel routing and hosted services is paid up.
      </p>
      <StatsGrid status={status} accent="emerald" />
      <DepositBlock
        status={status}
        captionSats={status.price_sats}
        helper="Send 50,000 sats to renew for one month."
        fineprint="This address is yours for the lifetime of your membership. Payments are detected automatically on first confirmation."
      />
      <BracketHeading>ACTIONS</BracketHeading>
      <ActionsRow
        primary={<button className="sub-btn">Renew now <span aria-hidden>→</span></button>}
        secondary={<button className="sub-btn" onClick={onRefresh}>Refresh token</button>}
        tertiary={<Link className="sub-link" to="/subscription/payments">View payment history <span aria-hidden>→</span></Link>}
      />
    </section>
  );
}

// ─── prepay ──────────────────────────────────────────────────────

function PrepayRender({
  status,
}: {
  status: SubscriptionStatusApplicable;
  onRefresh: () => void;
}) {
  const pill = tierToPill("prepay");
  return (
    <section className="sub-panel">
      <PanelHeader pill={<Pill kind={pill.kind} label={pill.label} />} />
      <p className="sub-tagline">
        You have <strong>payment access</strong> until your first payment. Send {fmtSats(status.price_sats)} to activate full membership.
      </p>
      <ul className="sub-prepay-bullets">
        <li><span className="sub-bullet-tick">✓</span> <strong>Available now</strong> — Coinbase Onramp for buying BTC, BTC/USD price reads, and the address below for receiving your first payment.</li>
        <li><span className="sub-bullet-plus">+</span> <strong>Activates on first payment</strong> — Lightning routing through the treasury, full hosted services, valuation engine, and complete dashboard.</li>
      </ul>
      <div className="sub-stats">
        <Stat label="MONTHLY" value={status.price_sats.toLocaleString()} suffix="sats" />
        <Stat label="PAID THROUGH" value="on first payment" suffix={`+${status.period_days} days`} accent="blue" pendingValue />
        <Stat label="LAST PAYMENT" value="—" suffix="none yet" pendingValue />
      </div>
      <DepositBlock
        status={status}
        captionSats={status.price_sats}
        helper={`Send ${fmtSats(status.price_sats)} to activate.`}
        fineprint="This address is yours for the lifetime of your membership. Don't have BTC on hand? Use Coinbase Onramp from the Buy Bitcoin tab — funds land in this wallet."
      />
      <BracketHeading>ACTIONS</BracketHeading>
      <ActionsRow
        primary={<button className="sub-btn">Open Coinbase Onramp <span aria-hidden>↗</span></button>}
        secondary={<button className="sub-btn">I have BTC — pay {fmtSats(status.price_sats)}</button>}
      />
    </section>
  );
}

// ─── lapsed family (worker_lapsed / routing_lapsed / close_due) ─

function WorkerLapsedRender({
  status,
}: {
  status: SubscriptionStatusApplicable;
  onRefresh: () => void;
}) {
  const lapsedDays = daysAgo(status.paid_through);
  const daysToRouting = Math.max(0, daysUntil(status.grace.routing_until));
  return (
    <section className="sub-panel">
      <PanelHeader pill={<Pill kind="amber" label="services paused" />} />
      <AlertBox variant="amber" icon="⚠">
        Your subscription lapsed <strong>{lapsedDays} day{lapsedDays === 1 ? "" : "s"}</strong> ago. Price quotes and valuation are paused. Channel routing still works. Renewing restores the paused services within ~15 seconds.
      </AlertBox>
      <p className="sub-reassure">
        <span className="sub-bullet-tick">✓</span> You can still use <strong>Coinbase Onramp</strong> to buy BTC and renew your subscription, route Lightning payments through the treasury, and view your dashboard.
      </p>
      <StatsGrid status={status} accent="amber" />
      <DepositBlock
        status={status}
        captionSats={status.price_sats}
        helper={`Send ${fmtSats(status.price_sats)} to renew for ${status.period_days} days.`}
        fineprint="Don't have BTC on hand? Use Coinbase Onramp from the Buy Bitcoin tab — it's still available during the services-paused state. Funds you buy land in this same wallet."
      />
      <BracketHeading>WHAT HAPPENS NEXT</BracketHeading>
      <Timeline>
        <TimelineRow marker="·">
          <strong>If you renew</strong> — recovery is fully in-app. Buy BTC via Onramp or send from a wallet you already have. Payment is detected within ~15 seconds; price quotes and valuation come back online and your paid-through date advances by {status.period_days} days.
        </TimelineRow>
        <TimelineRow marker="!" tone="amber">
          <strong>If you don't renew within ~{daysToRouting} more days</strong> — channel routing also pauses. Your channel stays open and your funds stay yours; routing can be restored by renewing.
        </TimelineRow>
      </Timeline>
      <BracketHeading>ACTIONS</BracketHeading>
      <ActionsRow
        primary={<button className="sub-btn">Renew ({fmtSats(status.price_sats)}) <span aria-hidden>→</span></button>}
        secondary={<button className="sub-btn">Buy BTC with card <span aria-hidden>↗</span></button>}
        tertiary={<Link className="sub-link" to="/subscription/payments">View payment history <span aria-hidden>→</span></Link>}
      />
    </section>
  );
}

function RoutingLapsedRender({
  status,
}: {
  status: SubscriptionStatusApplicable;
  onRefresh: () => void;
}) {
  const lapsedDays = daysAgo(status.paid_through);
  const daysToClose = Math.max(0, daysUntil(status.grace.close_at));
  return (
    <section className="sub-panel">
      <PanelHeader pill={<Pill kind="orange" label="routing paused" />} />
      <AlertBox variant="orange" icon="⚠">
        Your subscription lapsed <strong>{lapsedDays} day{lapsedDays === 1 ? "" : "s"}</strong> ago. Lightning routing through the treasury is paused, along with price quotes and valuation. Your channel is still open and your funds are safe — but if you don't renew, your channel will be closed in about <strong>{daysToClose} more days</strong>.
      </AlertBox>
      <p className="sub-reassure">
        <span className="sub-bullet-tick">✓</span> You can still use <strong>Coinbase Onramp</strong> to buy BTC and renew, and monitor your channel state from this dashboard.
      </p>
      <StatsGrid status={status} accent="orange" />
      <DepositBlock
        status={status}
        captionSats={status.price_sats}
        helper={`Send ${fmtSats(status.price_sats)} to renew for ${status.period_days} days.`}
        fineprint="Don't have BTC on hand? Use Coinbase Onramp from the Buy Bitcoin tab — it's still available in this state. Funds you buy land in this same wallet."
      />
      <BracketHeading>WHAT HAPPENS NEXT</BracketHeading>
      <Timeline>
        <TimelineRow marker="·">
          <strong>If you renew</strong> — recovery is fully in-app. Payment is detected within ~15 seconds; routing and all paused services come back online, and your paid-through date advances by {status.period_days} days.
        </TimelineRow>
        <TimelineRow marker="!" tone="orange">
          <strong>If you don't renew within ~{daysToClose} more days</strong> — your channel will be cooperatively closed. The on-chain funds in your channel return to your wallet, but you'll need to open a new channel to rejoin the network.
        </TimelineRow>
        <TimelineRow marker="✓" tone="emerald">
          <strong>Right now</strong> — your channel remains open, your channel balance is unchanged, and no automated close has been scheduled yet.
        </TimelineRow>
      </Timeline>
      <BracketHeading>ACTIONS</BracketHeading>
      <ActionsRow
        primary={<button className="sub-btn">Open Coinbase Onramp <span aria-hidden>↗</span></button>}
        secondary={<button className="sub-btn">I have BTC — renew ({fmtSats(status.price_sats)})</button>}
        tertiary={<Link className="sub-link" to="/subscription/payments">View payment history <span aria-hidden>→</span></Link>}
      />
    </section>
  );
}

function CloseDueRender({
  status,
}: {
  status: SubscriptionStatusApplicable;
  onRefresh: () => void;
}) {
  const lapsedDays = daysAgo(status.paid_through);
  return (
    <section className="sub-panel">
      <PanelHeader pill={<Pill kind="red" label="pay to halt close" />} />
      <AlertBox variant="red" icon="✕">
        Your subscription lapsed <strong>{lapsedDays} day{lapsedDays === 1 ? "" : "s"}</strong> ago. Your channel will be cooperatively closed on the next scheduler tick. A payment of <strong>{fmtSats(status.price_sats)}</strong> received before then will <strong>halt</strong> the close.
      </AlertBox>
      <StatsGrid status={status} accent="red" />
      <DepositBlock
        status={status}
        captionSats={status.price_sats}
        helper={`Send ${fmtSats(status.price_sats)} to halt the pending close.`}
        fineprint="The scheduler re-checks your subscription status immediately before issuing the close. A confirmed payment in that window halts it."
      />
      <BracketHeading>WHAT HAPPENS NEXT</BracketHeading>
      <Timeline>
        <TimelineRow marker="·">
          <strong>On confirmation</strong> — payment is detected within ~15s, your subscription resumes, the close is halted.
        </TimelineRow>
        <TimelineRow marker="!" tone="red">
          <strong>If no payment arrives</strong> — your channel closes cooperatively. On-chain funds are returned to your wallet. The close cannot be reversed once initiated.
        </TimelineRow>
      </Timeline>
      <BracketHeading>ACTIONS</BracketHeading>
      {/* Per spec §11 acceptance + Stage 5a deltas: Onramp button
          required in close_due (recovery path stays open through every
          state a member could plausibly recover from). Inverted
          hierarchy: Onramp primary, pay-now secondary — same pattern
          as worker_lapsed/routing_lapsed. */}
      <ActionsRow
        primary={<button className="sub-btn">Open Coinbase Onramp <span aria-hidden>↗</span></button>}
        secondary={<button className="sub-btn">I have BTC — pay now to halt close</button>}
        tertiary={<Link className="sub-link" to="/subscription/payments">View payment history <span aria-hidden>→</span></Link>}
      />
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════
//   Applicable: false (5 reasons)
// ═══════════════════════════════════════════════════════════════

function NotApplicablePanel({
  status,
  pendingSinceMs,
  lastFetchAt,
  localPubkey,
  onRetry,
}: {
  status: SubscriptionStatusNotApplicable;
  pendingSinceMs: number | null;
  lastFetchAt: number;
  localPubkey: string | null;
  onRetry: () => void;
}) {
  switch (status.reason) {
    case "external_peer":     return <ExternalPeerRender />;
    case "unclassified":      return <UnclassifiedRender />;
    case "not_yet_allocated": return <PendingInitialSyncRender pendingSinceMs={pendingSinceMs} channelAgeSec={status.channel_age_seconds ?? 0} onRetry={onRetry} />;
    case "missing":           return <UnexpectedMissingRowRender lastFetchAt={lastFetchAt} localPubkey={localPubkey} onRetry={onRetry} />;
    case "no_channel":        return <NoChannelRender />;
  }
}

function ExternalPeerRender() {
  // Per signal system §1 + §3: compact placeholder, body copy only,
  // no pill, no alert chrome, no actions. Lighter border to signal
  // "intentionally quieter."
  return (
    <section className="sub-panel sub-panel-quiet">
      <PanelHeader />
      <p className="sub-body-copy">
        This node is configured as a <strong>routing peer</strong>. Subscription doesn't apply to this node. If you believe this is incorrect, contact your operator.
      </p>
    </section>
  );
}

function UnclassifiedRender() {
  return (
    <section className="sub-panel">
      <PanelHeader pill={<Pill kind="muted-amber" label="unclassified" />} />
      <AlertBox variant="dashed" icon="i">
        Your node's role is pending classification. Subscription doesn't activate until your channel is classified as farmer or merchant. Contact your operator if this persists more than a few minutes.
      </AlertBox>
      <div className="sub-stats">
        <Stat label="MONTHLY" value={(50_000).toLocaleString()} suffix="sats" />
        <Stat label="PAID THROUGH" value="—" suffix="pending" pendingValue />
        <Stat label="LAST PAYMENT" value="—" suffix="pending" pendingValue />
      </div>
      <BracketHeading>ACTIONS</BracketHeading>
      <ActionsRow
        secondary={<a className="sub-btn" href="mailto:operator@example.com">Contact operator <span aria-hidden>↗</span></a>}
      />
    </section>
  );
}

function PendingInitialSyncRender({
  pendingSinceMs,
  channelAgeSec,
  onRetry,
}: {
  pendingSinceMs: number | null;
  channelAgeSec: number;
  onRetry: () => void;
}) {
  const stuck =
    pendingSinceMs !== null &&
    Date.now() - pendingSinceMs > PENDING_STUCK_THRESHOLD_MS;
  return (
    <section className="sub-panel">
      <PanelHeader pill={<Pill kind="gray-pulsing" label="setting up" />} />
      <div className="sub-stats">
        <Stat label="MONTHLY" value={(50_000).toLocaleString()} suffix="sats" pendingValue />
        <Stat label="PAID THROUGH" value="—" suffix="pending" pendingValue />
        <Stat label="LAST PAYMENT" value="—" suffix="pending" pendingValue />
      </div>
      {/* Centered-figure alert per signal system §3: pulsing dots +
          sans-serif headline + monospace body. No filled background,
          dashed top-border separator. */}
      <div className="sub-centered-figure">
        <div className="sub-pulsing-dots" aria-hidden>
          <span /><span /><span />
        </div>
        <h3 className="sub-centered-headline">Setting up your subscription</h3>
        <p className="sub-centered-body">
          The sync loop is allocating your deposit address. This usually
          takes ~15 seconds. Your address, QR code, and renewal options
          will appear here automatically when setup completes.
        </p>
        {/* W7-gated four-step strip omitted in v1 — backend doesn't
            expose sync_stage. Falls back to pulsing dots only per
            signal system §10 deferred-work entry. */}
        {stuck && (
          <p className="sub-stuck-escalation">
            Taking longer than expected.{" "}
            <button className="sub-link sub-link-button" onClick={onRetry}>
              Refresh now <span aria-hidden>→</span>
            </button>
          </p>
        )}
        <p className="sub-pending-channel-age">
          channel detected {channelAgeSec}s ago
        </p>
      </div>
    </section>
  );
}

function UnexpectedMissingRowRender({
  lastFetchAt,
  localPubkey,
  onRetry,
}: {
  lastFetchAt: number;
  localPubkey: string | null;
  onRetry: () => void;
}) {
  const ago = useLiveAgo(lastFetchAt);
  const [locked, setLocked] = useState(false);
  const handleRetry = () => {
    if (locked) return;
    setLocked(true);
    onRetry();
    setTimeout(() => setLocked(false), 2500);
  };
  // The pubkey is the support-context identifier this error state's
  // job revolves around (signal system §5). Fetched from /api/node on
  // panel mount; renders a neutral placeholder for the brief window
  // before the fetch completes (or if it fails entirely).
  const memberPubkey = localPubkey ?? "—";
  const copyPubkey = useCallback(() => {
    if (!memberPubkey || memberPubkey === "—") return;
    void navigator.clipboard?.writeText(memberPubkey).catch(() => {});
  }, [memberPubkey]);
  return (
    <section className="sub-panel">
      <PanelHeader pill={<Pill kind="dim-red" label="state unavailable" />} />
      <AlertBox variant="dim-red" icon="✕">
        Your subscription state couldn't be loaded — this is unexpected. The subscription row should exist but isn't responding. This is usually a temporary sync issue that resolves within a minute, but may indicate something the system needs help with.
      </AlertBox>
      <p className="sub-retry-indicator">
        <span aria-hidden>·</span> Checking again automatically every 15 seconds — last attempt {ago}.
      </p>
      <BracketHeading>MEMBER IDENTIFIER</BracketHeading>
      <div className="sub-member-id">
        <div className="sub-stat-label">YOUR MEMBER PUBKEY</div>
        <code className="sub-pubkey">{memberPubkey}</code>
        <button className="sub-btn" onClick={copyPubkey}>Copy pubkey</button>
        <p className="sub-fineprint">Share this with your operator if you need to file a support ticket.</p>
      </div>
      <BracketHeading>ACTIONS</BracketHeading>
      <ActionsRow
        primary={<button className="sub-btn" onClick={handleRetry} disabled={locked}>{locked ? "Trying…" : <>Try now <span aria-hidden>→</span></>}</button>}
      />
      <p className="sub-footer-note">
        If this persists for more than a few minutes, contact your operator with the pubkey above. The auto-retry will keep running in the background until the state loads.
      </p>
    </section>
  );
}

function NoChannelRender() {
  return (
    <section className="sub-panel sub-panel-quiet">
      <PanelHeader />
      <p className="sub-body-copy">
        You don't have a channel to the treasury. Open a channel to enroll in the subscription system. If you believe you should have a channel, contact your operator.
      </p>
      <BracketHeading>ACTIONS</BracketHeading>
      <ActionsRow
        secondary={<a className="sub-btn" href="#open-channel">Open a channel <span aria-hidden>→</span></a>}
      />
    </section>
  );
}

// ─── Loading + error variants ───────────────────────────────────

function LoadingPanel() {
  return (
    <section className="sub-panel sub-panel-skeleton">
      <PanelHeader />
      <div className="sub-skeleton-line" style={{ width: "60%" }} />
      <div className="sub-stats">
        <Stat label="MONTHLY" value="—" pendingValue />
        <Stat label="PAID THROUGH" value="—" pendingValue />
        <Stat label="LAST PAYMENT" value="—" pendingValue />
      </div>
    </section>
  );
}

function ErrorPanel({
  message,
  detail,
  onRetry,
  lastFetchAt,
}: {
  message: string;
  detail?: string;
  onRetry: () => void;
  lastFetchAt: number;
}) {
  const ago = useLiveAgo(lastFetchAt);
  return (
    <section className="sub-panel">
      <PanelHeader pill={<Pill kind="dim-red" label="couldn't load" />} />
      <AlertBox variant="dim-red" icon="✕">
        {message} {detail ? <span className="sub-error-detail">({detail})</span> : null}
      </AlertBox>
      <p className="sub-retry-indicator">
        <span aria-hidden>·</span> last attempt {ago}.
      </p>
      <BracketHeading>ACTIONS</BracketHeading>
      <ActionsRow
        primary={<button className="sub-btn" onClick={onRetry}>Refresh now <span aria-hidden>→</span></button>}
      />
    </section>
  );
}

// Spec §10 #4 — distinct from ErrorPanel (which covers infrastructure_error
// for local-side prerequisites: no_local_token / no_treasury_key) and from
// UnexpectedMissingRowRender (which covers the operational-anomaly Case D
// where the treasury responds with applicable:false, reason:missing).
//
// transport_unreachable shape:
//   - dim-red pill register (same emotional register as unexpected_missing_row;
//     system is honestly reporting it can't do its job, no user action required)
//   - "Couldn't reach the treasury" headline
//   - "Retrying automatically" sub-copy (recovery is upstream-service-coming-back,
//     not operator-side investigation)
//   - Refresh now → action without lockout (deterministic-retry lockout
//     belongs to unexpected_missing_row where the same answer comes back;
//     here retry timing is non-deterministic and resolves when the tunnel
//     reconnects, so instant retry is the right affordance)
function TransportUnreachablePanel({
  detail,
  onRetry,
  lastFetchAt,
}: {
  detail?: string;
  onRetry: () => void;
  lastFetchAt: number;
}) {
  const ago = useLiveAgo(lastFetchAt);
  return (
    <section className="sub-panel">
      <PanelHeader pill={<Pill kind="dim-red" label="treasury unreachable" />} />
      <AlertBox variant="dim-red" icon="✕">
        Couldn't reach the treasury. Retrying automatically — service should
        recover when the connection is restored.
        {detail ? <span className="sub-error-detail"> ({detail})</span> : null}
      </AlertBox>
      <p className="sub-retry-indicator">
        <span aria-hidden>·</span> Checking again automatically every 15 seconds — last attempt {ago}.
      </p>
      <BracketHeading>ACTIONS</BracketHeading>
      <ActionsRow
        primary={<button className="sub-btn" onClick={onRetry}>Refresh now <span aria-hidden>→</span></button>}
      />
    </section>
  );
}

// ─── Shared sub-renderers ───────────────────────────────────────

function StatsGrid({
  status,
  accent,
}: {
  status: SubscriptionStatusApplicable;
  accent: PillKind;
}) {
  const paidThroughLabel = formatDate(status.paid_through);
  const paidThroughRel = relativePaidThrough(status.paid_through);
  const lastPaymentLabel = formatDate(status.last_payment_at);
  const lastPaymentSuffix = status.last_payment_at ? "confirmed" : "";
  return (
    <div className="sub-stats">
      <Stat label="MONTHLY" value={status.price_sats.toLocaleString()} suffix="sats" />
      <Stat label="PAID THROUGH" value={paidThroughLabel} suffix={paidThroughRel} accent={accent} />
      <Stat label="LAST PAYMENT" value={lastPaymentLabel} suffix={lastPaymentSuffix} />
    </div>
  );
}

function DepositBlock({
  status,
  captionSats,
  helper,
  fineprint,
}: {
  status: SubscriptionStatusApplicable;
  captionSats: number;
  helper: string;
  fineprint: string;
}) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard?.writeText(status.deposit_address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => { /* clipboard unavailable; fail silent */ },
    );
  }, [status.deposit_address]);
  return (
    <>
      <BracketHeading>DEPOSIT</BracketHeading>
      <div className="sub-deposit">
        <QrImage value={bip21Uri(status.deposit_address, captionSats)} />
        <div className="sub-deposit-right">
          <div className="sub-stat-label">ADDRESS</div>
          <code className="sub-deposit-address">{chunkAddress(status.deposit_address)}</code>
          <button className="sub-btn sub-deposit-copy" onClick={handleCopy}>
            {copied ? "✓ Copied" : "Copy address"}
          </button>
          <p className="sub-deposit-helper">{helper}</p>
          <p className="sub-fineprint">{fineprint}</p>
        </div>
      </div>
    </>
  );
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

function Timeline({ children }: { children: React.ReactNode }) {
  return <div className="sub-timeline">{children}</div>;
}

function TimelineRow({
  marker,
  tone,
  children,
}: {
  marker: string;
  tone?: "amber" | "orange" | "red" | "emerald";
  children: React.ReactNode;
}) {
  return (
    <div className="sub-timeline-row">
      <span className={`sub-timeline-marker${tone ? ` sub-timeline-marker-${tone}` : ""}`}>{marker}</span>
      <div>{children}</div>
    </div>
  );
}

function ActionsRow({
  primary,
  secondary,
  tertiary,
}: {
  primary?: React.ReactNode;
  secondary?: React.ReactNode;
  tertiary?: React.ReactNode;
}) {
  return (
    <div className="sub-actions">
      {primary}
      {secondary}
      {tertiary && <div className="sub-actions-tertiary">{tertiary}</div>}
    </div>
  );
}
