import AlertsBar from "../components/AlertsBar";
import NetYieldPanel from "../components/NetYieldPanel";
import ChannelROITable from "../components/ChannelROITable";
import PeerScoresPanel from "../components/PeerScoresPanel";
import RotationCandidatesPanel from "../components/RotationCandidatesPanel";
import DynamicFeesPanel from "../components/DynamicFeesPanel";

export default function Dashboard() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: "24px 32px", maxWidth: 1400, margin: "0 auto" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "#111827" }}>
          ⚡ Bitcorn Lightning Treasury
        </h1>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "#6b7280" }}>
          Treasury operator dashboard
        </p>
      </div>
      <AlertsBar />
      <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <NetYieldPanel />
        <PeerScoresPanel />
      </div>
      <div style={{ marginTop: 24 }}>
        <ChannelROITable />
      </div>
      <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <RotationCandidatesPanel />
        <DynamicFeesPanel />
      </div>
    </div>
  );
}
