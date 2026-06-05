// app/web/src/components/autoBuy/HistoryTable.tsx
import { useCallback, useEffect, useState } from "react";
import { api, type AutoBuyRun } from "../../api/client";

const PAGE_SIZE = 25;

// Mirrors WITHDRAW_HOLD_SECONDS in app/api/src/autoBuy/scheduler.ts (the 72h
// post-fill hold before BTC is eligible to sweep). The API doesn't expose the
// constant, so the frontend mirrors it for display purposes only — if the
// backend hold ever changes, update this too.
const WITHDRAW_HOLD_SECONDS = 72 * 3600;

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// First UTC calendar day with getUTCDay() === sweepDow on/after `fromSec`.
// The sweep step (stepRunSweep) is gated to that UTC day-of-week, so this is
// the earliest day the withdrawal can be placed. Same-day sweep is possible
// when the hold elapses on the sweep day itself — hence the "~" estimate in
// the rendered text.
function nextSweepDateUtc(fromSec: number, sweepDow: number): Date {
  const d = new Date(fromSec * 1000);
  const candidate = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  while (candidate.getUTCDay() !== sweepDow) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return candidate;
}

function fmtUtcDay(d: Date): string {
  return `${DOW_LABELS[d.getUTCDay()]} ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
}

function fmtLocalDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

interface Props {
  // autobuy_config.sweep_day_of_week (0=Sunday, UTC) — passed from StrategyTab's
  // status payload. Optional: when absent, the delivery line omits the sweep date.
  sweepDayOfWeek?: number;
}

export default function HistoryTable({ sweepDayOfWeek }: Props) {
  const [rows, setRows] = useState<AutoBuyRun[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");

  const load = useCallback(() => {
    setLoading(true);
    api.getAutoBuyHistory({ limit: PAGE_SIZE, offset, status: statusFilter || undefined })
      .then((r) => { setRows(r.rows); setTotal(r.total); })
      .catch(() => { setRows([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [offset, statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Expected-delivery context for in-flight post-buy states. Answers "when
  // does the BTC actually reach my node?" without the admin needing to know
  // the hold + weekly-sweep mechanics. Returns null for all other statuses.
  const deliveryLine = (r: AutoBuyRun): { text: string; full: string } | null => {
    if (r.status === "awaiting_withdraw_hold") {
      if (r.filled_at == null) return null;
      const holdEnd = r.filled_at + WITHDRAW_HOLD_SECONDS;
      const holdStr = fmtLocalDate(holdEnd);
      if (sweepDayOfWeek == null) {
        return {
          text: `hold ends ${holdStr}`,
          full: `Coinbase 72-hour hold ends ${new Date(holdEnd * 1000).toLocaleString()}.`,
        };
      }
      const sweep = nextSweepDateUtc(holdEnd, sweepDayOfWeek);
      return {
        text: `hold ends ${holdStr} · → node ~${fmtUtcDay(sweep)} (UTC)`,
        full: `Coinbase 72-hour hold ends ${new Date(holdEnd * 1000).toLocaleString()}; BTC sweeps to your node on the next configured sweep day (${DOW_LABELS[sweepDayOfWeek]}, UTC) — est. ${fmtUtcDay(sweep)}.`,
      };
    }
    if (r.status === "sweep_assigned") {
      if (sweepDayOfWeek == null) return null;
      const sweep = nextSweepDateUtc(Math.floor(Date.now() / 1000), sweepDayOfWeek);
      return {
        text: `→ node ~${fmtUtcDay(sweep)} (UTC)`,
        full: `Hold elapsed; BTC sweeps to your node on the next configured sweep day (${DOW_LABELS[sweepDayOfWeek]}, UTC) — est. ${fmtUtcDay(sweep)}.`,
      };
    }
    return null;
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Upcoming & Recent Purchases</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            value={statusFilter}
            onChange={(e) => { setOffset(0); setStatusFilter(e.target.value); }}
            style={{ fontSize: "0.75rem" }}
          >
            <option value="">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="buy_placed">Buy placed</option>
            <option value="buy_filled">Filled</option>
            <option value="awaiting_withdraw_hold">Awaiting hold</option>
            <option value="sweep_assigned">Sweep assigned</option>
            <option value="withdraw_placed">Withdraw placed</option>
            <option value="withdraw_confirmed">Withdrawn</option>
            <option value="skipped_stale_data">Skipped (stale)</option>
            <option value="skipped_zero_multiplier">Skipped (zero)</option>
            <option value="skipped_cap_hit">Skipped (cap)</option>
            <option value="skipped_insufficient_funds">Skipped (funds)</option>
            <option value="failed_buy">Failed (buy)</option>
            <option value="failed_withdraw">Failed (withdraw)</option>
          </select>
          <button onClick={load} disabled={loading} style={{ fontSize: "0.75rem" }}>
            {loading ? "…" : "Refresh"}
          </button>
        </div>
      </div>
      <div className="panel-body" style={{ padding: 0 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: "0.8125rem", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                <th style={{ padding: "8px 12px" }}>When</th>
                <th style={{ padding: "8px 12px" }}>Status</th>
                <th style={{ padding: "8px 12px" }}>Zone</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Z-Score</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>×</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Intended USD</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Filled BTC</th>
                <th style={{ padding: "8px 12px", textAlign: "right" }}>Filled USD</th>
                <th style={{ padding: "8px 12px" }}>Currency</th>
                <th style={{ padding: "8px 12px" }}>Reason</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 ? (
                <tr><td colSpan={10} style={{ padding: 16 }}><em className="text-dim">Loading…</em></td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={10} style={{ padding: 16 }}><em className="text-dim">No runs yet.</em></td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>{formatTs(r.scheduled_for)}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <StatusBadge status={r.status} />
                    {(() => {
                      const ctx = deliveryLine(r);
                      return ctx ? (
                        <div className="text-dim" style={{ fontSize: "0.6875rem", marginTop: 2, whiteSpace: "nowrap" }} title={ctx.full}>
                          {ctx.text}
                        </div>
                      ) : null;
                    })()}
                  </td>
                  <td style={{ padding: "8px 12px" }}>{r.zone ?? "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{r.z_score != null ? r.z_score.toFixed(2) : "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }}>{r.multiplier != null ? `${r.multiplier}×` : "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{r.intended_buy_usd != null ? `$${r.intended_buy_usd.toFixed(2)}` : "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{r.filled_btc != null ? r.filled_btc.toFixed(8) : "—"}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--mono)" }}>{r.filled_usd != null ? `$${r.filled_usd.toFixed(2)}` : "—"}</td>
                  <td style={{ padding: "8px 12px" }}>{r.currency_used || (r.currencies_checked ? r.currencies_checked : "—")}</td>
                  <td style={{ padding: "8px 12px", fontSize: "0.75rem", color: "var(--text-dim)" }}>
                    {r.error_code ?? r.error_message ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div style={{ padding: "8px 12px", fontSize: "0.75rem", color: "var(--text-dim)", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border)" }}>
        <span>
          {total > 0 ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}` : "—"}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0} style={{ fontSize: "0.75rem" }}>‹ Prev</button>
          <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total} style={{ fontSize: "0.75rem" }}>Next ›</button>
        </div>
      </div>
    </div>
  );
}

function formatTs(sec: number | null | undefined): string {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: string }) {
  const STYLES: Record<string, { label: string; cls: string }> = {
    scheduled:               { label: "NEXT",              cls: "badge-blue" },
    buy_placed:              { label: "PLACED",            cls: "badge-blue" },
    buy_filled:              { label: "FILLED",            cls: "badge-green" },
    awaiting_withdraw_hold:  { label: "AWAITING-WITHDRAW", cls: "badge-amber" },
    sweep_assigned:          { label: "SWEEP",             cls: "badge-amber" },
    withdraw_placed:         { label: "WITHDRAWING",       cls: "badge-amber" },
    withdraw_confirmed:      { label: "WITHDRAWN",         cls: "badge-green" },
    skipped_stale_data:      { label: "SKIPPED",           cls: "badge-muted" },
    skipped_zero_multiplier: { label: "SKIPPED",           cls: "badge-muted" },
    skipped_cap_hit:         { label: "CAP HIT",           cls: "badge-muted" },
    skipped_insufficient_funds:{ label: "LOW FUNDS",       cls: "badge-muted" },
    failed_buy:              { label: "FAILED",            cls: "badge-red" },
    failed_withdraw:         { label: "FAILED",            cls: "badge-red" },
  };
  const s = STYLES[status] ?? { label: status, cls: "badge-muted" };
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}
