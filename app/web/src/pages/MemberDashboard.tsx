import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  api,
  type MemberStats,
  type MemberLiquidityStatusResponse,
  type PendingChannel,
  type NodeBalances,
} from "../api/client";
import { rateNote, RATE_NONE_SENTENCE } from "../api/rate";
import type { ExchangeRate, MemberCosts, SwapLimits } from "../api/client";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";
import MemberSubscriptionBanner from "../components/MemberSubscriptionBanner";
import { subscriptionBannerSlot } from "../components/subscriptionBannerSlot";
import { useSubscriptionStatus } from "../components/useSubscriptionStatus";
import ErrorState from "../components/ErrorState";
import ConnectToHub, { HUB_PUBKEY } from "../components/firstRun/ConnectToHub";
import StaleMarker from "../components/StaleMarker";
import { channelStalenessNotice } from "../components/channelStaleness";
import { capacityTone, capacityWord, CAPACITY_BAR_COLOR, CAPACITY_TEXT_COLOR } from "../components/capacityTone";
import { certExpiryNotice } from "../components/certExpiryNotice";
import { withdrawCtaGate } from "../components/withdrawCtaGate";
import { memberNamePromptFor, type BitcornNameRead } from "../components/memberNamePrompt";
import {
  INITIAL_FRESHNESS,
  freshnessStatus,
  recordFailure,
  recordSuccess,
  type FreshnessState,
} from "../components/freshness";

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

/**
 * One Your Node figure, dollars first with its sats underneath in .kv-meta
 * (drive-mode P2 item 4, R27(3)'s interim). With no rate the value is the sats
 * figure, as before; not loaded is "—", never 0. File-local on purpose: the
 * shared "sats on tap" component is member-first-run-ui's to build (§1.3).
 */
function NodeFigure({ sats, usd, testId }: { sats: number | null; usd: (sats: number) => string | null; testId?: string }) {
  const dollars = sats != null ? usd(sats) : null;
  return (
    <div style={{ textAlign: "right" }}>
      <span className="kv-value" {...(testId ? { "data-testid": testId } : {})}>
        {dollars ?? <>{sats != null ? sats.toLocaleString() : "—"}<span className="unit">sats</span></>}
      </span>
      {dollars && <div className="kv-meta">{sats!.toLocaleString()} sats</div>}
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
  // The effective Loop Out minimum, read from the server (drive-mode P1 item 6).
  const [swapLimits, setSwapLimits] = useState<SwapLimits | null>(null);
  // The rate's state, for its note (drive-mode P1 item 3).
  const [rateInfo, setRateInfo] = useState<ExchangeRate | null>(null);
  // Fees paid over the last 30 days (drive-mode P2 item 14).
  const [costs, setCosts] = useState<MemberCosts | null>(null);
  const [pendingTreasuryChannel, setPendingTreasuryChannel] = useState(false);
  const [balances, setBalances] = useState<NodeBalances | null>(null);
  const [balFresh, setBalFresh] = useState<FreshnessState>(INITIAL_FRESHNESS);
  const [fundLoading, setFundLoading] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);
  const subStatus = useSubscriptionStatus();
  const [nameRead, setNameRead] = useState<BitcornNameRead>({ state: "loading" });

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

  // Fetch advisor status (less frequently — it's a heavier call with Loop check).
  // Also the Loop alert's action (drive-mode P2 item 6).
  const loadAdvisor = useCallback(() => {
    api.getMemberLiquidityStatus().then(setAdvisor).catch(() => {});
  }, []);
  useEffect(() => {
    loadAdvisor();
    const id = setInterval(loadAdvisor, 60_000);
    return () => clearInterval(id);
  }, [loadAdvisor]);

  // Member-name prompt: one read per mount. Saving in Settings and coming back
  // remounts this page, so the prompt clears on the next read with no event or
  // cache flag (the prompt is derived; a second source of truth is not needed).
  useEffect(() => {
    api.getBitcornName()
      .then((n) => setNameRead({ state: "loaded", bitcorn_name: n.bitcorn_name }))
      .catch(() => setNameRead({ state: "failed" }));
  }, []);

  // Exchange rate for USD display. Also the no-price alert's "Check again".
  const loadRate = useCallback(() => {
    api.getExchangeRate().then((r) => { setRateInfo(r); setUsdRate(r.usd); }).catch(() => {});
  }, []);
  useEffect(() => {
    loadRate();
    api.getSwapLimits().then(setSwapLimits).catch(() => {});
    // A failed read shows no costs panel; nothing else depends on it.
    api.getMemberCosts().then(setCosts).catch(() => {});
  }, [loadRate]);

  // Balance polling.
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

  // drive-mode P2 (R27(10)): the client-side "Estimated fee" guess is gone; the
  // Withdraw page's quote is the fee a farmer is shown.

  const pctOf = (sats: number) => (ch && ch.capacity_sats > 0 ? Math.round((sats / ch.capacity_sats) * 100) : 0);
  const localPct = ch ? pctOf(ch.local_sats) : 0;
  const remotePct = ch ? pctOf(ch.remote_sats) : 0;

  const hasChannel = !loading && ch != null;
  // U24 H2: three distinct states — stats failed to load (statsUnavailable,
  // only reachable when the initial fetch failed and no poll has recovered),
  // genuinely no channel (stats loaded, treasury_channel null), and has-channel.
  const statsUnavailable = !loading && stats == null;
  const noChannel = !loading && stats != null && ch == null;
  const balStatus = freshnessStatus(balFresh, balances != null);

  // SH9: the DECLARED role, which the API returns whether or not the
  // treasury channel is active (classification is null while it isn't).
  // Read here, above the channel tile, because H2's headline labels depend on
  // it too.
  const role = advisor?.channelRole ?? advisor?.classification?.channelRole ?? "unknown";
  const isMerchant = role === "merchant";
  const isFarmer = role === "farmer";
  const minWithdrawal = swapLimits?.loop_out?.min_sats ?? null;

  // V11: the capacity colour comes from the advisor's state, never red; an
  // unknown role or no classification is neutral (components/capacityTone.ts).
  const tone = capacityTone(role, advisor?.classification);
  // PR3-7: the headline's first number (the old hero) never turns amber — a
  // warning stays in --text.
  const heroColor = CAPACITY_TEXT_COLOR[tone];

  // H2's headline numbers, ruled per role (P6-7 for the rest). Farmer: what is
  // in their connection, then room to receive. Merchant: what they can send,
  // then their total. An undeclared role: the channel's two sides, neutrally.
  // No channel: "—" with "No channel yet", never 0.
  //
  // drive-mode P2: the farmer's first label is "In your connection" (R11(2)),
  // still the local balance. The farmer's room to receive and the merchant's
  // available to send are P1's server figures (R27(1)); labels unchanged. The
  // unknown role's two numbers are not named by R27(1) and stay raw.
  // Pinned by MemberDashboard.topRegion.test.tsx (D2.2).
  const hl1Label = isMerchant ? "Available to send" : isFarmer ? "In your connection" : "Your balance";
  const hl1Sats = ch ? (isMerchant ? ch.room_to_send_sats : ch.local_sats) : null;
  const hl2Label = isMerchant ? "Total" : "Room to receive";
  const hl2Sats = isMerchant
    ? (balances ? balances.total_sats : null)
    : ch ? (isFarmer ? ch.room_to_receive_sats : ch.remote_sats) : null;
  const hl2Sub = isMerchant ? "Bitcoin + channel" : "Inbound on your hub channel";

  // J9 / J9a (P6-3): the subscription banner's slot. On a phone the top slot
  // stays above the headline; the info slot goes below it and the chart.
  const subSlot = subscriptionBannerSlot(subStatus);
  const subBanner = <MemberSubscriptionBanner status={subStatus} usdRate={usdRate} />;

  return (
    <div className="dash">
      <div className="dash-notices dash-notices-top">
        {subSlot === "top" && subBanner}

        {/* Cert-expiry arc: the farmer's own node telling them its TLS
            certificate is running out.

            ⚠ PAGE-TOP, OUTSIDE ALL THREE STATE GATES — deliberately NOT inside
            the {hasChannel && ...} block below, where the staleness notice
            lives. That gate is correct for a notice ABOUT the channel numbers;
            it is wrong here. A member with no channel still has an LND with a
            cert, and a NEWLY-PROVISIONED member is exactly who is on the clock
            of a cert issued at install time. Nesting this under hasChannel
            would hide it from them. J9 (P6-3): it stays in the top slot on a
            phone too.

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
      </div>

      <div className="dash-notices dash-notices-info">
        {subSlot === "info" && subBanner}

        {/* Member-name prompt (D6 §2, §4; spec 2026-09-23-member-name-prompt §7).

            ⚠ PAGE-TOP, OUTSIDE ALL THREE STATE GATES — for the same reason as
            the cert notice above, and do NOT "align" it with the role nudge,
            which lives inside {hasChannel && ...}. Every member this prompt
            exists for is channel-less (nine of nine, D6 §2); under hasChannel it
            would render for none of them. J9: on a phone it sits below the
            headline numbers and the chart (the info slot); on desktop it keeps
            its place above the page header.

            ⚠ TRIGGERED ONLY BY THE STORED NAME — never subStatus, tier, stats,
            channel or role. subStatus is null until the first token lands,
            which is exactly the first-boot window this targets (D6 §4). A
            failed or pending name read renders nothing (memberNamePrompt.ts).
            No dismiss: it stays until a name is set. Pinned by
            MemberDashboard.namePrompt.test.tsx.

            The action deep-links to the name field (?focus=name — read by
            SettingsPage in App.tsx; the receiving half is pinned by
            App.settingsNameLink.test.tsx). */}
        {(() => {
          const prompt = memberNamePromptFor(nameRead);
          if (!prompt.render) return null;
          return (
            <div className="alert info">
              <span className="alert-icon" aria-hidden>◉</span>
              <div className="alert-body">
                <div className="alert-type">{prompt.headline}</div>
                <div className="alert-msg">{prompt.body}</div>
                <button
                  className="btn btn-outline alert-action"
                  onClick={() => navigate("/settings?focus=name")}
                >
                  {prompt.actionLabel}
                </button>
              </div>
            </div>
          );
        })()}
      </div>

      <div className="dash-header">
        <h1>My Dashboard</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Your connection to the Bitcorn Lightning hub
        </p>
        {/* drive-mode P2 item 8: state "none" is the no-price alert below the
            chart, not this line; "Price as of" (stale) stays here. */}
        {rateInfo?.state !== "none" && rateNote(rateInfo) && (
          <p className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4 }}>{rateNote(rateInfo)}</p>
        )}
      </div>

      {/* ── H2: the headline numbers, first and largest. ── */}
      <section className="headline fade-in" aria-label="Headline numbers">
        <div className="hl hl-1">
          <div className="hl-label">{hl1Label}</div>
          <div
            className="hl-value"
            {...(hl1Sats != null
              ? {
                  "data-testid": "capacity-text",
                  style: { color: heroColor },
                  "aria-label": `${hl1Label}: ${hl1Sats.toLocaleString()} sats`,
                }
              : {})}
          >
            <span className="hl-num">{hl1Sats != null ? hl1Sats.toLocaleString() : "—"}</span><span className="unit">sats</span>
          </div>
          <div className="hl-sub">
            {hl1Sats != null ? (toUsd(hl1Sats) ?? " ") : noChannel ? "No channel yet" : " "}
          </div>
        </div>
        <div className="hl">
          <div className="hl-label">{hl2Label}</div>
          <div className="hl-value">
            <span className="hl-num">{hl2Sats != null ? hl2Sats.toLocaleString() : "—"}</span><span className="unit">sats</span>
          </div>
          <div className="hl-sub">
            {hl2Sats != null && toUsd(hl2Sats) ? `${toUsd(hl2Sats)} · ${hl2Sub}` : hl2Sub}
          </div>
        </div>
      </section>

      {/* U24 H8: Tier C — the numbers keep last-good values; these lines say
          when they can no longer be confirmed. */}
      <div className="headline-status">
        {/* U24 / cert-expiry arc: the channel numbers come from SQLite via
            /api/member/stats, which answers 200 even when LND is unreachable —
            so components/freshness.ts (poll-outcome driven) can never mark
            them. This is DATA-AGE driven, and it sits directly under the
            numbers it describes: since H2 those are the headline's. Renders
            nothing on a healthy node. */}
        {hasChannel && (() => {
          const notice = channelStalenessNotice(
            ch!.freshness,
            stats?.lnd_live_read_ok ?? true,
            Date.now(),
          );
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
        {balStatus === "stale" && (
          <StaleMarker state={balFresh} nowMs={Date.now()} noun="Balances" />
        )}
        {balStatus === "unavailable" && (
          <div className="status-line" role="status">
            Couldn't load balances — retrying automatically. Your funds are unaffected.
          </div>
        )}
      </div>

      {/* ── CHART: the Bitcoin price, IMMEDIATELY beneath the headline numbers
          and before any other section (Ethan, round 1: "our customers and
          kevin want to know the price of bitcoin so I think they should be
          underneath the balance of the node"). ── */}
      <BitcoinPriceGraph />

      {/* ── ALERTS: drive-mode P2's alerts that involve no automatic transfer,
          one sentence and one action each (C6; the record :52). Directly
          below the chart on desktop and phone alike, so nothing above the
          chart changes when one fires (D2.2). Empty, and hidden, on a healthy
          dashboard (.dash-notices:empty). Pinned by
          MemberDashboard.alerts.test.tsx. ── */}
      <div className="dash-notices dash-notices-alerts">
        {/* Item 5 (R18(2)): the hub channel is inactive. The stats fall back to
            the largest inactive hub channel for display, so this can fire.
            Nothing in the app reconnects it; "Check again" re-reads (R27(12)). */}
        {hasChannel && ch!.is_active === false && (
          <div className="alert warning">
            <span className="alert-icon" aria-hidden>⚠</span>
            <div className="alert-body">
              <div className="alert-msg">
                Your connection to Bitcorn is down, so payments can't go through it right now. It usually reconnects within a few minutes; if it's still down in an hour, restart the Lightning app.
              </div>
              <button className="btn btn-outline alert-action" onClick={() => void loadStats()}>
                Check again
              </button>
            </div>
          </div>
        )}
        {/* Item 6 (D2.3): Loop unavailable, for the member's direction — a
            farmer's Withdraw (loop_out), a merchant's Top Up (loop_in); an
            unknown role has neither. The sentence is the API's, verbatim
            (2026-09-02 D2(b)); the action re-reads the status. */}
        {(() => {
          const loopAlert = isFarmer ? advisor?.loopAlert?.loop_out : isMerchant ? advisor?.loopAlert?.loop_in : null;
          if (!loopAlert) return null;
          return (
            <div className="alert warning">
              <span className="alert-icon" aria-hidden>⚠</span>
              <div className="alert-body">
                <div className="alert-msg">{loopAlert.text}</div>
                <button className="btn btn-outline alert-action" onClick={loadAdvisor}>
                  {loopAlert.action.label}
                </button>
              </div>
            </div>
          );
        })()}
        {/* Item 8: no price (state "none" — stale past 6 hours, or never
            fetched). Amounts show in sats; "Check again" re-reads (R27(12)). */}
        {rateInfo?.state === "none" && (
          <div className="alert info">
            <span className="alert-icon" aria-hidden>i</span>
            <div className="alert-body">
              <div className="alert-msg">{RATE_NONE_SENTENCE}</div>
              <button className="btn btn-outline alert-action" onClick={loadRate}>
                Check again
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="dash-grid">
        {/* U24 H2: stats fetch failed and nothing loaded yet — error state, NOT
            the Connect-to-Hub onboarding form. */}
        {statsUnavailable && (
          <div className="panel ops fade-in">
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
          <div className="panel ops fade-in">
            <div className="panel-header">
              <span className="panel-title"><span className="icon">◈</span>Connect to Hub</span>
            </div>
            <div className="panel-body">
              <div className="alert healthy">
                <span className="alert-icon">✓</span>
                <div className="alert-body">
                  <div className="alert-type">Channel opening submitted</div>
                  <div className="alert-msg">
                    Your channel to the hub is being broadcast. It will become active after 1–3 on-chain confirmations. This page will update automatically.
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
        {noChannel && !pendingTreasuryChannel && (
          <div className="panel ops fade-in span-all">
            <div className="panel-header">
              <span className="panel-title"><span className="icon">◈</span>Connect to Hub</span>
            </div>
            <div className="panel-body">
              <ConnectToHub isPeered={stats?.is_peered_to_hub ?? false} initialCapacity={upgradeCapacity} />
            </div>
          </div>
        )}

        {loading && (
          <div className="panel ops fade-in">
            <div className="panel-header">
              <span className="panel-title"><span className="icon">◈</span>Your Earnings</span>
            </div>
            <div className="panel-body stack">
              {[100, 80, 90].map((w, i) => (
                <div key={i} className="loading-shimmer" style={{ height: 16, width: `${w}%` }} />
              ))}
            </div>
          </div>
        )}

        {hasChannel && (() => {
          const rec = advisor?.recommendation;

          // Role-aware gauge, from P1's server figures (drive-mode P2, item 2;
          // copy defect (f)). A percentage and the bar, no sats: the headline
          // already shows the figure (D2.1). No mark is drawn (R11(5) is P3's).
          // Merchant: room to send / capacity — depletes as they spend
          // Farmer: room to receive / capacity — empties as earnings arrive
          // Unknown: raw local/remote split
          const gaugeLabel = isMerchant ? "Room to send" : isFarmer ? "Room to receive" : "Channel balance";
          const gaugePct = isMerchant
            ? pctOf(ch!.room_to_send_sats)
            : isFarmer
              ? pctOf(ch!.room_to_receive_sats)
              : localPct;
          const gaugeRemaining = isMerchant || isFarmer
            ? `${gaugePct}% of your connection`
            : `${localPct}% on your side — ${remotePct}% on the hub's side`;
          // V11: the colour comes from the advisor's state, never red; an unknown
          // role or no classification is neutral (components/capacityTone.ts).
          const gaugeColor = CAPACITY_BAR_COLOR[tone];
          const gaugeWord = capacityWord(role, tone);

          // Panel title
          const panelTitle = isMerchant ? "Merchant Channel" : isFarmer ? "Your Earnings" : "Your Channel";

          // Advisor-aware navigation URLs
          const cashOutUrl = rec?.action === "loop_out" && rec?.suggestedAmountSats
            ? `/cashout?amount=${rec.suggestedAmountSats}` : "/cashout";
          const refillUrl = rec?.action === "loop_in" && rec?.suggestedAmountSats
            ? `/refill?amount=${rec.suggestedAmountSats}` : "/refill";

          // Advisor alert. PR3-3: it reports capacity, which is never an error, so
          // high urgency takes the warning, not the red critical.
          const alertClass = rec?.urgency === "high" || rec?.urgency === "medium" ? "warning" : "info";
          const alertIcon = rec?.urgency === "high" || rec?.urgency === "medium" ? "⚠" : "ℹ";
          const showAlert = rec && rec.action !== "none";

          return (
            <div className="panel ops fade-in">
              <div className="panel-header">
                <span className="panel-title">
                  <span className="icon">◈</span>{panelTitle}
                </span>
                <span className={`badge ${ch!.is_active ? "badge-green" : "badge-muted"}`}>
                  {ch!.is_active ? "active" : "inactive"}
                </span>
              </div>
              <div className="panel-body stack">
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
                    {/* The label and its word stay on one line; on a phone the
                        right-hand figure wraps instead. */}
                    <span data-testid="gauge-label" style={{ whiteSpace: "nowrap" }}>
                      {gaugeLabel}
                      {gaugeWord && <span data-testid="capacity-text" style={{ color: "var(--text)" }}> · {gaugeWord}</span>}
                    </span>
                    <span>{gaugeRemaining}</span>
                  </div>
                  <div className="bar">
                    <div className="fill" data-testid="capacity-bar" style={{ width: `${gaugePct}%`, background: gaugeColor }} />
                  </div>
                </div>

                {/* Advisor-driven alert */}
                {showAlert && (
                  <div className={`alert ${alertClass}`}>
                    <span className="alert-icon">{alertIcon}</span>
                    <div className="alert-body">
                      <div className="alert-msg">{rec!.reason}</div>
                    </div>
                  </div>
                )}

                {/* Role not set — prompt */}
                {role === "unknown" && (
                  <div className="alert info">
                    <span className="alert-icon">◈</span>
                    <div className="alert-body">
                      <div className="alert-msg">
                        Set your channel role to get tailored capacity recommendations.
                      </div>
                      <button
                        className="btn btn-outline alert-action"
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
                    <button className="btn btn-primary btn-block" onClick={() => navigate(refillUrl)}>
                      Top Up →
                    </button>
                    <div className="caption">
                      {rec?.suggestedAmountSats
                        ? `Bitcorn recommends ${rec.suggestedAmountSats.toLocaleString()} sats — pre-filled for you.`
                        : "Add funds from your Bitcoin balance to keep paying."}
                    </div>
                  </div>
                )}

                {/* Farmer: withdraw action.
                    Rendered on balance as before; ENABLED on the Loop daemon
                    flag (./withdrawCtaGate.ts — decisions B/C, 2026-09-02).
                    The render condition is deliberately unchanged: the gate
                    governs enabledness inside it, not whether it appears. */}
                {isFarmer && (minWithdrawal == null || ch!.local_sats >= minWithdrawal) && ch!.local_sats > 0 && (
                  (() => {
                    const withdrawGate = withdrawCtaGate(advisor);
                    return (
                      <div className="member-action">
                        <button
                          className="btn btn-primary btn-block"
                          disabled={!withdrawGate.enabled}
                          onClick={() => navigate(cashOutUrl)}
                        >
                          Withdraw Earnings →
                        </button>
                        {/* R27(10): no fee guess; the caption is the gate's
                            refusal only. */}
                        {withdrawGate.explanation && (
                          <div className="caption">{withdrawGate.explanation}</div>
                        )}
                      </div>
                    );
                  })()
                )}
                {/* D2.1: the balance is the headline's, so the hint does not
                    repeat it. */}
                {isFarmer && minWithdrawal != null && ch!.local_sats > 0 && ch!.local_sats < minWithdrawal && (
                  <div className="field-hint">
                    Minimum withdrawal: {minWithdrawal.toLocaleString()} sats.
                  </div>
                )}

                {/* Channel details (collapsible). One tap down, so D2.1 does
                    not count it (R27(4)); it holds the breakdown behind the
                    room figures. "Hub's side" is the raw remote balance —
                    "Room to receive" is the headline's P1 figure now. */}
                <details className="tile-details">
                  <summary>Channel details</summary>
                  <div className="kv-list">
                    <div className="kv"><span className="kv-label">Channel capacity</span><span className="kv-value">{ch!.capacity_sats.toLocaleString()} sats</span></div>
                    <div className="kv"><span className="kv-label">Your side</span><span className="kv-value">{ch!.local_sats.toLocaleString()} sats</span></div>
                    <div className="kv"><span className="kv-label">Hub's side</span><span className="kv-value">{ch!.remote_sats.toLocaleString()} sats</span></div>
                    <div className="kv"><span className="kv-label">Your reserve</span><span className="kv-value">{(ch!.local_reserve_sats ?? 0).toLocaleString()} sats</span></div>
                    <div className="kv"><span className="kv-label">Hub's reserve</span><span className="kv-value">{(ch!.remote_reserve_sats ?? 0).toLocaleString()} sats</span></div>
                    <div className="kv"><span className="kv-label">In flight</span><span className="kv-value">{((ch!.pending_outgoing_sats ?? 0) + (ch!.pending_incoming_sats ?? 0)).toLocaleString()} sats</span></div>
                    <div className="kv"><span className="kv-label">Channel role</span><span className="kv-value" style={{ textTransform: "capitalize" }}>{role}</span></div>
                  </div>
                </details>
              </div>
            </div>
          );
        })()}

        {/* ── Your node: the detail behind the headline. The membership badge
            (it used to be its own row) sits in this tile's header. ── */}
        <div className="panel fade-in">
          <div className="panel-header">
            <span className="panel-title"><span className="icon">₿</span>Your Node</span>
            {loading ? (
              <div className="loading-shimmer" style={{ height: 18, width: 100 }} />
            ) : (
              <span className={`badge ${badge.cls}`} aria-label={`Membership status: ${badge.text}`}>{badge.text}</span>
            )}
          </div>
          <div className="panel-body stack">
            <div className="kv-list">
              {/* J7 (P6-1): the farmer's lifetime received, in the DETAIL —
                  never a headline number. Every settled inbound payment the
                  node has recorded (GET /api/member/stats). An API that does
                  not send the field shows "—", never 0. */}
              {/* drive-mode P2, item 4: each figure is dollars first, its sats
                  underneath in .kv-meta (R27(3), the interim until
                  member-first-run-ui ships the shared component). With no
                  rate (state "none") the value is sats, and the page's no-price
                  sentence says why. The "Channel" row is gone: it repeated the
                  headline's figure (D2.1). */}
              {isFarmer && (
                <div className="kv">
                  <div>
                    <div className="kv-label">Received, lifetime</div>
                    <div className="kv-meta">Settled Lightning payments</div>
                  </div>
                  <NodeFigure sats={stats?.lifetime_received_sats ?? null} usd={toUsd} testId="lifetime-received" />
                </div>
              )}
              <div className="kv">
                <span className="kv-label">Bitcoin</span>
                <NodeFigure sats={balances ? balances.onchain_sats : null} usd={toUsd} />
              </div>
              {/* The merchant's total is a headline number; nobody else's is. */}
              {!isMerchant && (
                <div className="kv">
                  <span className="kv-label">Total</span>
                  <NodeFigure sats={balances ? balances.total_sats : null} usd={toUsd} />
                </div>
              )}
            </div>
            <button className="btn btn-primary btn-block" onClick={handleFund} disabled={fundLoading}>
              {fundLoading ? "Opening…" : "Fund Node →"}
            </button>
            {fundError && <div className="status-line">{fundError}</div>}
          </div>
        </div>

        {/* ── Costs, last 30 days (drive-mode P2 item 14; the record :48):
            the total in dollars, its sats underneath, itemised one tap down.
            Payment fees and swap fees only — no subscription line (R27(9)).
            The member's own direction is always listed; the other only when
            it is not zero, so the rows always sum to the total. ── */}
        {costs && (() => {
          const rows: Array<[string, number]> = [["Payment fees", costs.payment_fees_sat]];
          if (!isMerchant || costs.withdraw_fees_sat > 0) rows.push(["Withdraw fees", costs.withdraw_fees_sat]);
          if (!isFarmer || costs.topup_fees_sat > 0) rows.push(["Top Up fees", costs.topup_fees_sat]);
          const dollars = toUsd(costs.total_sat);
          return (
            <div className="panel fade-in">
              <div className="panel-header">
                <span className="panel-title"><span className="icon">≡</span>Costs, last 30 days</span>
              </div>
              <div className="panel-body stack">
                <div className="kv-list">
                  <div className="kv">
                    <span className="kv-label">Fees paid</span>
                    <div style={{ textAlign: "right" }}>
                      <span className="kv-value" data-testid="costs-total">
                        {dollars ?? `${costs.total_sat.toLocaleString()} sats`}
                      </span>
                      {dollars && <div className="kv-meta" data-testid="costs-total-sats">{costs.total_sat.toLocaleString()} sats</div>}
                    </div>
                  </div>
                </div>
                <details className="tile-details">
                  <summary>Itemised</summary>
                  <div className="kv-list">
                    {rows.map(([label, sats]) => (
                      <div className="kv" key={label} data-testid="cost-part" data-sats={sats}>
                        <span className="kv-label">{label}</span>
                        <span className="kv-value">{sats.toLocaleString()} sats</span>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            </div>
          );
        })()}

        {/* Upgrade banner when navigated from Channels page */}
        {hasChannel && upgradeCapacity && ch && ch.capacity_sats < upgradeCapacity && (
          <div className="panel ops fade-in span-all">
            <div className="panel-body">
              <div className="alert info">
                <span className="alert-icon">⚠</span>
                <div className="alert-body">
                  <div className="alert-type">Channel upgrade recommended</div>
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
      </div>
    </div>
  );
}
