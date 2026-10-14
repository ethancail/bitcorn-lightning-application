import { Link } from "react-router-dom";
import type { TreasuryAlert } from "../api/client";
import AlertRow from "./AlertRow";

interface Props {
  alerts: TreasuryAlert[];
}

// Renders a dedicated dashboard banner when the treasury API has emitted
// a VALUATION_MANUAL_STALE alert (see getTreasuryAlerts in the API). Links
// to /valuation-input so the operator can enter today's values in one click.
// Dashboard.tsx renders this above the generic alert list AND filters the
// generic list to skip this alert type so it doesn't double-render.
// X3: a compact row like the others — heading and action on one line, the
// metric list one tap away. The heading is the one the server set (SH1); the
// fallback is this banner's own wording from before the server sent one.
export default function ValuationInputAlertBanner({ alerts }: Props) {
  const alert = alerts.find((a) => a.type === "VALUATION_MANUAL_STALE");
  if (!alert) return null;
  return (
    <AlertRow
      severity="warning"
      heading={alert.heading || "Valuation inputs need attention"}
      detail={alert.message}
      action={
        <Link to="/valuation-input" className="btn btn-primary btn-sm">
          Enter now →
        </Link>
      }
    />
  );
}
