import { useEffect, useState, useCallback } from "react";
import {
  api,
  type SwapCluster,
  type SwapRecommendation,
  type SwapQuote,
  type SwapOutcome,
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

function swapTypeBadge(t: string) {
  switch (t) {
    case "top_up":
      return { text: "Top Up", cls: "badge-blue" };
    case "cash_out":
      return { text: "Cash Out", cls: "badge-amber" };
    default:
      return { text: t, cls: "badge-muted" };
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
    case "pending_onchain":
      return { text: "Pending On-Chain", cls: "badge-amber" };
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

// ─── Quote Modal ──────────────────────────────────────────────────────────

function QuoteModal({
  rec,
  clusterLabel,
  onClose,
  onApproved,
}: {
  rec: SwapRecommendation;
  clusterLabel: string;
  onClose: () => void;
  onApproved: () => void;
}) {
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [ttlRemaining, setTtlRemaining] = useState<number | null>(null);

  useEffect(() => {
    api
      .getSwapQuote(rec.recommendationId)
      .then((res) => {
        setQuote(res.quote);
        setLoading(false);
      })
      .catch((e: Error) => {
        setError(e.message);
        setLoading(false);
      });
  }, [rec.recommendationId]);

  // TTL countdown
  useEffect(() => {
    if (!quote) return;
    const update = () => {
      const elapsed = (Date.now() - quote.quotedAt) / 1000;
      const rem = Math.max(0, quote.quoteTtlSeconds - elapsed);
      setTtlRemaining(Math.round(rem));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [quote]);

  async function handleApprove() {
    if (!quote) return;
    setApproving(true);
    setError(null);
    try {
      await api.approveSwap(rec.recommendationId, quote.quoteId);
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
      await api.rejectSwap(rec.recommendationId);
      onApproved(); // refresh parent
    } catch (e: any) {
      setError(e.message ?? "Reject failed");
      setRejecting(false);
    }
  }

  const expired = ttlRemaining !== null && ttlRemaining <= 0;
  const stBadge = swapTypeBadge(rec.swapType);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          Swap Confirmation
          <span className={`badge ${stBadge.cls}`}>{stBadge.text}</span>
        </div>
        <div className="dialog-body">
          {loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[100, 70, 90].map((w, i) => (
                <div key={i} className="loading-shimmer" style={{ height: 16, width: `${w}%` }} />
              ))}
            </div>
          ) : error && !quote ? (
            <div className="alert critical" style={{ marginBottom: 0 }}>
              <span className="alert-icon">x</span>
              <div className="alert-body">
                <div className="alert-msg">{error}</div>
              </div>
            </div>
          ) : quote ? (
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
                  <div className="stat-label">Swap Amount</div>
                  <div className="stat-value" style={{ fontSize: "1rem" }}>{fmt(quote.amountSats)}</div>
                  <div className="stat-sub">sats</div>
                </div>
              </div>

              {/* Fee breakdown */}
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
                  Fee Breakdown
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.875rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-2)" }}>Swap fee</span>
                    <span className="td-mono">{fmt(quote.estimatedSwapFeeSats)} sats</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "var(--text-2)" }}>Miner fee</span>
                    <span className="td-mono">{fmt(quote.estimatedMinerFeeSats)} sats</span>
                  </div>
                  {quote.estimatedPrepayFeeSats != null && (
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--text-2)" }}>Prepay</span>
                      <span className="td-mono">{fmt(quote.estimatedPrepayFeeSats)} sats</span>
                    </div>
                  )}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      borderTop: "1px solid var(--border)",
                      paddingTop: 4,
                      fontWeight: 600,
                    }}
                  >
                    <span>Total fee</span>
                    <span className="td-mono">
                      {fmt(quote.totalEstimatedFeeSats)} sats ({(quote.feeAsPct * 100).toFixed(2)}%)
                    </span>
                  </div>
                </div>
              </div>

              {/* Projected balances */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="stat-card" style={{ margin: 0 }}>
                  <div className="stat-label">Projected Local</div>
                  <div className="stat-value" style={{ fontSize: "1rem" }}>{quote.projectedLocalPct}%</div>
                </div>
                <div className="stat-card" style={{ margin: 0 }}>
                  <div className="stat-label">Projected Remote</div>
                  <div className="stat-value" style={{ fontSize: "1rem" }}>{quote.projectedRemotePct}%</div>
                </div>
              </div>

              {/* Fee tolerance warning */}
              {!quote.withinFeeTolerance && (
                <div className="alert warning" style={{ marginBottom: 0 }}>
                  <span className="alert-icon">!</span>
                  <div className="alert-body">
                    <div className="alert-type">Fee Exceeds Tolerance</div>
                    <div className="alert-msg">
                      Total fee ({(quote.feeAsPct * 100).toFixed(2)}%) exceeds the configured
                      max fee tolerance for this cluster.
                    </div>
                  </div>
                </div>
              )}

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
                <span>Quote TTL</span>
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
            disabled={loading || !quote || expired || approving || rejecting}
          >
            {approving ? "Executing..." : "Approve & Execute"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────

export default function MemberLiquidity() {
  const [clusters, setClusters] = useState<SwapCluster[]>([]);
  const [recs, setRecs] = useState<SwapRecommendation[]>([]);
  const [outcomes, setOutcomes] = useState<SwapOutcome[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRec, setSelectedRec] = useState<SwapRecommendation | null>(null);

  const refresh = useCallback(() => {
    Promise.all([
      api.getSwapClusters(),
      api.getSwapRecommendations(),
      api.getSwapOutcomes({ limit: 20 }),
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
  const recsByCluster = new Map<string, SwapRecommendation[]>();
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
          Monitor member channel balance health and manage liquidity swaps
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
              No pending swap recommendations
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {recs.map((r) => {
              const stBadge = swapTypeBadge(r.swapType);
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
                      <span className={`badge ${stBadge.cls}`}>{stBadge.text}</span>
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
            <span className="icon">&#x2193;</span>Swap History
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
            <div className="empty-state">No swap outcomes yet</div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cluster</th>
                  <th>Type</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                  <th style={{ textAlign: "right" }}>Fee</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {outcomes.map((o) => {
                  const stBadge = swapTypeBadge(o.swapType);
                  const sBadge = statusBadge(o.status);
                  return (
                    <tr key={o.outcomeId}>
                      <td style={{ fontWeight: 500 }}>
                        {clusterLabels.get(o.clusterId) ?? o.clusterId}
                      </td>
                      <td>
                        <span className={`badge ${stBadge.cls}`}>{stBadge.text}</span>
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

      {/* ── Quote/Approval Modal ────────────────────────────────────── */}
      {selectedRec && (
        <QuoteModal
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
