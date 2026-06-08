import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { api, type AutoBuyAlert } from "../../api/client";
import { filterHistory, summarizeAlert, type HistoryFilters } from "../../autoBuy/alertView";

// §4c — Alert history surface, rendered as the third Auto-Buy tab. Lists all
// alerts from the past 30 days (GET /api/autobuy/alerts/history) across every
// status, with client-side status/severity/type filters (the volume is a
// handful/month — no server-side filtering needed, spec §4c). Active rows are
// highlighted, resolved dimmed, dismissed struck/greyed (spec §3).

const TYPE_LABELS: Record<string, string> = {
  AUTOBUY_INSUFFICIENT_FUNDS: "Insufficient funds",
  AUTOBUY_AUTH_FAILURE: "Auth failure",
  AUTOBUY_RATE_LIMITED: "Rate limited",
  AUTOBUY_ORDER_FAILED: "Order failed",
  AUTOBUY_SWEEP_FAILED: "Sweep failed",
};

function fmtTs(epochSec: number | null | undefined): string {
  if (!epochSec || !Number.isFinite(epochSec)) return "—";
  return format(new Date(epochSec * 1000), "MMM d, HH:mm");
}

export default function AlertsTab() {
  const [all, setAll] = useState<AutoBuyAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<HistoryFilters>({ status: "all", severity: "all", type: "all" });

  const load = useCallback(() => {
    setLoading(true);
    api.getAutoBuyAlertHistory()
      .then(setAll)
      .catch(() => setAll([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = filterHistory(all, filters);

  // Distinct visual treatment per status (spec §3).
  const rowStyle = (status: string): React.CSSProperties => {
    if (status === "resolved") return { opacity: 0.55 };
    if (status === "dismissed") return { opacity: 0.55, textDecoration: "line-through" };
    return {}; // active — full strength
  };

  const statusBadge = (a: AutoBuyAlert) => {
    const cls = a.status === "active"
      ? (a.severity === "critical" ? "badge-red" : "badge-amber")
      : a.status === "resolved" ? "badge-green" : "badge-muted";
    return <span className={`badge ${cls}`} style={{ fontSize: "0.625rem" }}>{a.status}</span>;
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <span className="panel-title">Alert History <span className="text-dim" style={{ fontWeight: 400 }}>· last 30 days</span></span>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select
            value={filters.status}
            onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as HistoryFilters["status"] }))}
            style={{ fontSize: "0.75rem" }}
          >
            <option value="all">All states</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
          </select>
          <select
            value={filters.severity}
            onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value as HistoryFilters["severity"] }))}
            style={{ fontSize: "0.75rem" }}
          >
            <option value="all">All severities</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <select
            value={filters.type}
            onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value }))}
            style={{ fontSize: "0.75rem" }}
          >
            <option value="all">All types</option>
            {Object.entries(TYPE_LABELS).map(([k, label]) => (
              <option key={k} value={k}>{label}</option>
            ))}
          </select>
          <button onClick={load} disabled={loading} style={{ fontSize: "0.75rem" }}>
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        {loading ? (
          <div className="loading-shimmer" style={{ height: 120, borderRadius: 6, margin: 12 }} />
        ) : rows.length === 0 ? (
          <div style={{ padding: "24px 12px", textAlign: "center", color: "var(--text-3)", fontSize: "0.8125rem" }}>
            {all.length === 0 ? "No alerts in the last 30 days." : "No alerts match the current filters."}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", fontSize: "0.8125rem", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                  <th style={{ padding: "8px 12px" }}>First seen</th>
                  <th style={{ padding: "8px 12px" }}>Type</th>
                  <th style={{ padding: "8px 12px" }}>Severity</th>
                  <th style={{ padding: "8px 12px" }}>State</th>
                  <th style={{ padding: "8px 12px", textAlign: "right" }}>×</th>
                  <th style={{ padding: "8px 12px" }}>Detail</th>
                  <th style={{ padding: "8px 12px" }}>Resolved / dismissed</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const { message } = summarizeAlert(a);
                  const closedAt = a.status === "resolved" ? a.resolved_at : a.status === "dismissed" ? a.dismissed_at : null;
                  return (
                    <tr key={a.id} style={{ borderBottom: "1px solid var(--border)", ...rowStyle(a.status) }}>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: "0.75rem" }}>{fmtTs(a.created_at)}</td>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>{TYPE_LABELS[a.type] ?? a.type}</td>
                      <td style={{ padding: "8px 12px" }}>
                        <span style={{ color: a.severity === "critical" ? "var(--red)" : "var(--amber)" }}>{a.severity}</span>
                      </td>
                      <td style={{ padding: "8px 12px" }}>{statusBadge(a)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{a.consecutive_count}</td>
                      <td style={{ padding: "8px 12px", color: "var(--text-2)", maxWidth: 360 }}>{message}</td>
                      <td style={{ padding: "8px 12px", whiteSpace: "nowrap", fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--text-3)" }}>{fmtTs(closedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
