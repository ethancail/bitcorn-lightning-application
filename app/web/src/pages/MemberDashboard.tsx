import { useEffect, useState } from "react";
import { api, type MemberStats } from "../api/client";

const HUB_PUBKEY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";

const JOIN_STEPS = [
  "Connect your LND node to the hub using the public key above",
  "Open a Lightning channel to the hub (recommended: 500k–2M sats)",
  "Wait for the channel to confirm on-chain (≈1–3 blocks)",
  "This page will update automatically once you're active",
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

function ConnectToHub() {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(HUB_PUBKEY).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div className="alert info" style={{ marginBottom: 0 }}>
        <span className="alert-icon">◈</span>
        <div className="alert-body">
          <div className="alert-type">No hub channel</div>
          <div className="alert-msg">
            Open a channel to the hub to start routing payments and earning forwarding fees.
          </div>
        </div>
      </div>

      <div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            marginBottom: 8,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Hub Public Key
        </div>
        <div
          style={{
            background: "var(--bg-3)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "10px 14px",
            fontFamily: "var(--mono)",
            fontSize: "0.75rem",
            wordBreak: "break-all",
            color: "var(--text-1)",
            lineHeight: 1.6,
            marginBottom: 10,
          }}
        >
          {HUB_PUBKEY}
        </div>
        <button
          className="btn btn-primary"
          onClick={handleCopy}
          style={{ alignSelf: "flex-start" }}
        >
          {copied ? "✓ Copied!" : "Copy Public Key"}
        </button>
      </div>

      <div>
        <div
          style={{
            fontSize: "0.75rem",
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            marginBottom: 12,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          How to Join
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {JOIN_STEPS.map((step, i) => (
            <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <span
                style={{
                  minWidth: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: "var(--amber)",
                  color: "var(--bg)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  fontFamily: "var(--mono)",
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
              <span style={{ color: "var(--text-2)", fontSize: "0.875rem", lineHeight: 1.5 }}>
                {step}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function MemberDashboard() {
  const [stats, setStats] = useState<MemberStats | null>(null);
  const [loading, setLoading] = useState(true);

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

  const ch = stats?.treasury_channel;
  const fees = stats?.forwarded_fees;
  const badge = statusBadge(stats?.membership_status ?? "");

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

      {/* Hub channel — or connect CTA */}
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">◈</span>Hub Channel
          </span>
          {hasChannel && (
            <span className={`badge ${ch!.is_active ? "badge-green" : "badge-muted"}`}>
              {ch!.is_active ? "active" : "inactive"}
            </span>
          )}
        </div>
        <div className="panel-body">
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[100, 80, 90].map((w, i) => (
                <div key={i} className="loading-shimmer" style={{ height: 16, width: `${w}%` }} />
              ))}
            </div>
          ) : noChannel ? (
            <ConnectToHub />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div className="dashboard-grid">
                <div className="stat-card">
                  <div className="stat-label">Local Balance</div>
                  <div className="stat-value">{ch!.local_sats.toLocaleString()}</div>
                  <div className="stat-sub">sats</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Remote Balance</div>
                  <div className="stat-value">{ch!.remote_sats.toLocaleString()}</div>
                  <div className="stat-sub">sats</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Capacity</div>
                  <div className="stat-value">{ch!.capacity_sats.toLocaleString()}</div>
                  <div className="stat-sub">sats</div>
                </div>
              </div>

              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 6,
                    fontSize: "0.75rem",
                    color: "var(--text-3)",
                  }}
                >
                  <span>Local {localPct}%</span>
                  <span>Remote {remotePct}%</span>
                </div>
                <div
                  style={{
                    height: 8,
                    borderRadius: 4,
                    background: "var(--bg-3)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      height: "100%",
                      width: `${localPct}%`,
                      background: "var(--amber)",
                      borderRadius: 4,
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Forwarded fees — only show once they have / had a channel */}
      {(hasChannel || (fees && fees.total_sats > 0)) && (
        <div className="panel fade-in">
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">↗</span>Forwarded Fees Earned
            </span>
          </div>
          <div className="panel-body">
            <div className="dashboard-grid">
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
