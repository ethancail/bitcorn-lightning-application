import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  api,
  type MemberStats,
  type PreflightResult,
  type TreasuryInfo,
  type MemberLiquidityStatusResponse,
} from "../api/client";
import NodeBalancePanel from "../components/NodeBalancePanel";
import FundNodePanel from "../components/FundNodePanel";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";

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
  const [socket, setSocket] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(true);
  const [treasuryInfo, setTreasuryInfo] = useState<TreasuryInfo | null>(null);
  const [treasuryInfoLoading, setTreasuryInfoLoading] = useState(true);

  useEffect(() => {
    api.getNodePreflight()
      .then(setPreflight)
      .catch(() => setPreflight(null))
      .finally(() => setPreflightLoading(false));
  }, []);

  useEffect(() => {
    api.getTreasuryInfo()
      .then(setTreasuryInfo)
      .catch(() => setTreasuryInfo(null))
      .finally(() => setTreasuryInfoLoading(false));
  }, []);

  function retryPreflight() {
    setPreflightLoading(true);
    api.getNodePreflight()
      .then(setPreflight)
      .catch(() => setPreflight(null))
      .finally(() => setPreflightLoading(false));
  }

  const hubPubkey = treasuryInfo?.pubkey || HUB_PUBKEY;
  const hubSocket = treasuryInfo?.socket || null;
  const hasAutoSocket = !!hubSocket;

  async function handleOpen() {
    setSubmitting(true);
    setError(null);
    try {
      const partnerSocket = hasAutoSocket && !isPeered ? hubSocket : socket.trim() || undefined;
      const res = await api.openMemberChannel({
        capacity_sats: capacity,
        partner_socket: partnerSocket || undefined,
      });
      setSuccess(res.funding_txid ?? "submitted");
    } catch (e: any) {
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
            Open a channel to the hub to start routing payments and earning forwarding fees.
          </div>
        </div>
      </div>

      {/* Preflight warning */}
      {!preflightLoading && preflight && !preflight.all_passed && (
        <div className="alert warning" style={{ marginBottom: 0 }}>
          <span className="alert-icon">⚠</span>
          <div className="alert-body">
            <div className="alert-type">Configuration Required</div>
            {preflight.checks
              .filter((c) => !c.passed)
              .map((c) => (
                <div key={c.check} className="alert-msg">{c.message}</div>
              ))}
            <button
              className="btn btn-outline"
              style={{ marginTop: 8 }}
              onClick={retryPreflight}
              disabled={preflightLoading}
            >
              {preflightLoading ? "Checking…" : "Retry Check"}
            </button>
          </div>
        </div>
      )}

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
          <input
            className="form-input"
            type="number"
            value={capacity}
            min={100_000}
            onChange={(e) => setCapacity(Math.max(100_000, Number(e.target.value)))}
          />
          <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
            Recommended: 1M–10M sats. Minimum: 100,000 sats.
          </div>
        </div>

        {/* Peering section */}
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
            <span>Already connected to hub via gossip — no address needed</span>
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
            <span>Treasury address found — will connect automatically</span>
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
              placeholder="host:port — only needed if not already peered"
              value={socket}
              onChange={(e) => setSocket(e.target.value)}
            />
            <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
              Leave blank if your node is already connected to the hub via gossip.
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

        <button
          className="btn btn-primary"
          onClick={handleOpen}
          disabled={submitting || capacity < 100_000 || preflightLoading || (preflight != null && !preflight.all_passed)}
        >
          {submitting ? "Connecting…" : "Open Channel →"}
        </button>
      </div>

      {/* Hub pubkey for reference */}
      <div
        style={{
          borderTop: "1px solid var(--border)",
          paddingTop: 16,
        }}
      >
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: 8,
          }}
        >
          Hub Public Key
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
            lineHeight: 1.6,
          }}
        >
          {hubPubkey}
        </div>
      </div>
    </div>
  );
}

export default function MemberDashboard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const upgradeCapacity = parseInt(searchParams.get("upgrade_capacity") ?? "", 10) || undefined;
  const [stats, setStats] = useState<MemberStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [advisor, setAdvisor] = useState<MemberLiquidityStatusResponse | null>(null);
  const [usdRate, setUsdRate] = useState<number | null>(null);

  useEffect(() => {
    api
      .getMemberStats()
      .then((d) => {
        setStats(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    const id = setInterval(() => {
      api.getMemberStats().then(setStats).catch(() => {});
    }, 15_000);
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

  const ch = stats?.treasury_channel;
  const fees = stats?.forwarded_fees;
  const badge = statusBadge(stats?.membership_status ?? "");

  // USD conversion helper
  const toUsd = (sats: number) =>
    usdRate ? `$${((sats / 100_000_000) * usdRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;

  // Estimated withdrawal fee (~1-2% based on observed Loop Out costs)
  const estWithdrawalFee = ch ? Math.max(1500, Math.round(ch.local_sats * 0.008)) : 0;

  const localPct = ch ? Math.round((ch.local_sats / ch.capacity_sats) * 100) : 0;
  const remotePct = ch ? Math.round((ch.remote_sats / ch.capacity_sats) * 100) : 0;

  const hasChannel = !loading && ch != null;
  const noChannel = !loading && ch == null;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>My Dashboard</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Your connection to the Bitcorn Lightning hub
        </p>
      </div>

      <NodeBalancePanel />
      <FundNodePanel />
      <BitcoinPriceGraph />

      {/* Keysend disabled warning */}
      {!loading && stats && stats.keysend_enabled === false && (
        <div className="alert warning" style={{ marginBottom: 16 }}>
          <span className="alert-icon">⚠</span>
          <div className="alert-body">
            <div className="alert-type">Keysend Payments Disabled</div>
            <div className="alert-msg">
              Your node cannot receive rebalancing payments from the treasury.
              Enable "Receive Keysend Payments" in Umbrel → Lightning → Settings, then restart LND.
            </div>
          </div>
        </div>
      )}

      {/* Membership status */}
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-body" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--text-3)", fontSize: "0.875rem" }}>Membership status</span>
          {loading ? (
            <div className="loading-shimmer" style={{ height: 20, width: 120 }} />
          ) : (
            <span className={`badge ${badge.cls}`}>{badge.text}</span>
          )}
        </div>
      </div>

      {/* Channel — connect CTA or earnings panel */}
      {noChannel && (
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title"><span className="icon">◈</span>Connect to Hub</span>
          </div>
          <div className="panel-body">
            <ConnectToHub isPeered={stats?.is_peered_to_hub ?? false} initialCapacity={upgradeCapacity} />
          </div>
        </div>
      )}

      {loading && (
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
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

      {hasChannel && (
        <>
          {/* ─── Earnings Panel ─────────────────────────────────────────── */}
          <div className="panel fade-in" style={{ marginBottom: 16 }}>
            <div className="panel-header">
              <span className="panel-title">
                <span className="icon">◈</span>Your Earnings
              </span>
              <span className={`badge ${ch!.is_active ? "badge-green" : "badge-muted"}`}>
                {ch!.is_active ? "active" : "inactive"}
              </span>
            </div>
            <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Accumulated balance — the main number */}
              <div style={{ textAlign: "center", padding: "8px 0" }}>
                <div style={{ fontSize: "0.6875rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 6 }}>
                  Available to withdraw
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: "2rem", fontWeight: 600, color: "var(--text)", lineHeight: 1.2 }}>
                  {ch!.local_sats.toLocaleString()} <span style={{ fontSize: "0.875rem", color: "var(--text-3)", fontWeight: 400 }}>sats</span>
                </div>
                {toUsd(ch!.local_sats) && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: "1rem", color: "var(--text-2)", marginTop: 2 }}>
                    {toUsd(ch!.local_sats)}
                  </div>
                )}
              </div>

              {/* Receiving capacity gauge */}
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: "0.75rem", color: "var(--text-3)" }}>
                  <span>Receiving capacity</span>
                  <span>{remotePct}% — {ch!.remote_sats.toLocaleString()} sats remaining</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: "var(--bg-3)", overflow: "hidden" }}>
                  <div
                    style={{
                      height: "100%",
                      width: `${remotePct}%`,
                      background: remotePct < 15 ? "var(--red)" : remotePct < 30 ? "var(--amber)" : "var(--green)",
                      borderRadius: 4,
                      transition: "width 0.3s ease",
                    }}
                  />
                </div>
              </div>

              {/* Smart withdrawal nudges */}
              {localPct >= 95 && (
                <div className="alert critical" style={{ marginBottom: 0 }}>
                  <span className="alert-icon">✕</span>
                  <div className="alert-body">
                    <div className="alert-type">Channel Full</div>
                    <div className="alert-msg">
                      You must withdraw before you can receive more payments. Your receiving capacity is nearly exhausted.
                    </div>
                  </div>
                </div>
              )}
              {localPct >= 85 && localPct < 95 && (
                <div className="alert warning" style={{ marginBottom: 0 }}>
                  <span className="alert-icon">⚠</span>
                  <div className="alert-body">
                    <div className="alert-type">Receiving Capacity Low</div>
                    <div className="alert-msg">
                      Withdraw to continue accepting payments. Only {remotePct}% capacity remaining.
                    </div>
                  </div>
                </div>
              )}
              {localPct >= 70 && localPct < 85 && (
                <div className="alert info" style={{ marginBottom: 0 }}>
                  <span className="alert-icon">ℹ</span>
                  <div className="alert-body">
                    <div className="alert-msg">
                      Your channel is {localPct}% full. Consider withdrawing some earnings to free up space for more payments.
                    </div>
                  </div>
                </div>
              )}

              {/* Withdraw action */}
              {ch!.local_sats >= 250_000 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <button
                    className="btn btn-primary"
                    style={{ width: "100%" }}
                    onClick={() => navigate("/withdraw")}
                  >
                    Withdraw to Bitcoin Wallet →
                  </button>
                  <div style={{ textAlign: "center", fontSize: "0.6875rem", color: "var(--text-3)" }}>
                    Estimated fee: ~{estWithdrawalFee.toLocaleString()} sats
                    {toUsd(estWithdrawalFee) && ` (${toUsd(estWithdrawalFee)})`}
                  </div>
                </div>
              ) : ch!.local_sats > 0 ? (
                <div style={{ textAlign: "center", fontSize: "0.75rem", color: "var(--text-3)" }}>
                  Minimum withdrawal: 250,000 sats. You have {ch!.local_sats.toLocaleString()} sats.
                </div>
              ) : null}

              {/* Channel details (collapsible) */}
              <details style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
                <summary style={{ cursor: "pointer", userSelect: "none" }}>Channel details</summary>
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Channel capacity</span>
                    <span style={{ fontFamily: "var(--mono)" }}>{ch!.capacity_sats.toLocaleString()} sats</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Your balance (outbound)</span>
                    <span style={{ fontFamily: "var(--mono)" }}>{ch!.local_sats.toLocaleString()} sats</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Receiving capacity (inbound)</span>
                    <span style={{ fontFamily: "var(--mono)" }}>{ch!.remote_sats.toLocaleString()} sats</span>
                  </div>
                </div>
              </details>
            </div>
          </div>

          {/* Upgrade banner when navigated from Channels page */}
          {upgradeCapacity && ch && ch.capacity_sats < upgradeCapacity && (
            <div className="panel fade-in" style={{ marginBottom: 16 }}>
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
      )}

      {/* Forwarded fees — only show once they have / had a channel */}
      {(hasChannel || (fees && fees.total_sats > 0)) && (
        <div className="panel fade-in">
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">↗</span>Forwarded Fees Earned
            </span>
          </div>
          <div className="panel-body">
            <div className="dashboard-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
              <div className="stat-card">
                <div className="stat-label">Last 24h</div>
                <div className="stat-value">{fees?.last_24h_sats.toLocaleString() ?? "—"}</div>
                <div className="stat-sub">sats</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Last 30 days</div>
                <div className="stat-value">{fees?.last_30d_sats.toLocaleString() ?? "—"}</div>
                <div className="stat-sub">sats</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">All Time</div>
                <div className="stat-value">{fees?.total_sats.toLocaleString() ?? "—"}</div>
                <div className="stat-sub">sats</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
