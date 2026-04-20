import { Link } from "react-router-dom";
import type { TreasuryAlert } from "../api/client";

interface Props {
  alerts: TreasuryAlert[];
}

// Renders a dedicated dashboard banner when the treasury API has emitted
// a VALUATION_MANUAL_STALE alert (see getTreasuryAlerts in the API). Links
// to /valuation-input so the operator can enter today's values in one click.
// Dashboard.tsx renders this above the generic alert list AND filters the
// generic list to skip this alert type so it doesn't double-render.
export default function ValuationInputAlertBanner({ alerts }: Props) {
  const alert = alerts.find((a) => a.type === "VALUATION_MANUAL_STALE");
  if (!alert) return null;
  return (
    <div
      className="alert warning"
      style={{
        marginBottom: 16,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <span className="alert-icon">⚠</span>
      <div className="alert-body" style={{ flex: 1 }}>
        <div className="alert-type">Valuation inputs need attention</div>
        <div className="alert-msg">{alert.message}</div>
      </div>
      <Link
        to="/valuation-input"
        className="btn btn-primary btn-sm"
        style={{ whiteSpace: "nowrap" }}
      >
        Enter now →
      </Link>
    </div>
  );
}
