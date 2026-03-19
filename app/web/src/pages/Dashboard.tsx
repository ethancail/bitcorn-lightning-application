import { useState, useEffect, useCallback } from "react";
import {
  api,
  resolveContactName,
  type TreasuryAlert,
  type TreasuryMetrics,
  type ChannelMetric,
  type PeerScore,
  type RotationCandidate,
  type ChannelFeeAdjustment,
  type ChannelLiquidityHealth,
  type TreasuryFeePolicy,
  type Contact,
} from "../api/client";
import NodeBalancePanel from "../components/NodeBalancePanel";
import FundNodePanel from "../components/FundNodePanel";
import BitcoinPriceGraph from "../components/BitcoinPriceGraph";

// ─── Helpers ──────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString();
}

function truncPk(pk: string) {
  if (!pk || pk.length < 20) return pk;
  return `${pk.slice(0, 12)}…${pk.slice(-6)}`;
}

function sats(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function freshness(date: Date | null): string {
  if (!date) return "";
  const secs = Math.round((Date.now() - date.getTime()) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return date.toLocaleTimeString();
}

type SortDir = "asc" | "desc";

function useSort<T>(data: T[], defaultKey: keyof T, defaultDir: SortDir = "desc") {
  const [key, setKey] = useState<keyof T>(defaultKey);
  const [dir, setDir] = useState<SortDir>(defaultDir);

  const sorted = [...data].sort((a, b) => {
    const av = a[key] as number | string;
    const bv = b[key] as number | string;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return dir === "asc" ? cmp : -cmp;
  });

  const toggle = (k: keyof T) => {
    if (k === key) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setKey(k); setDir("desc"); }
  };

  const arrow = (k: keyof T) => (k !== key ? " ↕" : dir === "asc" ? " ↑" : " ↓");

  return { sorted, toggle, arrow, key };
}

// ─── Panel wrapper ─────────────────────────────────────────────────────────

function Panel({
  title,
  icon,
  action,
  children,
  className,
  loading,
  error,
  updatedAt,
}: {
  title: string;
  icon: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  loading?: boolean;
  error?: string | null;
  updatedAt?: Date | null;
}) {
  return (
    <div className={`panel fade-in ${className ?? ""}`}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">{icon}</span>
          {title}
          {updatedAt && (
            <span className="freshness-hint">{freshness(updatedAt)}</span>
          )}
        </span>
        {action}
      </div>
      {loading ? (
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[100, 70, 90].map((w, i) => (
            <div key={i} className="loading-shimmer" style={{ height: 16, width: `${w}%` }} />
          ))}
        </div>
      ) : error ? (
        <div className="error-state">{error}</div>
      ) : (
        children
      )}
    </div>
  );
}

// ─── KPI Strip ────────────────────────────────────────────────────────────

function KpiStrip({
  metrics,
  atRisk,
  pendingFeeChanges,
  loading,
}: {
  metrics: TreasuryMetrics | null;
  atRisk: number;
  pendingFeeChanges: number;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="kpi-strip">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="kpi-card">
            <div className="loading-shimmer" style={{ height: 10, width: "60%", marginBottom: 6 }} />
            <div className="loading-shimmer" style={{ height: 20, width: "80%" }} />
          </div>
        ))}
      </div>
    );
  }

  const m = metrics;
  const kpis = [
    {
      label: "Net 24h",
      value: m ? `${m.last_24h.net_sats >= 0 ? "+" : ""}${sats(m.last_24h.net_sats)}` : "—",
      color: m ? (m.last_24h.net_sats >= 0 ? "var(--green)" : "var(--red)") : undefined,
      sub: "sats",
    },
    {
      label: "Fwd Fees 24h",
      value: m ? sats(m.last_24h.forwarded_fees_sats) : "—",
      color: "var(--amber)",
      sub: "sats",
    },
    {
      label: "Reb Costs 24h",
      value: m ? `-${sats(m.last_24h.rebalance_costs_sats)}` : "—",
      color: "var(--red)",
      sub: "sats",
    },
    {
      label: "Capital Deployed",
      value: m ? sats(m.capital_efficiency.capital_deployed_sats) : "—",
      sub: "sats",
    },
    {
      label: "At Risk",
      value: String(atRisk),
      color: atRisk > 0 ? "var(--red)" : "var(--green)",
      sub: atRisk === 1 ? "channel" : "channels",
    },
    {
      label: "Pending Fee Changes",
      value: String(pendingFeeChanges),
      color: pendingFeeChanges > 0 ? "var(--amber)" : "var(--text-3)",
      sub: pendingFeeChanges === 1 ? "update" : "updates",
    },
  ];

  return (
    <div className="kpi-strip">
      {kpis.map((k) => (
        <div key={k.label} className="kpi-card">
          <div className="kpi-label">{k.label}</div>
          <div className="kpi-value" style={k.color ? { color: k.color } : undefined}>
            {k.value}
          </div>
          <div className="kpi-sub">{k.sub}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Liquidity Posture ────────────────────────────────────────────────────

function LiquidityPosture({
  health,
  loading,
}: {
  health: ChannelLiquidityHealth[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="liquidity-posture">
        <div className="loading-shimmer" style={{ height: 14, width: "100%" }} />
      </div>
    );
  }

  const counts: Record<string, number> = {};
  for (const h of health) {
    const c = h.health_classification;
    counts[c] = (counts[c] ?? 0) + 1;
  }

  const categories = [
    { key: "outbound_starved", label: "Outbound Starved", color: "var(--red)" },
    { key: "weak", label: "Weak", color: "var(--yellow)" },
    { key: "healthy", label: "Healthy", color: "var(--green)" },
    { key: "inbound_heavy", label: "Inbound Heavy", color: "var(--blue)" },
    { key: "critical", label: "Critical", color: "var(--text-3)" },
  ];

  if (health.length === 0) {
    return (
      <div className="liquidity-posture">
        <span className="posture-label">Liquidity</span>
        <span style={{ color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: "0.75rem" }}>
          No channel data
        </span>
      </div>
    );
  }

  return (
    <div className="liquidity-posture">
      <span className="posture-label">Liquidity</span>
      {categories.map((cat) => {
        const count = counts[cat.key] ?? 0;
        if (count === 0) return null;
        return (
          <span key={cat.key} className="posture-item">
            <span className="posture-dot" style={{ background: cat.color }} />
            <span style={{ color: cat.color }}>{count}</span>
            <span style={{ color: "var(--text-3)" }}>{cat.label.toLowerCase()}</span>
          </span>
        );
      })}
    </div>
  );
}

// ─── Action Summary ───────────────────────────────────────────────────────

function ActionSummary({
  alertCritical,
  alertWarning,
  negativeRoi,
  rotationCandidates,
  pendingFeeChanges,
}: {
  alertCritical: number;
  alertWarning: number;
  negativeRoi: number;
  rotationCandidates: number;
  pendingFeeChanges: number;
}) {
  const items = [
    alertCritical > 0 && {
      label: `${alertCritical} critical alert${alertCritical > 1 ? "s" : ""}`,
      bg: "var(--red-glow)",
      color: "var(--red)",
    },
    alertWarning > 0 && {
      label: `${alertWarning} warning${alertWarning > 1 ? "s" : ""}`,
      bg: "var(--yellow-glow)",
      color: "var(--yellow)",
    },
    negativeRoi > 0 && {
      label: `${negativeRoi} negative ROI`,
      bg: "var(--red-glow)",
      color: "var(--red)",
    },
    rotationCandidates > 0 && {
      label: `${rotationCandidates} rotation candidate${rotationCandidates > 1 ? "s" : ""}`,
      bg: "var(--amber-glow)",
      color: "var(--amber)",
    },
    pendingFeeChanges > 0 && {
      label: `${pendingFeeChanges} fee update${pendingFeeChanges > 1 ? "s" : ""} pending`,
      bg: "var(--amber-glow)",
      color: "var(--amber)",
    },
  ].filter(Boolean) as { label: string; bg: string; color: string }[];

  if (items.length === 0) {
    return (
      <div className="action-summary">
        <span className="action-badge" style={{ background: "var(--green-glow)", color: "var(--green)" }}>
          All clear — no action needed
        </span>
      </div>
    );
  }

  return (
    <div className="action-summary">
      <span className="action-summary-label">Needs attention</span>
      {items.map((item, i) => (
        <span key={i} className="action-badge" style={{ background: item.bg, color: item.color }}>
          {item.label}
        </span>
      ))}
    </div>
  );
}

// ─── Alerts Bar ──────────────────────────────────────────────────────────

function AlertsBar({
  alerts,
  loading,
  error,
  lastFetched,
}: {
  alerts: TreasuryAlert[];
  loading: boolean;
  error: string | null;
  lastFetched: Date | null;
}) {
  const icon: Record<string, string> = { critical: "✕", warning: "⚠", info: "ℹ" };

  if (loading) {
    return (
      <div className="alerts-bar">
        <div className="loading-shimmer" style={{ height: 40 }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="alerts-bar">
        <div className="alert warning">
          <span className="alert-icon">⚠</span>
          <div className="alert-body">
            <div className="alert-msg">Could not load alerts: {error}</div>
          </div>
        </div>
      </div>
    );
  }

  const sorted = [...alerts].sort((a, b) => {
    const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
  });

  return (
    <div className="alerts-bar">
      {sorted.length === 0 ? (
        <div className="alert healthy">
          <span className="alert-icon">✓</span>
          <div className="alert-body">
            <div className="alert-msg">All systems healthy</div>
          </div>
          {lastFetched && (
            <span className="freshness-hint" style={{ marginLeft: "auto" }}>{freshness(lastFetched)}</span>
          )}
        </div>
      ) : (
        sorted.map((a) => (
          <div key={a.type} className={`alert ${a.severity}`}>
            <span className="alert-icon">{icon[a.severity] ?? "·"}</span>
            <div className="alert-body">
              <div className="alert-type">{a.type.replace(/_/g, " ")}</div>
              <div className="alert-msg">{a.message}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ─── Net Yield Panel ──────────────────────────────────────────────────────

function NetYieldPanel({
  data,
  loading,
  error,
  fetchedAt,
}: {
  data: TreasuryMetrics | null;
  loading: boolean;
  error: string | null;
  fetchedAt: Date | null;
}) {
  return (
    <Panel title="Net Yield" icon="▲" loading={loading} error={error} updatedAt={fetchedAt}>
      {data && (
        <div className="panel-body">
          <div className="stat-grid stat-grid-2" style={{ marginBottom: 16 }}>
            <div className="stat-card">
              <div className="stat-label">Net (24h)</div>
              <div className={`stat-value ${data.last_24h.net_sats >= 0 ? "positive" : "negative"}`}>
                {data.last_24h.net_sats >= 0 ? "+" : ""}{sats(data.last_24h.net_sats)}
              </div>
              <div className="stat-sub">sats</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Net (All Time)</div>
              <div className={`stat-value ${data.all_time.net_sats >= 0 ? "positive" : "negative"}`}>
                {data.all_time.net_sats >= 0 ? "+" : ""}{sats(data.all_time.net_sats)}
              </div>
              <div className="stat-sub">sats</div>
            </div>
          </div>

          <div className="divider" style={{ margin: "12px 0" }} />

          <div className="stat-grid stat-grid-2" style={{ marginBottom: 16 }}>
            <div className="stat-card">
              <div className="stat-label">Forwarded Fees (24h)</div>
              <div className="stat-value amber">{sats(data.last_24h.forwarded_fees_sats)}</div>
              <div className="stat-sub">sats</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Rebalance Costs (24h)</div>
              <div className="stat-value" style={{ color: "var(--red)" }}>
                -{sats(data.last_24h.rebalance_costs_sats)}
              </div>
              <div className="stat-sub">sats</div>
            </div>
          </div>

          <div className="divider" style={{ margin: "12px 0" }} />

          <div className="stat-grid stat-grid-2">
            <div className="stat-card">
              <div className="stat-label">Capital Deployed</div>
              <div className="stat-value">{sats(data.capital_efficiency.capital_deployed_sats)}</div>
              <div className="stat-sub">sats</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Rev / 1M Deployed</div>
              <div className="stat-value amber">
                {fmt(Math.round(data.capital_efficiency.revenue_per_1m_sats_deployed))}
              </div>
              <div className="stat-sub">sats</div>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

// ─── Channel ROI Table ─────────────────────────────────────────────────────

function ChannelRoiTable({
  channelMetrics,
  contacts,
  loading,
  error,
}: {
  channelMetrics: ChannelMetric[];
  contacts: Contact[];
  loading: boolean;
  error: string | null;
}) {
  const { sorted, toggle, arrow, key } = useSort(channelMetrics, "roi_ppm");

  const cols: Array<{ k: keyof ChannelMetric; label: string; right?: boolean }> = [
    { k: "channel_id", label: "Channel" },
    { k: "peer_pubkey", label: "Peer" },
    { k: "local_sats", label: "Local", right: true },
    { k: "forwarded_fees_sats", label: "Fwd Fees", right: true },
    { k: "rebalance_costs_sats", label: "Reb Cost", right: true },
    { k: "net_fees_sats", label: "Net Fees", right: true },
    { k: "roi_ppm", label: "ROI ppm", right: true },
    { k: "is_active", label: "Status" },
  ];

  const healthBadge = (c: ChannelMetric) =>
    c.is_active
      ? <span className="badge badge-green">active</span>
      : <span className="badge badge-muted">inactive</span>;

  return (
    <Panel title="Channel ROI" icon="◈" loading={loading} error={error} className="span-2">
      {channelMetrics.length === 0 && !loading ? (
        <div className="empty-state">No channel data yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th
                    key={String(c.k)}
                    className={key === c.k ? "sorted" : ""}
                    onClick={() => toggle(c.k)}
                    style={{ textAlign: c.right ? "right" : "left" }}
                  >
                    {c.label}{arrow(c.k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.channel_id} className={c.roi_ppm < 0 ? "negative-roi" : ""}>
                  <td className="td-mono">{truncPk(c.channel_id)}</td>
                  <td className="td-mono">{resolveContactName(c.peer_pubkey, contacts)}</td>
                  <td className="td-num">{sats(c.local_sats)}</td>
                  <td className="td-num">{sats(c.forwarded_fees_sats)}</td>
                  <td className="td-num" style={{ color: "var(--red)" }}>-{sats(c.rebalance_costs_sats)}</td>
                  <td className="td-num" style={{ color: c.net_fees_sats >= 0 ? "var(--green)" : "var(--red)" }}>
                    {c.net_fees_sats >= 0 ? "+" : ""}{sats(c.net_fees_sats)}
                  </td>
                  <td
                    className="td-num"
                    style={{ color: c.roi_ppm < 0 ? "var(--red)" : c.roi_ppm > 0 ? "var(--amber)" : "var(--text-3)" }}
                  >
                    {c.roi_ppm}
                  </td>
                  <td>{healthBadge(c)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ─── Peer Scores Panel ────────────────────────────────────────────────────

function PeerScoresPanel({ contacts }: { contacts: Contact[] }) {
  const [raw, setRaw] = useState<PeerScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { sorted, toggle, arrow, key } = useSort(raw, "peer_score");

  useEffect(() => {
    api.getPeerScores()
      .then((p) => { setRaw(p); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, []);

  const cols: Array<{ k: keyof PeerScore; label: string; right?: boolean }> = [
    { k: "peer_pubkey", label: "Peer" },
    { k: "channel_count", label: "Ch", right: true },
    { k: "total_local_sats", label: "Local", right: true },
    { k: "weighted_roi_ppm", label: "ROI ppm", right: true },
    { k: "uptime_ratio", label: "Uptime", right: true },
    { k: "peer_score", label: "Score", right: true },
  ];

  return (
    <Panel title="Peer Scores" icon="◎" loading={loading} error={error}>
      {raw.length === 0 && !loading ? (
        <div className="empty-state">No peer data yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th
                    key={String(c.k)}
                    className={key === c.k ? "sorted" : ""}
                    onClick={() => toggle(c.k)}
                    style={{ textAlign: c.right ? "right" : "left" }}
                  >
                    {c.label}{arrow(c.k)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr key={p.peer_pubkey} className={p.peer_score < 0 ? "negative-roi" : ""}>
                  <td className="td-mono">{resolveContactName(p.peer_pubkey, contacts)}</td>
                  <td className="td-num">{p.channel_count}</td>
                  <td className="td-num">{sats(p.total_local_sats)}</td>
                  <td
                    className="td-num"
                    style={{ color: p.weighted_roi_ppm < 0 ? "var(--red)" : "var(--amber)" }}
                  >
                    {p.weighted_roi_ppm}
                  </td>
                  <td className="td-num">{(p.uptime_ratio * 100).toFixed(0)}%</td>
                  <td
                    className="td-num"
                    style={{
                      color: p.peer_score < 0 ? "var(--red)" : p.peer_score > 0 ? "var(--green)" : "var(--text-3)",
                      fontWeight: 600,
                    }}
                  >
                    {p.peer_score}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ─── Rotation Candidates Panel ────────────────────────────────────────────

function RotationPanel({
  candidates,
  contacts,
  loading,
  error,
  fetchedAt,
}: {
  candidates: RotationCandidate[];
  contacts: Contact[];
  loading: boolean;
  error: string | null;
  fetchedAt: Date | null;
}) {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewResults, setPreviewResults] = useState<Record<string, Record<string, unknown>>>({});

  const previewClose = async (channelId: string) => {
    setPreviewing(channelId);
    try {
      const result = await api.previewRotation(channelId);
      setPreviewResults((r) => ({ ...r, [channelId]: result as unknown as Record<string, unknown> }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Preview failed";
      setPreviewResults((r) => ({ ...r, [channelId]: { error: msg } }));
    } finally {
      setPreviewing(null);
    }
  };

  const scoreBadge = (score: number) =>
    score >= 150
      ? <span className="badge badge-red">{score}</span>
      : <span className="badge badge-amber">{score}</span>;

  const header = candidates.length > 0 ? (
    <span className="badge badge-amber">
      {candidates.length} candidate{candidates.length > 1 ? "s" : ""}
    </span>
  ) : undefined;

  const renderPreview = (preview: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wc = (preview as any)?.would_close;
    if (preview.error) {
      return (
        <div className="preview-result" style={{ color: "var(--red)" }}>
          {String(preview.error)}
        </div>
      );
    }
    if (wc) {
      return (
        <div className="rotation-preview-structured">
          <div className="rotation-preview-title">Close channel preview</div>
          <div className="rotation-preview-grid">
            <div className="rotation-preview-field">
              <span className="rotation-preview-label">Peer</span>
              <span className="rotation-preview-value">
                {resolveContactName(wc.peer_pubkey, contacts)}
              </span>
            </div>
            <div className="rotation-preview-field">
              <span className="rotation-preview-label">Capital released</span>
              <span className="rotation-preview-value">{sats(wc.local_sats)} sats</span>
            </div>
            <div className="rotation-preview-field">
              <span className="rotation-preview-label">Channel capacity</span>
              <span className="rotation-preview-value">{sats(wc.capacity_sats)} sats</span>
            </div>
            <div className="rotation-preview-field">
              <span className="rotation-preview-label">ROI</span>
              <span
                className="rotation-preview-value"
                style={{ color: wc.roi_ppm < 0 ? "var(--red)" : "var(--amber)" }}
              >
                {wc.roi_ppm} ppm
              </span>
            </div>
            <div className="rotation-preview-field">
              <span className="rotation-preview-label">Reason</span>
              <span className="rotation-preview-value">
                {String(wc.reason).replace(/_/g, " ")}
              </span>
            </div>
            <div className="rotation-preview-field">
              <span className="rotation-preview-label">Force close</span>
              <span className="rotation-preview-value">
                {wc.is_force_close ? "Yes" : "No"}
              </span>
            </div>
          </div>
          <details style={{ marginTop: 8 }}>
            <summary className="rotation-preview-raw-toggle">Raw response</summary>
            <pre className="rotation-preview-raw">
              {JSON.stringify(preview, null, 2)}
            </pre>
          </details>
        </div>
      );
    }
    // Fallback: raw JSON for unexpected shapes
    return (
      <div className="preview-result">
        <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "0.6875rem" }}>
          {JSON.stringify(preview, null, 2)}
        </pre>
      </div>
    );
  };

  return (
    <Panel title="Rotation Candidates" icon="↻" loading={loading} error={error} action={header} updatedAt={fetchedAt}>
      {!loading && !error && (
        <>
          {candidates.length === 0 ? (
            <div className="empty-state" style={{ color: "var(--green)" }}>
              ✓ No rotation candidates
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {candidates.map((c) => (
                <div
                  key={c.channel_id}
                  style={{
                    padding: "12px 20px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div>
                      <span className="td-mono" style={{ color: "var(--text-2)" }}>
                        {truncPk(c.channel_id)}
                      </span>
                      <span
                        style={{
                          marginLeft: 8,
                          fontFamily: "var(--mono)",
                          fontSize: "0.6875rem",
                          color: "var(--text-3)",
                        }}
                      >
                        {c.reason}
                      </span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                      {scoreBadge(c.rotation_score)}
                      <button
                        className="btn btn-outline btn-sm"
                        disabled={previewing === c.channel_id}
                        onClick={() => previewClose(c.channel_id)}
                      >
                        {previewing === c.channel_id ? "…" : "Preview Close"}
                      </button>
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 16 }}>
                    {[
                      { l: "ROI", v: `${c.roi_ppm} ppm`, neg: c.roi_ppm < 0 },
                      { l: "Local", v: `${sats(c.local_sats)} sats` },
                      { l: "Peer", v: resolveContactName(c.peer_pubkey, contacts) },
                    ].map((x) => (
                      <div key={x.l} style={{ fontSize: "0.75rem" }}>
                        <span
                          style={{
                            color: "var(--text-3)",
                            fontFamily: "var(--mono)",
                            fontSize: "0.625rem",
                            textTransform: "uppercase",
                            letterSpacing: "0.06em",
                          }}
                        >
                          {x.l}{" "}
                        </span>
                        <span className="mono" style={{ color: x.neg ? "var(--red)" : "var(--text)" }}>
                          {x.v}
                        </span>
                      </div>
                    ))}
                  </div>

                  {previewResults[c.channel_id] !== undefined && renderPreview(previewResults[c.channel_id])}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

// ─── Dynamic Fees Panel ───────────────────────────────────────────────────

function DynamicFeesPanel({
  adjustments,
  feePolicy,
  contacts,
  loading,
  error,
  onRefresh,
}: {
  adjustments: ChannelFeeAdjustment[];
  feePolicy: TreasuryFeePolicy | null;
  contacts: Contact[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const [applying, setApplying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const applyFees = async () => {
    setConfirmOpen(false);
    setApplying(true);
    setApplyResult(null);
    try {
      const res = await api.applyDynamicFees();
      setApplyResult(`✓ Applied ${res.applied} update${res.applied !== 1 ? "s" : ""}`);
      onRefresh();
    } catch (e) {
      setApplyResult(`✕ ${e instanceof Error ? e.message : "Failed"}`);
    } finally {
      setApplying(false);
    }
  };

  const healthColor: Record<string, string> = {
    outbound_starved: "var(--red)",
    weak: "var(--yellow)",
    healthy: "var(--green)",
    inbound_heavy: "var(--blue)",
    critical: "var(--text-3)",
  };

  const action = (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      {applyResult && (
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: "0.75rem",
            color: applyResult.startsWith("✓") ? "var(--green)" : "var(--red)",
          }}
        >
          {applyResult}
        </span>
      )}
      {feePolicy?.last_applied_at && (
        <span style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>
          Last: {new Date(feePolicy.last_applied_at).toLocaleTimeString()}
        </span>
      )}
      <button
        className="btn btn-outline btn-sm"
        disabled={applying || loading || adjustments.length === 0}
        onClick={() => setConfirmOpen(true)}
      >
        {applying ? "Applying…" : "Apply Fees"}
      </button>
    </div>
  );

  return (
    <>
      {confirmOpen && (
        <div className="dialog-overlay">
          <div className="dialog-card">
            <div className="dialog-title">Apply Dynamic Fees?</div>
            <div className="dialog-body">
              This will push fee rate updates to LND for all {adjustments.length} active channel
              {adjustments.length !== 1 ? "s" : ""}. The update is immediate and will affect routing.
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={applyFees}>Confirm</button>
            </div>
          </div>
        </div>
      )}

      <Panel title="Dynamic Fees" icon="⟳" loading={loading} error={error} action={action} className="span-2">
        {adjustments.length === 0 && !loading && !error ? (
          <div className="empty-state">
            No active channels or base fee rate not configured.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Peer</th>
                  <th>Health</th>
                  <th style={{ textAlign: "right" }}>Imbalance</th>
                  <th style={{ textAlign: "right" }}>Current</th>
                  <th style={{ textAlign: "right" }}>Target</th>
                  <th style={{ textAlign: "right" }}>Factor</th>
                </tr>
              </thead>
              <tbody>
                {adjustments.map((a) => (
                  <tr key={a.channel_id}>
                    <td className="td-mono">{truncPk(a.channel_id)}</td>
                    <td className="td-mono">{resolveContactName(a.peer_pubkey, contacts)}</td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          background: `${healthColor[a.health_classification] ?? "var(--text-3)"}22`,
                          color: healthColor[a.health_classification] ?? "var(--text-3)",
                        }}
                      >
                        {a.health_classification.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="td-num">{(a.imbalance_ratio * 100).toFixed(1)}%</td>
                    <td className="td-num" style={{ color: "var(--text-2)" }}>
                      {a.base_fee_rate_ppm}
                    </td>
                    <td className="td-num" style={{ color: "var(--amber)", fontWeight: 600 }}>
                      {a.target_fee_rate_ppm}
                    </td>
                    <td className="td-num" style={{ color: "var(--text-3)" }}>
                      {a.adjustment_factor}×
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────

export default function Dashboard() {
  // ── Shared data (hoisted to avoid duplicate fetches) ──
  const [metrics, setMetrics] = useState<TreasuryMetrics | null>(null);
  const [alerts, setAlerts] = useState<TreasuryAlert[]>([]);
  const [channelMetrics, setChannelMetrics] = useState<ChannelMetric[]>([]);
  const [rotationCandidates, setRotationCandidates] = useState<RotationCandidate[]>([]);
  const [feeAdjustments, setFeeAdjustments] = useState<ChannelFeeAdjustment[]>([]);
  const [liquidityHealth, setLiquidityHealth] = useState<ChannelLiquidityHealth[]>([]);
  const [feePolicy, setFeePolicy] = useState<TreasuryFeePolicy | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);

  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [alertsFetchedAt, setAlertsFetchedAt] = useState<Date | null>(null);

  // ── Initial fetch (allSettled so partial failures don't block working panels) ──
  const fetchAll = useCallback(() => {
    const now = new Date();
    Promise.allSettled([
      api.getTreasuryMetrics(),
      api.getAlerts(),
      api.getChannelMetrics(),
      api.getRotationCandidates(),
      api.getDynamicFeePreview(),
      api.getLiquidityHealth(),
      api.getFeePolicy(),
      api.getContacts(),
    ]).then(([mR, aR, cmR, rcR, faR, lhR, fpR, cR]) => {
      const errs: Record<string, string> = {};
      if (mR.status === "fulfilled") setMetrics(mR.value);
      else errs.metrics = (mR.reason as Error)?.message ?? "Failed to load";
      if (aR.status === "fulfilled") { setAlerts(aR.value); setAlertsFetchedAt(now); }
      else errs.alerts = (aR.reason as Error)?.message ?? "Failed to load";
      if (cmR.status === "fulfilled") setChannelMetrics(cmR.value);
      else errs.channelMetrics = (cmR.reason as Error)?.message ?? "Failed to load";
      if (rcR.status === "fulfilled") setRotationCandidates(rcR.value);
      else errs.rotation = (rcR.reason as Error)?.message ?? "Failed to load";
      if (faR.status === "fulfilled") setFeeAdjustments(faR.value);
      else errs.fees = (faR.reason as Error)?.message ?? "Failed to load";
      if (lhR.status === "fulfilled") setLiquidityHealth(lhR.value);
      else errs.liquidity = (lhR.reason as Error)?.message ?? "Failed to load";
      if (fpR.status === "fulfilled") setFeePolicy(fpR.value);
      else errs.feePolicy = (fpR.reason as Error)?.message ?? "Failed to load";
      if (cR.status === "fulfilled") setContacts(cR.value);
      setErrors(errs);
      setLoading(false);
      setFetchedAt(now);
    });
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Alerts: 60s polling for live updates ──
  useEffect(() => {
    const id = setInterval(() => {
      api.getAlerts()
        .then((a) => { setAlerts(a); setAlertsFetchedAt(new Date()); })
        .catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  // ── Refresh callback for DynamicFeesPanel (after Apply Fees) ──
  const refreshFees = useCallback(() => {
    Promise.all([api.getDynamicFeePreview(), api.getFeePolicy()])
      .then(([adjs, fp]) => { setFeeAdjustments(adjs); setFeePolicy(fp); })
      .catch(() => {});
  }, []);

  // ── Derived values for KPI strip and action summary ──
  const pendingFeeChanges = feeAdjustments.filter(
    (a) => a.target_fee_rate_ppm !== a.base_fee_rate_ppm,
  ).length;
  const negativeRoiCount = channelMetrics.filter((c) => c.roi_ppm < 0).length;
  const criticalAlerts = alerts.filter((a) => a.severity === "critical").length;
  const warningAlerts = alerts.filter((a) => a.severity === "warning").length;

  return (
    <div>
      {/* 1. Page header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Treasury Dashboard</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Capital allocation engine · live view
        </p>
      </div>

      {/* 2. Alerts — full detail, 60s polling */}
      <AlertsBar
        alerts={alerts}
        loading={loading}
        error={errors.alerts ?? null}
        lastFetched={alertsFetchedAt}
      />

      {/* 3. KPI Strip — 5-second treasury health overview */}
      <KpiStrip
        metrics={metrics}
        atRisk={rotationCandidates.length}
        pendingFeeChanges={pendingFeeChanges}
        loading={loading}
      />

      {/* 4. Action Summary — counts only, complementary to AlertsBar detail */}
      {!loading && (
        <ActionSummary
          alertCritical={criticalAlerts}
          alertWarning={warningAlerts}
          negativeRoi={negativeRoiCount}
          rotationCandidates={rotationCandidates.length}
          pendingFeeChanges={pendingFeeChanges}
        />
      )}

      {/* 5. Liquidity Posture — channel health distribution */}
      <LiquidityPosture health={liquidityHealth} loading={loading} />

      {/* 6. Node Balances + Fund Node (secondary utility, grouped) */}
      <NodeBalancePanel />
      <FundNodePanel />

      {/* 7. Core treasury work surfaces */}
      <div className="dashboard-grid">
        <NetYieldPanel
          data={metrics}
          loading={loading}
          error={errors.metrics ?? null}
          fetchedAt={fetchedAt}
        />
        <PeerScoresPanel contacts={contacts} />
        <ChannelRoiTable
          channelMetrics={channelMetrics}
          contacts={contacts}
          loading={loading}
          error={errors.channelMetrics ?? null}
        />
        <RotationPanel
          candidates={rotationCandidates}
          contacts={contacts}
          loading={loading}
          error={errors.rotation ?? null}
          fetchedAt={fetchedAt}
        />
        <DynamicFeesPanel
          adjustments={feeAdjustments}
          feePolicy={feePolicy}
          contacts={contacts}
          loading={loading}
          error={errors.fees ?? null}
          onRefresh={refreshFees}
        />
      </div>

      {/* 8. BTC Price Graph — informational, lowest priority */}
      <div style={{ marginTop: 24 }}>
        <BitcoinPriceGraph />
      </div>
    </div>
  );
}
