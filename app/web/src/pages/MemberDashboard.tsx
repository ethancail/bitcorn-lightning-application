import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  api,
  type MemberStats,
  type TreasuryInfo,
  type MemberLiquidityStatusResponse,
  type PendingChannel,
  type NodeBalances,
} from "../api/client";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";
import MemberSubscriptionBanner from "../components/MemberSubscriptionBanner";
import { useSubscriptionStatus } from "../components/useSubscriptionStatus";
import ErrorState from "../components/ErrorState";
import ActionConfirmModal, {
  useActionConfirm,
} from "../components/actionConfirm/ActionConfirmModal";
import { summarizeOpenMemberChannel } from "../components/actionConfirm/confirmAction";
import { classifyConfirmError } from "../components/actionConfirm/confirmErrors";
import TechnicalDetails, { TechRow } from "../components/TechnicalDetails";
import StaleMarker from "../components/StaleMarker";
import { channelStalenessNotice } from "../components/channelStaleness";
import { certExpiryNotice } from "../components/certExpiryNotice";
import {
  INITIAL_FRESHNESS,
  freshnessStatus,
  recordFailure,
  recordSuccess,
  type FreshnessState,
} from "../components/freshness";

const HUB_PUBKEY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";

const CAPACITY_PRESETS = [
  { label: "1M", value: 1_000_000 },
  { label: "5M", value: 5_000_000 },
  { label: "10M", value: 10_000_000 },
];

function statusBadge(s: string) {
  switch (s) {
    case "active_member":
      return { text: "Active Member", cls: "badge-green" };
    case "treasury_channel_inactive":
      return { text: "Channel Inactive", cls: "badge-amber" };
    case "no_treasury_channel":
      return { text: "Not Connected", cls: "badge-muted" };
    case "unsynced":
      return { text: "Syncing", cls: "badge-muted" };
    default:
      return { text: s.replace(/_/g, " "), cls: "badge-muted" };
  }
}

function ConnectToHub({ isPeered, initialCapacity }: { isPeered: boolean; initialCapacity?: number }) {
  const [capacity, setCapacity] = useState(initialCapacity ?? 1_000_000);
  const [feeRate, setFeeRate] = useState<number | undefined>(undefined);
  const [socket, setSocket] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treasuryInfo, setTreasuryInfo] = useState<TreasuryInfo | null>(null);
  const [treasuryInfoLoading, setTreasuryInfoLoading] = useState(true);

  useEffect(() => {
    api.getTreasuryInfo()
      .then(setTreasuryInfo)
      .catch(() => setTreasuryInfo(null))
      .finally(() => setTreasuryInfoLoading(false));
  }, []);

  const hubPubkey = treasuryInfo?.pubkey || HUB_PUBKEY;
  const hubSocket = treasuryInfo?.socket || null;
  const hasAutoSocket = !!hubSocket;

  // Human confirmation for the on-chain funding. apiFetch derives
  // x-bitcorn-confirm from the serialized body; nothing is hashed here.
  const confirm = useActionConfirm();

  function openChannelConfirm() {
    const partnerSocket = hasAutoSocket && !isPeered ? hubSocket : socket.trim() || undefined;
    confirm.open(
      summarizeOpenMemberChannel({
        capacitySats: capacity,
        partnerSocket: partnerSocket || undefined,
        // TreasuryInfo carries pubkey + socket only, no alias — the summary's
        // default label ("Bitcorn treasury hub") is the honest name here.
        hubLabel: undefined,
      }),
    );
  }

  async function handleOpen() {
    setSubmitting(true);
    setError(null);
    try {
      const partnerSocket = hasAutoSocket && !isPeered ? hubSocket : socket.trim() || undefined;
      const res = await api.openMemberChannel({
        capacity_sats: capacity,
        partner_socket: partnerSocket || undefined,
        ...(feeRate ? { fee_rate: feeRate } : {}),
      });
      setSuccess(res.funding_txid ?? "submitted");
    } catch (e: any) {
      // Confirmation failures go to the modal the operator is looking at.
      if (classifyConfirmError(e)) throw e;
      setError(e.message ?? "Failed to open channel");
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div className="alert healthy">
          <span className="alert-icon">✓</span>
          <div className="alert-body">
            <div className="alert-type">Channel opening submitted</div>
            <div className="alert-msg">
              Your channel to the hub is being broadcast. It will become active after
              1–3 on-chain confirmations. This page will update automatically.
            </div>
          </div>
        </div>
        {success !== "submitted" && (
          <div>
            <div
              style={{
                fontSize: "0.75rem",
                color: "var(--text-3)",
                fontFamily: "var(--mono)",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                marginBottom: 6,
              }}
            >
              Funding Transaction
            </div>
            <div
              style={{
                background: "var(--bg-3)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "8px 12px",
                fontFamily: "var(--mono)",
                fontSize: "0.75rem",
                wordBreak: "break-all",
                color: "var(--text-1)",
              }}
            >
              {success}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Info alert */}
      <div className="alert info" style={{ marginBottom: 0 }}>
        <span className="alert-icon">◈</span>
        <div className="alert-body">
          <div className="alert-type">No hub channel</div>
          <div className="alert-msg">
            Open a channel to the hub to start sending and receiving Lightning payments.
          </div>
        </div>
      </div>

      {/* Open channel form */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label className="form-label">Channel Capacity</label>
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            {CAPACITY_PRESETS.map((p) => (
              <button
                key={p.value}
                className={`btn ${capacity === p.value ? "btn-primary" : "btn-outline"}`}
                onClick={() => setCapacity(p.value)}
                style={{ flex: 1 }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div style={{ position: "relative" }}>
            <input
              className="form-input"
              type="text"
              inputMode="numeric"
              value={capacity.toLocaleString()}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^0-9]/g, "");
                if (raw === "") { setCapacity(0); return; }
                setCapacity(Number(raw));
              }}
              style={{ paddingRight: 42 }}
            />
            <span style={{
              position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
              fontSize: "0.75rem", color: "var(--text-3)", fontFamily: "var(--mono)", pointerEvents: "none",
            }}>
              sats
            </span>
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
            Recommended: 1M–10M sats. Minimum: 100,000 sats.
          </div>
          {capacity > 0 && capacity < 100_000 && (
            <div style={{ fontSize: "0.75rem", color: "var(--red)", marginTop: 4 }}>
              Channel capacity must be at least 100,000 sats.
            </div>
          )}
        </div>

        {/* Peering section — 3 states based on actual LND peer connection + Worker socket */}
        {isPeered ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              background: "color-mix(in srgb, var(--green) 10%, var(--bg-2))",
              border: "1px solid color-mix(in srgb, var(--green) 30%, transparent)",
              borderRadius: 6,
              fontSize: "0.8125rem",
              color: "var(--green)",
            }}
          >
            <span>✓</span>
            <span>Connected to hub — ready to open a channel</span>
          </div>
        ) : hasAutoSocket ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 12px",
              background: "color-mix(in srgb, var(--amber) 10%, var(--bg-2))",
              border: "1px solid color-mix(in srgb, var(--amber) 30%, transparent)",
              borderRadius: 6,
              fontSize: "0.8125rem",
              color: "var(--amber)",
            }}
          >
            <span>◈</span>
            <span>Hub address available — will connect automatically when you open a channel</span>
          </div>
        ) : treasuryInfoLoading ? (
          <div className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />
        ) : (
          <div>
            <label className="form-label">
              Hub Address{" "}
              <span style={{ color: "var(--text-3)", fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              className="form-input"
              type="text"
              placeholder="e.g. 203.0.113.5:9735 — ask your operator"
              value={socket}
              onChange={(e) => setSocket(e.target.value)}
            />
            <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
              Enter the hub's address to connect, or leave blank if already connected.
            </div>
          </div>
        )}

        {error && (
          <div className="alert critical">
            <span className="alert-icon">✕</span>
            <div className="alert-body">
              <div className="alert-msg">{error}</div>
            </div>
          </div>
        )}

        {/* Fee rate selector */}
        <div>
          <label className="form-label">Confirmation Speed</label>
          <div style={{ display: "flex", gap: 6 }}>
            {([
              { label: "Economy", rate: undefined, desc: "cheapest", time: "1–3 hours", cost: "~155 sats" },
              { label: "Normal", rate: 5, desc: "balanced", time: "~30 min", cost: "~770 sats" },
              { label: "Priority", rate: 15, desc: "fastest", time: "~10 min", cost: "~2,300 sats" },
            ] as const).map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => setFeeRate(opt.rate)}
                style={{
                  flex: 1, padding: "8px 6px", borderRadius: 8, cursor: "pointer",
                  border: `2px solid ${feeRate === opt.rate ? "var(--amber)" : "var(--border)"}`,
                  background: feeRate === opt.rate ? "color-mix(in srgb, var(--amber) 10%, var(--bg-2))" : "var(--bg-2)",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: "0.8125rem", fontWeight: 600, color: feeRate === opt.rate ? "var(--amber)" : "var(--text)" }}>
                  {opt.label}
                </div>
                <div style={{ fontSize: "0.6875rem", color: feeRate === opt.rate ? "var(--amber)" : "var(--text-2)" }}>
                  {opt.time}
                </div>
                <div style={{ fontSize: "0.625rem", color: "var(--text-3)", fontFamily: "var(--mono)" }}>
                  {opt.cost}
                </div>
              </button>
            ))}
          </div>
        </div>

        <button
          className="btn btn-primary"
          onClick={openChannelConfirm}
          disabled={submitting || capacity < 100_000}
        >
          {submitting ? "Connecting…" : "Open Channel →"}
        </button>

        <ActionConfirmModal controller={confirm} onConfirm={handleOpen} />
      </div>

      {/* Protocol reference — demoted per U2 (vocabulary record 2026-07-09) */}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <TechnicalDetails>
          <TechRow label="Hub node ID">{hubPubkey}</TechRow>
          <TechRow label="Fee rates">Economy ~1 sat/vB · Normal ~5 sat/vB · Priority ~15 sat/vB</TechRow>
        </TechnicalDetails>
      </div>
    </div>
  );
}

export default function MemberDashboard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const upgradeCapacity = parseInt(searchParams.get("upgrade_capacity") ?? "", 10) || undefined;
  const [stats, setStats] = useState<MemberStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [advisor, setAdvisor] = useState<MemberLiquidityStatusResponse | null>(null);
  const [usdRate, setUsdRate] = useState<number | null>(null);
  const [pendingTreasuryChannel, setPendingTreasuryChannel] = useState(false);
  const [balances, setBalances] = useState<NodeBalances | null>(null);
  const [balFresh, setBalFresh] = useState<FreshnessState>(INITIAL_FRESHNESS);
  const [fundLoading, setFundLoading] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);
  const subStatus = useSubscriptionStatus();

  // U24 H2: a failed stats fetch must be distinguishable from "no channel" —
  // otherwise the Connect-to-Hub onboarding form renders for a member who HAS
  // a channel ("my channel is gone" illusion). loadStats records the error;
  // the poll self-heals (success clears it). A poll failure with last-good
  // stats on screen keeps them (keep-last-good; the balances strip below has
  // the explicit staleness marker).
  const loadStats = useCallback(() => {
    return api
      .getMemberStats()
      .then((d) => {
        setStats(d);
        setStatsError(null);
      })
      .catch((e: any) => setStatsError(e?.detail ?? e?.message ?? "fetch failed"));
  }, []);

  useEffect(() => {
    void loadStats().finally(() => setLoading(false));
    const id = setInterval(() => {
      api.getMemberStats().then((d) => { setStats(d); setStatsError(null); }).catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, [loadStats]);

  // Check for pending treasury channel (survives page reload)
  useEffect(() => {
    const hubPk = HUB_PUBKEY;
    const check = () =>
      api.getPendingChannels()
        .then((pend) => setPendingTreasuryChannel(pend.some((p) => p.peer_pubkey === hubPk && p.status === "opening")))
        .catch(() => {});
    check();
    const id = setInterval(check, 15_000);
    return () => clearInterval(id);
  }, []);

  // Fetch advisor status (less frequently — it's a heavier call with Loop check)
  useEffect(() => {
    api.getMemberLiquidityStatus().then(setAdvisor).catch(() => {});
    const id = setInterval(() => {
      api.getMemberLiquidityStatus().then(setAdvisor).catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // Exchange rate for USD display
  useEffect(() => {
    api.getExchangeRate().then((r) => setUsdRate(r.usd)).catch(() => {});
  }, []);

  // Balance polling (replaces <NodeBalancePanel />).
  // U24 H8: poll results feed the freshness tracker — on repeated failures
  // the strip keeps the last-good numbers with a staleness marker instead of
  // clearing to "—" (which is indistinguishable from loading).
  useEffect(() => {
    const tick = () =>
      api.getNodeBalances()
        .then((b) => {
          setBalances(b);
          setBalFresh((s) => recordSuccess(s, Date.now()));
        })
        .catch(() => setBalFresh(recordFailure));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  async function handleFund() {
    setFundLoading(true);
    setFundError(null);
    try {
      const { url } = await api.getCoinbaseOnrampUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (e: any) {
      const msg = e?.message ?? "failed";
      setFundError(
        msg === "coinbase_not_configured"
          ? "Coinbase Onramp is not configured on this node."
          : msg,
      );
    } finally {
      setFundLoading(false);
    }
  }

  const ch = stats?.treasury_channel;
  const badge = statusBadge(stats?.membership_status ?? "");

  // USD conversion helper
  const toUsd = (sats: number) =>
    usdRate ? `$${((sats / 100_000_000) * usdRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;

  // Estimated withdrawal fee (~1-2% based on observed Loop Out costs)
  const estWithdrawalFee = ch ? Math.max(1500, Math.round(ch.local_sats * 0.008)) : 0;

  const localPct = ch ? Math.round((ch.local_sats / ch.capacity_sats) * 100) : 0;
  const remotePct = ch ? Math.round((ch.remote_sats / ch.capacity_sats) * 100) : 0;

  const hasChannel = !loading && ch != null;
  // U24 H2: three distinct states — stats failed to load (statsUnavailable,
  // only reachable when the initial fetch failed and no poll has recovered),
  // genuinely no channel (stats loaded, treasury_channel null), and has-channel.
  const statsUnavailable = !loading && stats == null;
  const noChannel = !loading && stats != null && ch == null;
  const balStatus = freshnessStatus(balFresh, balances != null);

  return (
    <div>
      <MemberSubscriptionBanner status={subStatus} />

      {/* Cert-expiry arc: the farmer's own node telling them its TLS
          certificate is running out.

          ⚠ PAGE-TOP, OUTSIDE ALL THREE STATE GATES — deliberately NOT inside
          the {hasChannel && ...} block below, where the staleness notice
          lives. That gate is correct for a notice ABOUT the channel numbers;
          it is wrong here. A member with no channel still has an LND with a
          cert, and a NEWLY-PROVISIONED member is exactly who is on the clock
          of a cert issued at install time. Nesting this under hasChannel
          would hide it from them.

          ⚠ RENDERS NOTHING BEFORE THE DATA ARRIVES. stats is null until the
          first poll returns, so `stats?.cert_expiry` is undefined and the
          helper returns null — chosen over the `?? true`-style default used
          at the staleness call site below, because that one defaults a
          HEALTH flag toward healthy while this would be defaulting a CLAIM
          about the node. A dashboard that has not finished loading must not
          accuse the node of anything.

          Silent on a healthy node: level "ok" returns null, as does
          "unknown". Pinned by paired controls in certExpiryNotice.test.ts. */}
      {(() => {
        const notice = certExpiryNotice(stats?.cert_expiry, Date.now());
        if (!notice) return null;
        return (
          <div className={`alert ${notice.severity === "critical" ? "critical" : "warning"}`}>
            <span className="alert-icon" aria-hidden>
              {notice.severity === "critical" ? "✕" : "⚠"}
            </span>
            <div className="alert-body">
              <div className="alert-msg">{notice.text}</div>
            </div>
          </div>
        );
      })()}

      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>My Dashboard</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Your connection to the Bitcorn Lightning hub
        </p>
      </div>

      <div className="dashboard-top-strip fade-in">
        <div className="bal-group">
          <div className="bal-item">
            <span className="bal-label">Bitcoin</span>
            <span className="bal-value">
              {balances ? balances.onchain_sats.toLocaleString() : "—"}
              <span className="unit">sats</span>
            </span>
          </div>
          <div className="bal-item">
            <span className="bal-label">Channel</span>
            <span className="bal-value">
              {balances ? balances.lightning_sats.toLocaleString() : "—"}
              <span className="unit">sats</span>
            </span>
          </div>
          <div className="bal-item">
            <span className="bal-label">Total</span>
            <span className="bal-value">
              {balances ? balances.total_sats.toLocaleString() : "—"}
              <span className="unit">sats</span>
            </span>
          </div>
        </div>
        <button
          className="btn btn-primary"
          onClick={handleFund}
          disabled={fundLoading}
        >
          {fundLoading ? "Opening…" : "Fund Node →"}
        </button>
        {fundError && <div className="fund-error">{fundError}</div>}
      </div>

      {/* U24 H8: Tier C — the strip above keeps last-good numbers; these
          lines say when they can no longer be confirmed. */}
      {balStatus === "stale" && (
        <div style={{ marginTop: 6, marginBottom: 10 }}>
          <StaleMarker state={balFresh} nowMs={Date.now()} noun="Balances" />
        </div>
      )}
      {balStatus === "unavailable" && (
        <div style={{ marginTop: 6, marginBottom: 10, fontSize: "0.75rem", color: "var(--red)", fontFamily: "var(--mono)" }} role="status">
          Couldn't load balances — retrying automatically. Your funds are unaffected.
        </div>
      )}

      <BitcoinPriceGraph />



      {/* Membership status — compressed row */}
      <div className="member-status-row">
        <span className="lbl">Membership status</span>
        {loading ? (
          <div className="loading-shimmer" style={{ height: 20, width: 120 }} />
        ) : (
          <span className={`badge ${badge.cls}`}>{badge.text}</span>
        )}
      </div>

      {/* U24 H2: stats fetch failed and nothing loaded yet — error state, NOT
          the Connect-to-Hub onboarding form. */}
      {statsUnavailable && (
        <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title"><span className="icon">◈</span>Your Channel</span>
          </div>
          <div className="panel-body">
            <ErrorState
              bare
              message="Couldn't load your dashboard. Your channel and funds are unaffected — this is a display problem."
              detail={statsError ?? undefined}
              onRetry={() => void loadStats()}
            />
          </div>
        </div>
      )}

      {/* Channel — pending opening, connect CTA, or earnings panel */}
      {noChannel && pendingTreasuryChannel && (
        <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title"><span className="icon">◈</span>Connect to Hub</span>
          </div>
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="alert healthy" style={{ marginBottom: 0 }}>
              <span className="alert-icon">✓</span>
              <div className="alert-body">
                <div className="alert-type">Channel Opening Submitted</div>
                <div className="alert-msg">
                  Your channel to the hub is being broadcast. It will become active after 1–3 on-chain confirmations. This page will update automatically.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {noChannel && !pendingTreasuryChannel && (
        <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title"><span className="icon">◈</span>Connect to Hub</span>
          </div>
          <div className="panel-body">
            <ConnectToHub isPeered={stats?.is_peered_to_hub ?? false} initialCapacity={upgradeCapacity} />
          </div>
        </div>
      )}

      {loading && (
        <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title"><span className="icon">◈</span>Your Earnings</span>
          </div>
          <div className="panel-body">
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[100, 80, 90].map((w, i) => (
                <div key={i} className="loading-shimmer" style={{ height: 16, width: `${w}%` }} />
              ))}
            </div>
          </div>
        </div>
      )}

      {hasChannel && (() => {
        const role = advisor?.classification?.channelRole ?? "unknown";
        const rec = advisor?.recommendation;
        const isMerchant = role === "merchant";
        const isFarmer = role === "farmer";

        // Role-aware gauge
        // Merchant: outbound capacity (local%) — depletes as they spend, green when high
        // Farmer: earnings accumulated (local%) — fills up like a grain bin, amber→green→amber→red as it fills
        // Unknown: raw local/remote split
        const gaugeLabel = isMerchant ? "Room to send" : isFarmer ? "Earnings accumulated" : "Channel balance";
        const gaugePct = isMerchant ? localPct : isFarmer ? localPct : localPct;
        const gaugeRemaining = isMerchant
          ? `${localPct}% — ${ch!.local_sats.toLocaleString()} sats available to send`
          : isFarmer
            ? `${localPct}% full — ${ch!.local_sats.toLocaleString()} of ${ch!.capacity_sats.toLocaleString()} sats`
            : `${localPct}% local — ${remotePct}% remote`;
        // Merchant: green=healthy(high local), amber/red=depleting
        // Farmer: green=room to earn(low fill), amber=getting full, red=needs withdrawal
        const gaugeColor = isFarmer
          ? (localPct >= 85 ? "var(--red)" : localPct >= 70 ? "var(--amber)" : "var(--green)")
          : (gaugePct < 15 ? "var(--red)" : gaugePct < 30 ? "var(--amber)" : "var(--green)");

        // Hero value color: role-aware, same urgency logic as the gauge.
        // Unknown role stays neutral (no signal when we don't know the context).
        const heroColor = role === "unknown" ? "var(--text)" : gaugeColor;

        // Hero number
        const heroLabel = isMerchant ? "Available to send" : isFarmer ? "Available to withdraw" : "Your balance";
        const heroSats = ch!.local_sats;

        // Panel title
        const panelTitle = isMerchant ? "Merchant Channel" : isFarmer ? "Your Earnings" : "Your Channel";

        // Advisor-aware navigation URLs
        const cashOutUrl = rec?.action === "loop_out" && rec?.suggestedAmountSats
          ? `/cashout?amount=${rec.suggestedAmountSats}` : "/cashout";
        const refillUrl = rec?.action === "loop_in" && rec?.suggestedAmountSats
          ? `/refill?amount=${rec.suggestedAmountSats}` : "/refill";

        // Advisor alert
        const alertClass = rec?.urgency === "high" ? "critical" : rec?.urgency === "medium" ? "warning" : "info";
        const alertIcon = rec?.urgency === "high" ? "✕" : rec?.urgency === "medium" ? "⚠" : "ℹ";
        const showAlert = rec && rec.action !== "none";

        return (
          <>
            <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
              <div className="panel-header">
                <span className="panel-title">
                  <span className="icon">◈</span>{panelTitle}
                </span>
                <span className={`badge ${ch!.is_active ? "badge-green" : "badge-muted"}`}>
                  {ch!.is_active ? "active" : "inactive"}
                </span>
              </div>
              <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Hero number — role-aware color */}
                <div className="member-hero">
                  <div className="lbl">{heroLabel}</div>
                  <div
                    className="val"
                    style={{ color: heroColor }}
                    aria-label={`${heroLabel}: ${heroSats.toLocaleString()} sats`}
                  >
                    {heroSats.toLocaleString()}<span className="unit">sats</span>
                  </div>
                  {toUsd(heroSats) && <div className="usd">{toUsd(heroSats)}</div>}
                </div>

                {/* U24 / cert-expiry arc: these numbers come from SQLite via
                    /api/member/stats, which answers 200 even when LND is
                    unreachable — so components/freshness.ts (poll-outcome
                    driven) can never mark them. This is DATA-AGE driven, and it
                    sits directly under the number it describes. Renders nothing
                    on a healthy node. */}
                {(() => {
                  const notice = channelStalenessNotice(
                    ch!.freshness,
                    stats?.lnd_live_read_ok ?? true,
                    Date.now(),
                  );
                  if (!notice) return null;
                  return (
                    <div
                      className={`alert ${notice.severity === "critical" ? "critical" : "warning"}`}
                      style={{ marginBottom: 0 }}
                    >
                      <span className="alert-icon" aria-hidden>
                        {notice.severity === "critical" ? "✕" : "⚠"}
                      </span>
                      <div className="alert-body">
                        <div className="alert-msg">{notice.text}</div>
                      </div>
                    </div>
                  );
                })()}

                {/* Capacity gauge — role-aware color, ARIA progressbar */}
                <div
                  className="member-gauge"
                  role="progressbar"
                  aria-valuenow={gaugePct}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={gaugeLabel}
                >
                  <div className="labels">
                    <span>{gaugeLabel}</span>
                    <span>{gaugeRemaining}</span>
                  </div>
                  <div className="bar">
                    <div className="fill" style={{ width: `${gaugePct}%`, background: gaugeColor }} />
                  </div>
                </div>

                {/* Advisor-driven alert */}
                {showAlert && (
                  <div className={`alert ${alertClass}`} style={{ marginBottom: 0 }}>
                    <span className="alert-icon">{alertIcon}</span>
                    <div className="alert-body">
                      <div className="alert-msg">{rec!.reason}</div>
                    </div>
                  </div>
                )}

                {/* Role not set — prompt */}
                {role === "unknown" && (
                  <div className="alert info" style={{ marginBottom: 0 }}>
                    <span className="alert-icon">◈</span>
                    <div className="alert-body">
                      <div className="alert-msg">
                        Set your channel role to get tailored capacity recommendations.
                      </div>
                      <button
                        className="btn btn-outline"
                        style={{ marginTop: 8, fontSize: "0.75rem" }}
                        onClick={() => navigate("/settings")}
                      >
                        Set Role in Settings →
                      </button>
                    </div>
                  </div>
                )}

                {/* Merchant: top-up action (F1) — mirrors the farmer block below.
                    "Top Up" per decisions/2026-07-09-ui-vocabulary-canonical-terms.md
                    (Knot 2: merchant Loop In). Gated on the advisor's own loop_in
                    recommendation — the same computed signal that builds refillUrl —
                    rather than an invented balance threshold; it also makes the
                    advisor alert above actionable. Unknown-role members see neither
                    role's CTA (unchanged). */}
                {isMerchant && rec?.action === "loop_in" && (
                  <div className="member-action">
                    <button
                      className="btn btn-primary"
                      style={{ width: "100%" }}
                      onClick={() => navigate(refillUrl)}
                    >
                      Top Up →
                    </button>
                    <div className="caption">
                      {rec?.suggestedAmountSats
                        ? `Bitcorn recommends ${rec.suggestedAmountSats.toLocaleString()} sats — pre-filled for you.`
                        : "Add funds from your Bitcoin balance to keep paying."}
                    </div>
                  </div>
                )}

                {/* Farmer: withdraw action */}
                {isFarmer && ch!.local_sats >= 250_000 && (
                  <div className="member-action">
                    <button
                      className="btn btn-primary"
                      style={{ width: "100%" }}
                      onClick={() => navigate(cashOutUrl)}
                    >
                      Withdraw Earnings →
                    </button>
                    <div className="caption">
                      Estimated fee: ~{estWithdrawalFee.toLocaleString()} sats
                      {toUsd(estWithdrawalFee) && ` (${toUsd(estWithdrawalFee)})`}
                    </div>
                  </div>
                )}
                {isFarmer && ch!.local_sats > 0 && ch!.local_sats < 250_000 && (
                  <div style={{ textAlign: "center", fontSize: "0.75rem", color: "var(--text-3)" }}>
                    Minimum withdrawal: 250,000 sats. You have {ch!.local_sats.toLocaleString()} sats.
                  </div>
                )}

                {/* Channel details (collapsible) */}
                <details style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
                  <summary style={{ cursor: "pointer", userSelect: "none" }}>Channel details</summary>
                  <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Channel capacity</span>
                      <span style={{ fontFamily: "var(--mono)" }}>{ch!.capacity_sats.toLocaleString()} sats</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Your side</span>
                      <span style={{ fontFamily: "var(--mono)" }}>{ch!.local_sats.toLocaleString()} sats</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Room to receive</span>
                      <span style={{ fontFamily: "var(--mono)" }}>{ch!.remote_sats.toLocaleString()} sats</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Channel role</span>
                      <span style={{ fontFamily: "var(--mono)", textTransform: "capitalize" }}>{role}</span>
                    </div>
                  </div>
                </details>
              </div>
            </div>

            {/* Upgrade banner when navigated from Channels page */}
            {upgradeCapacity && ch && ch.capacity_sats < upgradeCapacity && (
              <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
                <div className="panel-body">
                  <div className="alert info" style={{ marginBottom: 0 }}>
                    <span className="alert-icon">⚠</span>
                    <div className="alert-body">
                      <div className="alert-type">Channel Upgrade Recommended</div>
                      <div className="alert-msg">
                        Your current channel is {ch.capacity_sats.toLocaleString()} sats.
                        Open a larger replacement channel ({upgradeCapacity.toLocaleString()} sats) to increase capacity.
                      </div>
                      <ConnectToHub isPeered={true} initialCapacity={upgradeCapacity} />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        );
      })()}

    </div>
  );
}
