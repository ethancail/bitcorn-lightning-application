import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import type { AutoBuyAlert } from "../../api/client";
import { orderActiveAlerts, summarizeAlert } from "../../autoBuy/alertView";

interface Props {
  alerts: AutoBuyAlert[];
  onDismiss: (id: number) => Promise<void> | void;
}

// Persistent banner region at the top of the Auto-Buy page (spec §4b),
// modelled on ValuationInputAlertBanner. Stacks one .alert block per active
// alert (critical-before-warning, newest first via orderActiveAlerts), each
// with a severity icon, summary copy, scenario context, and a Dismiss button.
// Reuses the app's .alert.critical / .alert.warning classes so the colour
// treatment matches the rest of the UI exactly — no new colours.
export default function AutoBuyAlertBanner({ alerts, onDismiss }: Props) {
  const [dismissingId, setDismissingId] = useState<number | null>(null);
  const active = orderActiveAlerts(alerts.filter((a) => a.status === "active"));
  if (active.length === 0) return null;

  async function handleDismiss(id: number) {
    setDismissingId(id);
    try {
      await onDismiss(id);
    } finally {
      setDismissingId(null);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
      {active.map((a) => {
        const { title, message, icon } = summarizeAlert(a);
        const when = Number.isFinite(a.updated_at)
          ? formatDistanceToNow(new Date(a.updated_at * 1000), { addSuffix: true })
          : null;
        return (
          <div
            key={a.id}
            className={`alert ${a.severity === "critical" ? "critical" : "warning"}`}
            style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 0 }}
          >
            <span className="alert-icon">{icon}</span>
            <div className="alert-body" style={{ flex: 1 }}>
              <div className="alert-type">{title}</div>
              <div className="alert-msg">{message}</div>
              <div
                style={{
                  marginTop: 4,
                  fontSize: "0.6875rem",
                  fontFamily: "var(--mono)",
                  color: "var(--text-3)",
                  display: "flex",
                  gap: 10,
                  flexWrap: "wrap",
                }}
              >
                {a.consecutive_count > 1 && <span>recurred ×{a.consecutive_count}</span>}
                {when && <span>last seen {when}</span>}
              </div>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => handleDismiss(a.id)}
              disabled={dismissingId === a.id}
              style={{ whiteSpace: "nowrap", color: "var(--text-3)" }}
            >
              {dismissingId === a.id ? "Dismissing…" : "Dismiss"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
