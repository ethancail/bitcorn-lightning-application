import { useState, useEffect, useCallback } from "react";
import {
  api,
  type TreasuryAlert,
  type TreasuryMetrics,
  type ChannelMetric,
  type PeerScore,
  type RotationCandidate,
  type ChannelFeeAdjustment,
  type TreasuryFeePolicy,
} from "../api/client";

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
}: {
  title: string;
  icon: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  loading?: boolean;
  error?: string | null;
}) {
  return (
    <div className={`panel fade-in ${className ?? ""}`}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">{icon}</span>
          {title}
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

// ─── Alerts Bar ──────────────────────────────────────────────────────────

function AlertsBar() {
  const [alerts, setAlerts] = useState<TreasuryAlert[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getAlerts()
      .then((a) => { setAlerts(a); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

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

  const sorted = [...(alerts ?? [])].sort((a, b) => {
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

function NetYieldPanel() {
  const [data, setData] = useState<TreasuryMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getTreasuryMetrics()
      .then((m) => { setData(m); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, []);

  return (
    <Panel title="Net Yield" icon="▲" loading={loading} error={error}>
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

function ChannelRoiTable() {
  const [raw, setRaw] = useState<ChannelMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { sorted, toggle, arrow, key } = useSort(raw, "roi_ppm");

  useEffect(() => {
    api.getChannelMetrics()
      .then((m) => { setRaw(m); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, []);

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
      {raw.length === 0 && !loading ? (
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
                  <td className="td-mono">{truncPk(c.peer_pubkey)}</td>
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

function PeerScoresPanel() {
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
                  <td className="td-mono">{truncPk(p.peer_pubkey)}</td>
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

function RotationPanel() {
  const [candidates, setCandidates] = useState<RotationCandidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewResults, setPreviewResults] = useState<Record<string, unknown>>({});

  useEffect(() => {
    api.getRotationCandidates()
      .then((c) => { setCandidates(c); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, []);

  const previewClose = async (channelId: string) => {
    setPreviewing(channelId);
    try {
      const result = await api.previewRotation(channelId);
      setPreviewResults((r) => ({ ...r, [channelId]: result }));
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

  const header = candidates && candidates.length > 0 ? (
    <span className="badge badge-amber">
      {candidates.length} candidate{candidates.length > 1 ? "s" : ""}
    </span>
  ) : undefined;

  return (
    <Panel title="Rotation Candidates" icon="↻" loading={loading} error={error} action={header}>
      {!loading && !error && (
        <>
          {candidates?.length === 0 ? (
            <div className="empty-state" style={{ color: "var(--green)" }}>
              ✓ No rotation candidates
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {candidates?.map((c) => (
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
                      { l: "Peer", v: truncPk(c.peer_pubkey) },
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

                  {previewResults[c.channel_id] !== undefined && (
                    <div className="preview-result">
                      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "0.6875rem" }}>
                        {JSON.stringify(previewResults[c.channel_id], null, 2)}
                      </pre>
                    </div>
                  )}
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

function DynamicFeesPanel() {
  const [adjustments, setAdjustments] = useState<ChannelFeeAdjustment[]>([]);
  const [policy, setPolicy] = useState<TreasuryFeePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([api.getDynamicFeePreview(), api.getFeePolicy()])
      .then(([adjs, fp]) => {
        setAdjustments(adjs);
        setPolicy(fp);
        setLoading(false);
      })
      .catch((e: Error) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  useEffect(() => { load(); }, [load]);

  const applyFees = async () => {
    setConfirmOpen(false);
    setApplying(true);
    setApplyResult(null);
    try {
      const res = await api.applyDynamicFees();
      setApplyResult(`✓ Applied ${res.applied} update${res.applied !== 1 ? "s" : ""}`);
      load();
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
      {policy?.last_applied_at && (
        <span style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>
          Last: {new Date(policy.last_applied_at).toLocaleTimeString()}
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
                    <td className="td-mono">{truncPk(a.peer_pubkey)}</td>
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
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Treasury Dashboard</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Capital allocation engine · live view
        </p>
      </div>

      <AlertsBar />

      <div className="dashboard-grid">
        <NetYieldPanel />
        <PeerScoresPanel />
        <ChannelRoiTable />
        <RotationPanel />
        <DynamicFeesPanel />
      </div>
    </div>
  );
}
