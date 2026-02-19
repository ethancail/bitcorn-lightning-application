import { useEffect, useState } from "react";
import { fetchAlerts, TreasuryAlert } from "../api/client";

const SEVERITY_ORDER: Record<TreasuryAlert["severity"], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const SEVERITY_STYLES: Record<
  TreasuryAlert["severity"],
  { background: string; borderLeft: string; color: string }
> = {
  critical: {
    background: "#fef2f2",
    borderLeft: "4px solid #dc2626",
    color: "#dc2626",
  },
  warning: {
    background: "#fffbeb",
    borderLeft: "4px solid #d97706",
    color: "#d97706",
  },
  info: {
    background: "#f9fafb",
    borderLeft: "4px solid #9ca3af",
    color: "#9ca3af",
  },
};

export default function AlertsBar() {
  const [alerts, setAlerts] = useState<TreasuryAlert[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchAlerts();
        if (!cancelled) {
          setAlerts(data);
          setError(false);
        }
      } catch {
        if (!cancelled) {
          setError(true);
        }
      }
    }

    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (error) {
    return (
      <div
        style={{
          padding: "10px 16px",
          marginBottom: 4,
          borderRadius: 6,
          fontSize: 13,
          display: "flex",
          gap: 12,
          alignItems: "center",
          background: "#f9fafb",
          borderLeft: "4px solid #9ca3af",
          color: "#6b7280",
        }}
      >
        Could not load alerts
      </div>
    );
  }

  if (alerts === null) {
    return null;
  }

  if (alerts.length === 0) {
    return (
      <div
        style={{
          padding: "10px 16px",
          marginBottom: 4,
          borderRadius: 6,
          fontSize: 13,
          display: "flex",
          gap: 12,
          alignItems: "center",
          background: "#f0fdf4",
          borderLeft: "4px solid #16a34a",
          color: "#16a34a",
        }}
      >
        ✓ All systems healthy
      </div>
    );
  }

  const sorted = [...alerts].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );

  return (
    <div>
      {sorted.map((alert, index) => {
        const styles = SEVERITY_STYLES[alert.severity];
        return (
          <div
            key={index}
            style={{
              padding: "10px 16px",
              marginBottom: 4,
              borderRadius: 6,
              fontSize: 13,
              display: "flex",
              gap: 12,
              alignItems: "center",
              background: styles.background,
              borderLeft: styles.borderLeft,
              color: styles.color,
            }}
          >
            <span style={{ fontWeight: 700, fontSize: 11, textTransform: "uppercase", flexShrink: 0 }}>
              {alert.severity}
            </span>
            <span style={{ color: "#111827" }}>{alert.message}</span>
          </div>
        );
      })}
    </div>
  );
}
