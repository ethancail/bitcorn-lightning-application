import { useEffect, useState } from "react";
import { API_BASE } from "./config/api";
import { fetchFeePolicy } from "./api/client";
import InstallWizard from "./pages/InstallWizard";
import Dashboard from "./pages/Dashboard";

type View = "loading" | "wizard" | "dashboard";

export default function App() {
  const [view, setView] = useState<View>("loading");

  useEffect(() => {
    async function checkSetup() {
      try {
        // Check if treasury metrics are accessible (403 = TREASURY_PUBKEY not set)
        const metricsRes = await fetch(`${API_BASE}/api/treasury/metrics`);
        if (metricsRes.status === 403) {
          setView("wizard");
          return;
        }
        // Check if base fee rate has been configured (0 = first-run)
        const fp = await fetchFeePolicy();
        if (fp.fee_rate_ppm === 0) {
          setView("wizard");
          return;
        }
        setView("dashboard");
      } catch {
        // API unreachable — drop to wizard so operator can diagnose
        setView("wizard");
      }
    }
    checkSetup();
  }, []);

  if (view === "loading") {
    return (
      <div style={{ padding: 48, textAlign: "center", color: "#6b7280", fontFamily: "system-ui, sans-serif" }}>
        Connecting to Bitcorn Lightning…
      </div>
    );
  }

  if (view === "wizard") {
    return <InstallWizard onComplete={() => setView("dashboard")} />;
  }

  return <Dashboard />;
}
