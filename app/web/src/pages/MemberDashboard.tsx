import { useEffect, useState } from "react";
import { api, type MemberStats } from "../api/client";

function statusBadge(s: string) {
  switch (s) {
    case "active_member":
      return { text: "Active Member", cls: "badge-green" };
    case "treasury_channel_inactive":
      return { text: "Channel Inactive", cls: "badge-amber" };
    case "no_treasury_channel":
      return { text: "No Hub Channel", cls: "badge-red" };
    case "unsynced":
      return { text: "Syncing", cls: "badge-muted" };
    default:
      return { text: s.replace(/_/g, " "), cls: "badge-muted" };
  }
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

      {/* Hub channel */}
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">◈</span>Hub Channel
          </span>
          {!loading && ch && (
            <span className={`badge ${ch.is_active ? "badge-green" : "badge-muted"}`}>
              {ch.is_active ? "active" : "inactive"}
            </span>
          )}
        </div>
        <div className="panel-body">
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[100, 80, 90].map((w, i) => (
                <div
                  key={i}
                  className="loading-shimmer"
                  style={{ height: 16, width: `${w}%` }}
                />
              ))}
            </div>
          ) : !ch ? (
            <div className="empty-state">No channel to hub found.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div className="dashboard-grid">
                <div className="stat-card">
                  <div className="stat-label">Local Balance</div>
                  <div className="stat-value">{ch.local_sats.toLocaleString()}</div>
                  <div className="stat-sub">sats</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Remote Balance</div>
                  <div className="stat-value">{ch.remote_sats.toLocaleString()}</div>
                  <div className="stat-sub">sats</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Capacity</div>
                  <div className="stat-value">{ch.capacity_sats.toLocaleString()}</div>
                  <div className="stat-sub">sats</div>
                </div>
              </div>

              {/* Balance bar */}
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

      {/* Forwarded fees */}
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">↗</span>Forwarded Fees Earned
          </span>
        </div>
        <div className="panel-body">
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[100, 60].map((w, i) => (
                <div
                  key={i}
                  className="loading-shimmer"
                  style={{ height: 16, width: `${w}%` }}
                />
              ))}
            </div>
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}
