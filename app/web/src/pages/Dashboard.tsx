import { useState, useEffect } from "react";
import { api, type TreasuryMetrics, type TreasuryAlert, type NodeBalances } from "../api/client";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";
import SubscriptionRevenuePanel from "../components/SubscriptionRevenuePanel";
import RailFeeRevenuePanel from "../components/RailFeeRevenuePanel";
import ValuationInputAlertBanner from "../components/ValuationInputAlertBanner";
import AlertRow from "../components/AlertRow";
import StaleMarker from "../components/StaleMarker";
import {
  INITIAL_FRESHNESS,
  freshnessStatus,
  recordFailure,
  recordSuccess,
  type FreshnessState,
} from "../components/freshness";

/** Printed when an alert arrives without a heading (SH1). */
export const TREASURY_ALERT_FALLBACK_HEADING = "Treasury alert";

function fmt(n: number) {
  return n.toLocaleString();
}

function formatSigned(n: number): { text: string; cls: "positive" | "negative" | "neutral" } {
  if (n > 0) return { text: `+${n.toLocaleString()}`, cls: "positive" };
  if (n < 0) return { text: `−${Math.abs(n).toLocaleString()}`, cls: "negative" };
  return { text: "0", cls: "neutral" };
}

export default function Dashboard() {
  const [metrics, setMetrics] = useState<TreasuryMetrics | null>(null);
  const [alerts, setAlerts] = useState<TreasuryAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [balances, setBalances] = useState<NodeBalances | null>(null);
  const [balFresh, setBalFresh] = useState<FreshnessState>(INITIAL_FRESHNESS);
  const [fundLoading, setFundLoading] = useState(false);
  const [fundError, setFundError] = useState<string | null>(null);

  useEffect(() => {
    Promise.allSettled([
      api.getTreasuryMetrics(),
      api.getAlerts(),
    ]).then(([mR, aR]) => {
      if (mR.status === "fulfilled") setMetrics(mR.value);
      if (aR.status === "fulfilled") setAlerts(aR.value);
      setLoading(false);
    });
  }, []);

  // Poll alerts every 60s
  useEffect(() => {
    const id = setInterval(() => {
      api.getAlerts().then(setAlerts).catch(() => {});
      api.getTreasuryMetrics().then(setMetrics).catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // Balance polling.
  // U24 H8 (treasury): poll results feed the freshness tracker — on repeated
  // failures the strip keeps last-good numbers with a staleness marker instead
  // of clearing to "—". Same treatment as the member dashboard (Batch A).
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

  const balStatus = freshnessStatus(balFresh, balances != null);
  const m24 = metrics?.last_24h;
  const mAll = metrics?.all_time;
  const cap = metrics?.capital_efficiency;
  const liq = metrics?.liquidity.channels_total;
  const net24 = metrics ? formatSigned(m24?.net_sats ?? 0) : null;
  const netAll = metrics ? formatSigned(mAll?.net_sats ?? 0) : null;
  // J7: the field the tile's label describes. revenue_yield is a fraction
  // (fees ÷ capital deployed), which this tile used to round to 0.
  const yieldPer1m = Math.round(cap?.revenue_per_1m_sats_deployed ?? 0);

  // Filter out VALUATION_MANUAL_STALE — it has its own dedicated banner with a
  // "Enter now →" link, so skipping it from the generic list avoids double-render.
  const activeAlerts = alerts.filter(
    (a) =>
      (a.severity === "critical" || a.severity === "warning") &&
      a.type !== "VALUATION_MANUAL_STALE",
  );

  return (
    <div className="dash">
      <div className="dash-header">
        <h1>Treasury Dashboard</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Capital allocation engine
        </p>
      </div>

      {/* ── H2: the headline numbers, first and largest. Order is ruled:
          24-hour net, total capital, capital deployed. The two capital
          figures count different channels (recorded under J7, not changed),
          so each says what it counts. ── */}
      <section className="headline fade-in" aria-label="Headline numbers">
        <div className="hl hl-1">
          <div className="hl-label">24-hour net</div>
          <div
            className={`hl-value ${net24?.cls ?? ""}`}
            aria-label={net24 ? `24 hour net revenue: ${
              net24.cls === "positive" ? "plus " : net24.cls === "negative" ? "minus " : ""
            }${Math.abs(m24?.net_sats ?? 0).toLocaleString()} sats` : undefined}
          >
            <span className="hl-num">{net24 ? net24.text : "—"}</span><span className="unit">sats</span>
          </div>
          {netAll && (
            <div
              className="hl-sub"
              aria-label={`all time net revenue: ${
                netAll.cls === "positive" ? "plus " : netAll.cls === "negative" ? "minus " : ""
              }${Math.abs(mAll?.net_sats ?? 0).toLocaleString()} sats`}
            >
              All-time {netAll.text} sats
            </div>
          )}
        </div>
        <div className="hl">
          <div className="hl-label">Total capital</div>
          <div className="hl-value">
            <span className="hl-num">{balances ? balances.total_sats.toLocaleString() : "—"}</span><span className="unit">sats</span>
          </div>
          <div className="hl-sub">On-chain + active channels</div>
        </div>
        <div className="hl">
          <div className="hl-label">Capital deployed</div>
          <div className="hl-value">
            <span className="hl-num">{metrics ? (cap?.capital_deployed_sats ?? 0).toLocaleString() : "—"}</span><span className="unit">sats</span>
          </div>
          <div className="hl-sub">Local balance, all channels</div>
        </div>
      </section>

      {/* U24 H8: Tier C — the numbers above keep last-good values; these
          lines say when they can no longer be confirmed. */}
      <div className="headline-status">
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

      {/* ── SH7: the alert rows sit below the chart. X3: compact one-line
          rows, the detail one tap away; the valuation banner takes the same
          row, with its "Enter now →" action. ── */}
      <ValuationInputAlertBanner alerts={alerts} />
      {activeAlerts.length > 0 && (
        <div className="dash-notices">
          {activeAlerts.map((a, i) => (
            // SH1: the server sets each heading where the alert is created
            // (treasury-alerts.ts and the two modules it calls). This prints
            // it, falling back to TREASURY_ALERT_FALLBACK_HEADING; it never
            // branches on a.type to choose one. Decision: bitcorn-research
            // decisions/2026-10-13-ui-redesign-shipping-plan-rulings-sh1-sh8.md
            <AlertRow
              key={i}
              severity={a.severity === "critical" ? "critical" : "warning"}
              heading={a.heading || TREASURY_ALERT_FALLBACK_HEADING}
              detail={a.message}
            />
          ))}
        </div>
      )}

      <div className="dash-grid">
        {/* ── Treasury Revenue: the detail behind the 24-hour net ── */}
        <div className="panel ops fade-in">
          <div className="panel-header">
            <span className="panel-title"><span className="icon">◈</span>Treasury Revenue</span>
            {!loading && activeAlerts.length === 0 && (
              <span className="badge badge-green">All systems healthy</span>
            )}
          </div>
          <div className="panel-body">
            {loading ? (
              <div className="stack">
                {[1, 2, 3].map((i) => <div key={i} className="loading-shimmer" style={{ height: 40, borderRadius: 6 }} />)}
              </div>
            ) : !metrics ? (
              <div className="empty-state">Unable to load treasury metrics.</div>
            ) : (
              <>
                <div className="kv-list">
                  <div className="kv">
                    <div>
                      <div className="kv-label">Forwarding fees</div>
                      <div className="kv-meta">
                        24h · earned on routed payments · all-time {formatSigned(mAll?.forwarded_fees_sats ?? 0).text}
                      </div>
                    </div>
                    <div className="kv-value" style={{ color: "var(--green)" }}>
                      {formatSigned(m24?.forwarded_fees_sats ?? 0).text}
                      <span className="unit">sats</span>
                    </div>
                  </div>
                  <div className="kv">
                    <div>
                      <div className="kv-label">Rebalance costs</div>
                      <div className="kv-meta">
                        24h · paid to rebalance ops · all-time {formatSigned(-Math.abs(mAll?.rebalance_costs_sats ?? 0)).text}
                      </div>
                    </div>
                    {/* E: a cost is a negative number, and 0 is none — both in --text (D3). */}
                    <div className="kv-value" style={{ color: "var(--text)" }}>
                      {formatSigned(-Math.abs(m24?.rebalance_costs_sats ?? 0)).text}
                      <span className="unit">sats</span>
                    </div>
                  </div>
                </div>
                <div className="figure-row">
                  <div className="figure">
                    <div className="figure-label">Active channels</div>
                    <div className="figure-value">{liq?.active_count ?? 0}</div>
                    <div className="figure-sub">of {liq?.total_count ?? 0} total</div>
                  </div>
                  <div className="figure">
                    <div className="figure-label">Revenue yield</div>
                    {/* D3: a negative yield is --text; its minus sign carries the meaning. */}
                    <div className="figure-value" style={{ color: yieldPer1m >= 0 ? "var(--green)" : "var(--text)" }}>
                      {fmt(yieldPer1m)}
                    </div>
                    <div className="figure-sub">sats per 1M deployed</div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Balances: the parts of total capital, and funding ── */}
        <div className="panel fade-in">
          <div className="panel-header">
            <span className="panel-title"><span className="icon">₿</span>Balances</span>
          </div>
          <div className="panel-body stack">
            <div className="kv-list">
              <div className="kv">
                <span className="kv-label">On-chain</span>
                <span className="kv-value">
                  {balances ? balances.onchain_sats.toLocaleString() : "—"}<span className="unit">sats</span>
                </span>
              </div>
              <div className="kv">
                <span className="kv-label">Channel</span>
                <span className="kv-value">
                  {balances ? balances.lightning_sats.toLocaleString() : "—"}<span className="unit">sats</span>
                </span>
              </div>
            </div>
            <button className="btn btn-primary btn-block" onClick={handleFund} disabled={fundLoading}>
              {fundLoading ? "Opening…" : "Fund Node →"}
            </button>
            {fundError && <div className="status-line">{fundError}</div>}
          </div>
        </div>

        {/* ── Subscription Revenue (on-chain member subscriptions) ── */}
        <SubscriptionRevenuePanel />

        {/* ── Stablecoin Fee Revenue (rail fees, USDC) ──
            Deliberately its own panel and NOT folded into the sats headline:
            USDC is dollar-denominated, and converting it through a live BTC
            price would invent a number. See RailFeeRevenuePanel's header for
            why a treasury-operator revenue view does not contradict the
            decision to keep rail PARTICIPATION surfaces off the treasury
            shell. */}
        <RailFeeRevenuePanel />
      </div>
    </div>
  );
}
