// SubscriptionPayments — member-facing payment history page.
//
// Source: Stage 5a follow-up. The SubscriptionPanel renders a
// "View payment history →" tertiary link in current/worker_lapsed/
// routing_lapsed/close_due states; this page is the destination.
//
// Authentication parity with the panel: hits /api/subscription/payments
// on the member-local API, which proxies to the treasury (same Bearer
// resolution + 401/503 discrimination as /status; see paymentsHandler.ts).
//
// Error-state parity with the panel: maps 401 → loading, 503 +
// no_local_token/no_treasury_key → infrastructure error, 503 +
// treasury_unreachable → transport-unreachable (added in PR #177).
//
// Sort: rows arrive pre-sorted by received_at DESC from the treasury
// (paymentsHandler.ts header). The grandfather admin_override sentinel
// surfaces at the bottom (oldest received_at) — exactly where the
// member's mental model expects "how my membership started" to live.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  fmtSats,
  type SubscriptionPaymentRow,
  type SubscriptionPaymentStatus,
} from "../api/client";

type ViewState =
  | { kind: "loading" }
  | { kind: "ok"; payments: SubscriptionPaymentRow[] }
  | { kind: "auth_error" }
  | { kind: "infrastructure_error"; detail?: string }
  | { kind: "transport_unreachable"; detail?: string }
  | { kind: "network_error"; detail?: string };

export default function SubscriptionPayments() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [refreshingSinceMs, setRefreshingSinceMs] = useState<number | null>(null);

  const fetchPayments = useCallback(async () => {
    setRefreshingSinceMs(Date.now());
    try {
      const res = await api.getSubscriptionPayments();
      setView({ kind: "ok", payments: res.payments });
    } catch (err: any) {
      const statusCode: number | undefined = err?.status;
      const detail: string | undefined = err?.detail ?? err?.message;
      const code: string | undefined = err?.code;
      if (statusCode === 401) {
        setView({ kind: "auth_error" });
      } else if (statusCode === 503 && code === "treasury_unreachable") {
        setView({ kind: "transport_unreachable", detail });
      } else if (statusCode === 503) {
        setView({ kind: "infrastructure_error", detail });
      } else {
        setView({ kind: "network_error", detail });
      }
    } finally {
      setRefreshingSinceMs(null);
    }
  }, []);

  useEffect(() => {
    void fetchPayments();
  }, [fetchPayments]);

  return (
    <div className="sub-history-page">
      <header className="sub-history-header">
        <Link to="/settings" className="sub-link">
          <span aria-hidden>←</span> Back to settings
        </Link>
        <h1>Subscription Payment History</h1>
        <button
          className="sub-btn"
          onClick={() => void fetchPayments()}
          disabled={refreshingSinceMs !== null}
        >
          {refreshingSinceMs !== null ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      <SubscriptionPaymentsBody view={view} onRetry={fetchPayments} />
    </div>
  );
}

function SubscriptionPaymentsBody({
  view,
  onRetry,
}: {
  view: ViewState;
  onRetry: () => void;
}) {
  if (view.kind === "loading" || view.kind === "auth_error") {
    // 401 is a transient state (token re-issuance via the refresh
    // scheduler) — render the skeleton, same affordance as the panel.
    return <PaymentsSkeleton />;
  }
  if (view.kind === "infrastructure_error") {
    return (
      <ErrorState
        message="Couldn't load payment history — infrastructure not ready."
        detail={view.detail}
        onRetry={onRetry}
      />
    );
  }
  if (view.kind === "transport_unreachable") {
    return (
      <ErrorState
        message="Couldn't reach the treasury. Retrying will retry the connection."
        detail={view.detail}
        onRetry={onRetry}
      />
    );
  }
  if (view.kind === "network_error") {
    return (
      <ErrorState
        message="Couldn't load payment history."
        detail={view.detail}
        onRetry={onRetry}
      />
    );
  }

  // view.kind === "ok"
  if (view.payments.length === 0) {
    return (
      <section className="sub-panel">
        <p className="sub-body-copy">
          No payments yet. Your first payment will appear here once it lands at your
          deposit address and is confirmed on-chain.
        </p>
      </section>
    );
  }

  return <PaymentsTable payments={view.payments} />;
}

function PaymentsTable({ payments }: { payments: SubscriptionPaymentRow[] }) {
  return (
    <section className="sub-panel">
      <table className="sub-history-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Amount</th>
            <th>Transaction</th>
            <th>Period extension</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => (
            <PaymentRow key={p.id} payment={p} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PaymentRow({ payment }: { payment: SubscriptionPaymentRow }) {
  const dateMs = payment.confirmed_at ?? payment.received_at;
  return (
    <tr>
      <td>{formatDateTime(dateMs)}</td>
      <td>
        <AmountCell payment={payment} />
      </td>
      <td>
        <TxidCell payment={payment} />
      </td>
      <td>
        {payment.period_extension_days > 0
          ? `+${payment.period_extension_days}d`
          : <span className="sub-muted">—</span>}
      </td>
      <td>
        <StatusPill status={payment.status} />
      </td>
    </tr>
  );
}

function AmountCell({ payment }: { payment: SubscriptionPaymentRow }) {
  // Grandfather sentinel: amount_sats=0. Render the sentinel marker
  // ("grandfather") rather than a literal "0 sats" which reads as a
  // failure case to a member who doesn't know this row's job.
  if (payment.kind === "admin_override" && payment.amount_sats === 0) {
    return <span className="sub-muted">grandfather</span>;
  }
  const usd = payment.amount_usd_cents_at_receipt;
  return (
    <span>
      {fmtSats(payment.amount_sats)}
      {usd !== null && usd > 0 && (
        <span className="sub-muted"> · ${(usd / 100).toFixed(2)}</span>
      )}
    </span>
  );
}

function TxidCell({ payment }: { payment: SubscriptionPaymentRow }) {
  if (payment.kind === "admin_override") {
    return <span className="sub-muted">{payment.admin_reason ?? "manual override"}</span>;
  }
  if (!payment.txid) return <span className="sub-muted">—</span>;
  const short = `${payment.txid.slice(0, 8)}…${payment.txid.slice(-6)}`;
  return (
    <code className="sub-pubkey" title={payment.txid}>
      {short}
    </code>
  );
}

function StatusPill({ status }: { status: SubscriptionPaymentStatus }) {
  if (status === "confirmed") {
    return (
      <span className="sub-pill sub-pill-emerald">
        <span className="sub-pill-dot" aria-hidden />
        confirmed
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="sub-pill sub-pill-gray-pulsing">
        <span className="sub-pill-dot" aria-hidden />
        pending
      </span>
    );
  }
  // admin_override
  return (
    <span className="sub-pill sub-pill-muted-amber">
      <span className="sub-pill-dot" aria-hidden />
      manual
    </span>
  );
}

function PaymentsSkeleton() {
  return (
    <section className="sub-panel sub-panel-skeleton">
      <div className="sub-skeleton-line" style={{ width: "40%" }} />
      <div className="sub-skeleton-line" style={{ width: "70%" }} />
      <div className="sub-skeleton-line" style={{ width: "55%" }} />
    </section>
  );
}

function ErrorState({
  message,
  detail,
  onRetry,
}: {
  message: string;
  detail?: string;
  onRetry: () => void;
}) {
  return (
    <section className="sub-panel">
      <div className="sub-alert sub-alert-dim-red">
        <span className="sub-alert-icon" aria-hidden>✕</span>
        <div className="sub-alert-body">
          {message}
          {detail && <span className="sub-error-detail"> ({detail})</span>}
        </div>
      </div>
      <div className="sub-actions">
        <button className="sub-btn" onClick={onRetry}>
          Try again <span aria-hidden>→</span>
        </button>
      </div>
    </section>
  );
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
