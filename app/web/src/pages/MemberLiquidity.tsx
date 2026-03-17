import { useEffect, useState, useCallback } from "react";
import {
  api,
  type LiquidityCluster,
  type LiquidityRecommendation,
  type LiquidityEstimate,
  type LiquidityOutcome,
  resolveContactName,
  type Contact,
} from "../api/client";

// ─── Helpers ──────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toLocaleString();
}

function sats(n: number) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function bandBadge(dir: string) {
  switch (dir) {
    case "below":
      return { text: "Below Band", cls: "badge-red" };
    case "above":
      return { text: "Above Band", cls: "badge-amber" };
    case "inside":
      return { text: "In Band", cls: "badge-green" };
    default:
      return { text: dir, cls: "badge-muted" };
  }
}

function statusBadge(s: string) {
  switch (s) {
    case "pending":
      return { text: "Pending", cls: "badge-amber" };
    case "executing":
      return { text: "Executing", cls: "badge-blue" };
    case "success":
    case "complete":
      return { text: "Success", cls: "badge-green" };
    case "failure":
    case "failed":
      return { text: "Failed", cls: "badge-red" };
    case "rejected":
      return { text: "Rejected", cls: "badge-muted" };
    default:
      return { text: s, cls: "badge-muted" };
  }
}

function formatAge(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ─── Estimate Modal ──────────────────────────────────────────────────────

function EstimateModal({
  rec,
  clusterLabel,
  onClose,
  onApproved,
}: {
  rec: LiquidityRecommendation;
  clusterLabel: string;
  onClose: () => void;
  onApproved: () => void;
}) {
  const [estimate, setEstimate] = useState<LiquidityEstimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [ttlRemaining, setTtlRemaining] = useState<number | null>(null);

  useEffect(() => {
    api
      .getLiquidityEstimate(rec.recommendationId)
      .then((res) => {
        setEstimate(res.estimate);
        setLoading(false);
      })
      .catch((e: Error) => {
        setError(e.message);
        setLoading(false);
      });
  }, [rec.recommendationId]);

  // TTL countdown
  useEffect(() => {
    if (!estimate) return;
    const update = () => {
      const elapsed = (Date.now() - estimate.estimatedAt) / 1000;
      const rem = Math.max(0, estimate.estimateTtlSeconds - elapsed);
      setTtlRemaining(Math.round(rem));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [estimate]);

  async function handleApprove() {
    if (!estimate) return;
    setApproving(true);
    setError(null);
    try {
      await api.approveLiquidity(rec.recommendationId, estimate.estimateId);
      onApproved();
    } catch (e: any) {
      setError(e.message ?? "Approve failed");
      setApproving(false);
    }
  }

  async function handleReject() {
    setRejecting(true);
    setError(null);
    try {
      await api.rejectLiquidity(rec.recommendationId);
      onApproved(); // refresh parent
    } catch (e: any) {
      setError(e.message ?? "Reject failed");
      setRejecting(false);
    }
  }

  const expired = ttlRemaining !== null && ttlRemaining <= 0;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          Member Top-Up
          <span className="badge badge-blue">Treasury Push</span>
        </div>
        <div className="dialog-body">
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[100, 70, 90].map((w, i) => (
                <div key={i} className="loading-shimmer" style={{ height: 16, width: `${w}%` }} />
              ))}
            </div>
          ) : error && !estimate ? (
            <div className="alert critical" style={{ marginBottom: 0 }}>
              <span className="alert-icon">x</span>
              <div className="alert-body">
                <div className="alert-msg">{error}</div>
              </div>
            </div>
          ) : estimate ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Cluster + amount */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 12,
                }}
              >
                <div className="stat-card" style={{ margin: 0 }}>
                  <div className="stat-label">Cluster</div>
                  <div className="stat-value" style={{ fontSize: "1rem" }}>{clusterLabel}</div>
                </div>
                <div className="stat-card" style={{ margin: 0 }}>
                  <div className="stat-label">Push Amount</div>
                  <div className="stat-value" style={{ fontSize: "1rem" }}>{fmt(estimate.amountSats)}</div>
                  <div className="stat-sub">sats</div>
                </div>
              </div>

              {/* Delivery info */}
              <div
                style={{
                  background: "var(--bg-3)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: 12,
                }}
              >
                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "var(--text-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    marginBottom: 8,
                  }}
                >
                  Delivery Details
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.875rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-2)" }}>Method</span>
                    <span className="td-mono">Keysend (Lightning)</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-2)" }}>Routing fee</span>
                    <span className="td-mono">{fmt(estimate.estimatedRoutingFeeSats)} sats</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-2)" }}>Settlement</span>
                    <span className="td-mono">Instant</span>
                  </div>
                </div>
              </div>

              {/* Projected balances */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="stat-card" style={{ margin: 0 }}>
                  <div className="stat-label">Treasury Local (after)</div>
                  <div className="stat-value" style={{ fontSize: "1rem" }}>{estimate.projectedTreasuryLocalPct}%</div>
                </div>
                <div className="stat-card" style={{ margin: 0 }}>
                  <div className="stat-label">Member Local (after)</div>
                  <div className="stat-value" style={{ fontSize: "1rem" }}>{estimate.projectedMemberLocalPct}%</div>
                </div>
              </div>

              {/* TTL countdown */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  fontSize: "0.8125rem",
                  color: expired ? "var(--red)" : "var(--text-3)",
                }}
              >
                <span>Estimate TTL</span>
                <span className="td-mono" style={{ fontWeight: expired ? 600 : 400 }}>
                  {expired ? "EXPIRED" : `${ttlRemaining}s remaining`}
                </span>
              </div>

              {/* Error from approve/reject */}
              {error && (
                <div className="alert critical" style={{ marginBottom: 0 }}>
                  <span className="alert-icon">x</span>
                  <div className="alert-body">
                    <div className="alert-msg">{error}</div>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={approving || rejecting}>
            Cancel
          </button>
          <button
            className="btn btn-outline"
            onClick={handleReject}
            disabled={loading || rejecting || approving}
            style={{ color: "var(--red)", borderColor: "var(--red)" }}
          >
            {rejecting ? "Rejecting..." : "Reject"}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleApprove}
            disabled={loading || !estimate || expired || approving || rejecting}
          >
            {approving ? "Pushing..." : "Approve & Push"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────

export default function MemberLiquidity() {
  const [clusters, setClusters] = useState<LiquidityCluster[]>([]);
  const [recs, setRecs] = useState<LiquidityRecommendation[]>([]);
  const [outcomes, setOutcomes] = useState<LiquidityOutcome[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRec, setSelectedRec] = useState<LiquidityRecommendation | null>(null);

  const refresh = useCallback(() => {
    Promise.all([
      api.getLiquidityClusters(),
      api.getLiquidityRecommendations(),
      api.getLiquidityOutcomes({ limit: 20 }),
      api.getContacts(),
    ])
      .then(([c, r, o, ct]) => {
        setClusters(c.clusters);
        setRecs(r.recommendations);
        setOutcomes(o.outcomes);
        setContacts(ct);
        setLoading(false);
      })
      .catch((e: Error) => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  // Build cluster label map for lookups
  const clusterLabels = new Map<string, string>();
  for (const c of clusters) clusterLabels.set(c.clusterId, c.label);

  // Match recommendations to clusters
  const recsByCluster = new Map<string, LiquidityRecommendation[]>();
  for (const r of recs) {
    const list = recsByCluster.get(r.clusterId) ?? [];
    list.push(r);
    recsByCluster.set(r.clusterId, list);
  }

  // Separate member vs external clusters
  const memberClusters = clusters.filter(
    (c) => c.policyRole === "member_primary_outbound" || c.policyRole === "member_secondary_buffer"
  );
  const externalClusters = clusters.filter(
    (c) => c.policyRole !== "member_primary_outbound" && c.policyRole !== "member_secondary_buffer"
  );

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Member Liquidity</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Monitor member channel balance health and manage treasury push top-ups
        </p>
      </div>

      {/* ── Pending Recommendations ─────────────────────────────────── */}
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">!</span>Pending Actions
          </span>
          {recs.length > 0 && (
            <span className="badge badge-amber">{recs.length} pending</span>
          )}
        </div>
        {loading ? (
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[100, 70, 90].map((w, i) => (
              <div key={i} className="loading-shimmer" style={{ height: 16, width: `${w}%` }} />
            ))}
          </div>
        ) : error ? (
          <div className="panel-body">
            <div className="error-state">{error}</div>
          </div>
        ) : recs.length === 0 ? (
          <div className="panel-body">
            <div className="empty-state" style={{ color: "var(--green)" }}>
              No pending top-up recommendations
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {recs.map((r) => {
              const sBadge = statusBadge(r.status);
              const label = clusterLabels.get(r.clusterId) ?? r.clusterId;
              return (
                <div
                  key={r.recommendationId}
                  style={{
                    padding: "14px 20px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 200 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 600 }}>{label}</span>
                      <span className="badge badge-blue">Top-Up</span>
                      <span className={`badge ${sBadge.cls}`}>{sBadge.text}</span>
                    </div>
                    <div style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
                      {r.triggerReason} — {fmt(r.suggestedAmountSats)} sats suggested
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
                      {formatAge(r.createdAt)}
                    </div>
                  </div>
                  {r.status === "pending" && (
                    <button className="btn btn-primary btn-sm" onClick={() => setSelectedRec(r)}>
                      Review & Approve
                    </button>
                  )}
                  {r.status === "executing" && (
                    <span style={{ fontSize: "0.8125rem", color: "var(--amber)" }}>
                      Executing...
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Cluster Overview ────────────────────────────────────────── */}
      <div className="panel fade-in" style={{ marginBottom: 16 }}>
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">&#x25C8;</span>Member Clusters
          </span>
          {!loading && (
            <span className="badge badge-muted">{memberClusters.length} clusters</span>
          )}
        </div>
        {loading ? (
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[100, 70, 90].map((w, i) => (
              <div key={i} className="loading-shimmer" style={{ height: 16, width: `${w}%` }} />
            ))}
          </div>
        ) : memberClusters.length === 0 ? (
          <div className="panel-body">
            <div className="empty-state">No member clusters configured</div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cluster</th>
                  <th>Channels</th>
                  <th style={{ textAlign: "right" }}>Capacity</th>
                  <th style={{ textAlign: "right" }}>Local</th>
                  <th style={{ textAlign: "right" }}>Local %</th>
                  <th>Target Band</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {memberClusters.map((c) => {
                  const badge = bandBadge(c.deviationDirection);
                  const clusterRecs = recsByCluster.get(c.clusterId) ?? [];
                  const pendingRec = clusterRecs.find((r) => r.status === "pending");
                  const barColor =
                    c.localPct < 15 ? "var(--red)" : c.localPct < 30 ? "var(--amber)" : c.localPct > 85 ? "var(--amber)" : "var(--green)";
                  return (
                    <tr key={c.clusterId}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{c.label}</div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
                          {resolveContactName(c.peerPubkey, contacts)}
                        </div>
                      </td>
                      <td className="td-num">
                        {c.activeChannelCount}/{c.channelCount}
                      </td>
                      <td className="td-num td-mono">{sats(c.totalCapacitySats)}</td>
                      <td className="td-num td-mono">{sats(c.localBalanceSats)}</td>
                      <td className="td-num">
                        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                          <span>{c.localPct.toFixed(1)}%</span>
                          <div
                            style={{
                              width: 50,
                              height: 6,
                              borderRadius: 3,
                              background: "var(--bg-3)",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                height: "100%",
                                width: `${Math.min(100, c.localPct)}%`,
                                background: barColor,
                                borderRadius: 3,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="td-mono" style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
                        {c.targetMinPct}–{c.targetMaxPct}%
                      </td>
                      <td>
                        <span className={`badge ${badge.cls}`}>{badge.text}</span>
                      </td>
                      <td>
                        {pendingRec ? (
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => setSelectedRec(pendingRec)}
                          >
                            Review
                          </button>
                        ) : (
                          <span style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── External Clusters (collapsed view) ──────────────────────── */}
      {externalClusters.length > 0 && (
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">&#x21C4;</span>External Clusters
            </span>
            <span className="badge badge-muted">{externalClusters.length}</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cluster</th>
                  <th style={{ textAlign: "right" }}>Capacity</th>
                  <th style={{ textAlign: "right" }}>Local %</th>
                  <th>Band</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {externalClusters.map((c) => {
                  const badge = bandBadge(c.deviationDirection);
                  return (
                    <tr key={c.clusterId}>
                      <td style={{ fontWeight: 500 }}>{c.label}</td>
                      <td className="td-num td-mono">{sats(c.totalCapacitySats)}</td>
                      <td className="td-num">{c.localPct.toFixed(1)}%</td>
                      <td className="td-mono" style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
                        {c.targetMinPct}–{c.targetMaxPct}%
                      </td>
                      <td>
                        <span className={`badge ${badge.cls}`}>{badge.text}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Recent Outcomes ─────────────────────────────────────────── */}
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">&#x2193;</span>Top-Up History
          </span>
          {outcomes.length > 0 && (
            <span className="badge badge-muted">{outcomes.length} recent</span>
          )}
        </div>
        {loading ? (
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[100, 70, 90].map((w, i) => (
              <div key={i} className="loading-shimmer" style={{ height: 16, width: `${w}%` }} />
            ))}
          </div>
        ) : outcomes.length === 0 ? (
          <div className="panel-body">
            <div className="empty-state">No top-up outcomes yet</div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cluster</th>
                  <th>Method</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th style={{ textAlign: "right" }}>Fee</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.map((o) => {
                  const sBadge = statusBadge(o.status);
                  return (
                    <tr key={o.outcomeId}>
                      <td style={{ fontWeight: 500 }}>
                        {clusterLabels.get(o.clusterId) ?? o.clusterId}
                      </td>
                      <td>
                        <span className="badge badge-blue">
                          {o.executionMethod === "keysend" ? "Keysend" : o.executionMethod ?? "—"}
                        </span>
                      </td>
                      <td className="td-num td-mono">
                        {o.actualAmountSats != null ? fmt(o.actualAmountSats) : "—"}
                      </td>
                      <td className="td-num td-mono">
                        {o.actualFeeSats != null ? fmt(o.actualFeeSats) : "—"}
                      </td>
                      <td>
                        <span className={`badge ${sBadge.cls}`}>{sBadge.text}</span>
                      </td>
                      <td style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
                        {formatAge(o.executedAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Member Channel Health (treasury observability) ─────────── */}
      {memberClusters.length > 0 && (
        <div className="panel fade-in" style={{ marginBottom: 16 }}>
          <div className="panel-header">
            <span className="panel-title">
              <span className="icon">&#x2665;</span>Member Channel Health
            </span>
            <span className="badge badge-muted">read-only</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th style={{ textAlign: "right" }}>Member Local</th>
                  <th style={{ textAlign: "right" }}>Member %</th>
                  <th>State</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                {memberClusters.map((c) => {
                  // From treasury perspective: member-local = cluster's remote
                  const memberLocalPct = c.totalCapacitySats > 0
                    ? Math.round(((c.remoteBalanceSats) / c.totalCapacitySats) * 100)
                    : 0;
                  const memberState =
                    memberLocalPct >= 85 ? "send_saturated" :
                    memberLocalPct >= 70 ? "send_heavy" :
                    memberLocalPct <= 15 ? "receive_exhausted" :
                    memberLocalPct <= 30 ? "receive_heavy" :
                    "healthy";
                  const stateLabel =
                    memberState === "healthy" ? "Healthy" :
                    memberState.replace(/_/g, " ");
                  const stateCls =
                    memberState === "healthy" ? "badge-green" :
                    memberState === "send_saturated" || memberState === "receive_exhausted" ? "badge-red" :
                    "badge-amber";
                  const barColor =
                    memberLocalPct <= 15 ? "var(--red)" :
                    memberLocalPct <= 30 ? "var(--amber)" :
                    memberLocalPct >= 85 ? "var(--amber)" :
                    "var(--green)";

                  // Build trend hint from cluster recs
                  const clusterRecs = recsByCluster.get(c.clusterId) ?? [];
                  const hasPending = clusterRecs.some((r) => r.status === "pending" || r.status === "executing");

                  return (
                    <tr key={c.clusterId}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{c.label}</div>
                        <div style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
                          {resolveContactName(c.peerPubkey, contacts)}
                        </div>
                      </td>
                      <td className="td-num td-mono">{sats(c.remoteBalanceSats)}</td>
                      <td className="td-num">
                        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                          <span>{memberLocalPct}%</span>
                          <div
                            style={{
                              width: 50,
                              height: 6,
                              borderRadius: 3,
                              background: "var(--bg-3)",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                height: "100%",
                                width: `${Math.min(100, memberLocalPct)}%`,
                                background: barColor,
                                borderRadius: 3,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${stateCls}`}>{stateLabel}</span>
                      </td>
                      <td style={{ fontSize: "0.8125rem", color: "var(--text-3)" }}>
                        {hasPending ? (
                          <span style={{ color: "var(--amber)" }}>Top-up pending</span>
                        ) : memberState === "healthy" ? (
                          "—"
                        ) : memberState === "receive_exhausted" || memberState === "receive_heavy" ? (
                          <span>Suggest Loop In</span>
                        ) : (
                          <span>Suggest Loop Out</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Estimate/Approval Modal ──────────────────────────────────── */}
      {selectedRec && (
        <EstimateModal
          rec={selectedRec}
          clusterLabel={clusterLabels.get(selectedRec.clusterId) ?? selectedRec.clusterId}
          onClose={() => setSelectedRec(null)}
          onApproved={() => {
            setSelectedRec(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
