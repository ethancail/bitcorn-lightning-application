import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  api,
  type MemberStats,
  type TreasuryInfo,
  type MemberLiquidityStatusResponse,
  type PendingChannel,
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
              placeholder="host:port — needed if not already connected to the hub"
              value={socket}
              onChange={(e) => setSocket(e.target.value)}
            />
            <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
              Enter the hub's address to connect, or leave blank if already peered.
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
          disabled={submitting || capacity < 100_000}
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
  const [pendingTreasuryChannel, setPendingTreasuryChannel] = useState(false);

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

      {/* Channel — pending opening, connect CTA, or earnings panel */}
      {noChannel && pendingTreasuryChannel && (
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
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

      {hasChannel && (() => {
        const role = advisor?.classification?.channelRole ?? "unknown";
        const rec = advisor?.recommendation;
        const isMerchant = role === "merchant";
        const isFarmer = role === "farmer";

        // Role-aware gauge
        // Merchant: outbound capacity (local%) — depletes as they spend, green when high
        // Farmer: earnings accumulated (local%) — fills up like a grain bin, amber→green→amber→red as it fills
        // Unknown: raw local/remote split
        const gaugeLabel = isMerchant ? "Outbound capacity" : isFarmer ? "Earnings accumulated" : "Channel balance";
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

        // Hero number
        const heroLabel = isMerchant ? "Available to send" : isFarmer ? "Available to withdraw" : "Your balance";
        const heroSats = ch!.local_sats;

        // Panel title
        const panelTitle = isMerchant ? "Merchant Channel" : isFarmer ? "Your Earnings" : "Your Channel";

        // Advisor alert
        const alertClass = rec?.urgency === "high" ? "critical" : rec?.urgency === "medium" ? "warning" : "info";
        const alertIcon = rec?.urgency === "high" ? "✕" : rec?.urgency === "medium" ? "⚠" : "ℹ";
        const showAlert = rec && rec.action !== "none";

        return (
          <>
            <div className="panel fade-in" style={{ marginBottom: 16 }}>
              <div className="panel-header">
                <span className="panel-title">
                  <span className="icon">◈</span>{panelTitle}
                </span>
                <span className={`badge ${ch!.is_active ? "badge-green" : "badge-muted"}`}>
                  {ch!.is_active ? "active" : "inactive"}
                </span>
              </div>
              <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {/* Hero number */}
                <div style={{ textAlign: "center", padding: "8px 0" }}>
                  <div style={{ fontSize: "0.6875rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 6 }}>
                    {heroLabel}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: "2rem", fontWeight: 600, color: "var(--text)", lineHeight: 1.2 }}>
                    {heroSats.toLocaleString()} <span style={{ fontSize: "0.875rem", color: "var(--text-3)", fontWeight: 400 }}>sats</span>
                  </div>
                  {toUsd(heroSats) && (
                    <div style={{ fontFamily: "var(--mono)", fontSize: "1rem", color: "var(--text-2)", marginTop: 2 }}>
                      {toUsd(heroSats)}
                    </div>
                  )}
                </div>

                {/* Capacity gauge */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: "0.75rem", color: "var(--text-3)" }}>
                    <span>{gaugeLabel}</span>
                    <span>{gaugeRemaining}</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 4, background: "var(--bg-3)", overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${gaugePct}%`,
                        background: gaugeColor,
                        borderRadius: 4,
                        transition: "width 0.3s ease",
                      }}
                    />
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

                {/* Farmer: withdraw action */}
                {isFarmer && ch!.local_sats >= 250_000 && (
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
                      <span>Your balance (outbound)</span>
                      <span style={{ fontFamily: "var(--mono)" }}>{ch!.local_sats.toLocaleString()} sats</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Receiving capacity (inbound)</span>
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
        );
      })()}

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
