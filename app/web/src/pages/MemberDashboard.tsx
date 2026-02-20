import { useEffect, useState } from "react";
import { api, type MemberStats } from "../api/client";
import NodeBalancePanel from "../components/NodeBalancePanel";

const HUB_PUBKEY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";

const CAPACITY_PRESETS = [
  { label: "500k", value: 500_000 },
  { label: "1M", value: 1_000_000 },
  { label: "2M", value: 2_000_000 },
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

function ConnectToHub({ isPeered }: { isPeered: boolean }) {
  const [capacity, setCapacity] = useState(1_000_000);
  const [socket, setSocket] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(HUB_PUBKEY).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleOpen() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await api.openMemberChannel({
        capacity_sats: capacity,
        partner_socket: socket.trim() || undefined,
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
          <input
            className="form-input"
            type="number"
            value={capacity}
            min={100_000}
            onChange={(e) => setCapacity(Math.max(100_000, Number(e.target.value)))}
          />
          <div style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 4 }}>
            Recommended: 500k–2M sats. Minimum: 100,000 sats.
          </div>
        </div>

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
          disabled={submitting || capacity < 100_000}
        >
          {submitting ? "Opening…" : "Open Channel →"}
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
            marginBottom: 8,
          }}
        >
          {HUB_PUBKEY}
        </div>
        <button className="btn btn-ghost" onClick={handleCopy}>
          {copied ? "✓ Copied" : "Copy"}
        </button>
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

      <NodeBalancePanel />

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
            <ConnectToHub isPeered={stats?.is_peered_to_hub ?? false} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div className="dashboard-grid" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
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
