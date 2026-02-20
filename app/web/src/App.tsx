import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import "./styles.css";
import bitcornLogo from "./assets/bitcorn-logo.svg";
import { api, type NodeInfo, type TreasuryFeePolicy } from "./api/client";
import { API_BASE } from "./config/api";
import Dashboard from "./pages/Dashboard";
import Wizard from "./pages/Wizard";
import MemberDashboard from "./pages/MemberDashboard";

// ─── App status hook ──────────────────────────────────────────────────────
//
// Determines which shell to render based on node_role:
//   "treasury_setup" → wizard (/setup)
//   "treasury"       → treasury AppShell
//   "node"           → member MemberShell (all non-treasury nodes)
//
// All non-treasury nodes get the same MemberShell regardless of whether
// they have a channel to the hub. MemberDashboard handles the no-channel
// state contextually with a "Connect to Hub" CTA.

type AppStatus = "loading" | "treasury_setup" | "treasury" | "node";

function useAppStatus(): AppStatus {
  const [status, setStatus] = useState<AppStatus>("loading");

  useEffect(() => {
    api
      .getNode()
      .then((node) => {
        if (node.node_role === "treasury") {
          if (localStorage.getItem("bitcorn_setup_done") === "1") {
            setStatus("treasury");
            return;
          }
          Promise.all([
            api
              .getTreasuryMetrics()
              .catch((e: { status?: number }) => ({ _error: e.status ?? 0 })),
            api.getFeePolicy().catch(() => null),
          ]).then(([metrics, feePolicy]) => {
            const metricsError = "_error" in (metrics as object);
            const feeNotSet =
              feePolicy == null ||
              (feePolicy as TreasuryFeePolicy).fee_rate_ppm === 0;
            if (metricsError || feeNotSet) {
              setStatus("treasury_setup");
            } else {
              localStorage.setItem("bitcorn_setup_done", "1");
              setStatus("treasury");
            }
          });
        } else {
          // All non-treasury nodes — member, external, unsynced — same shell
          setStatus("node");
        }
      })
      .catch(() => setStatus("node"));
  }, []);

  return status;
}

// ─── Shared Topbar ────────────────────────────────────────────────────────

function Topbar({ node, role }: { node: NodeInfo | null; role: "TREASURY" | "MEMBER" }) {
  const syncColor = node?.synced_to_chain ? "var(--green)" : "var(--red)";

  return (
    <header className="topbar">
      <div className="topbar-logo">
        <img src={bitcornLogo} alt="Bitcorn" style={{ height: 22, width: "auto" }} />
        <span className="topbar-tag">{role}</span>
      </div>
      <div className="topbar-spacer" />
      {node && (
        <div className="topbar-node">
          <span
            className="pulse-dot"
            style={{
              background: syncColor,
              boxShadow: node.synced_to_chain ? undefined : "none",
            }}
          />
          <span>{node.alias || "—"}</span>
          <span style={{ color: "var(--text-3)" }}>
            ·{" "}
            {node.pubkey
              ? `${node.pubkey.slice(0, 10)}…${node.pubkey.slice(-4)}`
              : ""}
          </span>
        </div>
      )}
    </header>
  );
}

// ─── Treasury AppShell ─────────────────────────────────────────────────────

function TreasurySidebar() {
  const navigate = useNavigate();

  const navItems = [
    { to: "/dashboard", icon: "▤", label: "Dashboard" },
    { to: "/channels", icon: "◈", label: "Channels" },
    { to: "/payments", icon: "↗", label: "Payments" },
    { to: "/liquidity", icon: "≋", label: "Liquidity" },
  ];

  return (
    <nav className="sidebar">
      <div className="sidebar-label">Navigate</div>
      {navItems.map((item) => (
        <div key={item.to} className="sidebar-section">
          <NavLink
            to={item.to}
            className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
          >
            <span className="icon">{item.icon}</span>
            {item.label}
          </NavLink>
        </div>
      ))}

      <div style={{ flex: 1 }} />

      <div className="sidebar-section">
        <button
          className="sidebar-item"
          onClick={() => {
            localStorage.removeItem("bitcorn_setup_done");
            navigate("/setup");
          }}
          style={{ width: "100%" }}
        >
          <span className="icon">⚙</span>
          Re-run Setup
        </button>
      </div>
    </nav>
  );
}

function AppShell() {
  const [node, setNode] = useState<NodeInfo | null>(null);

  useEffect(() => {
    const load = () => api.getNode().then(setNode).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app-shell">
      <Topbar node={node} role="TREASURY" />
      <TreasurySidebar />
      <main className="main-content">
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/payments" element={<PaymentsPage />} />
          <Route path="/liquidity" element={<LiquidityPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

// ─── Member AppShell ───────────────────────────────────────────────────────

function MemberSidebar() {
  const navItems = [
    { to: "/dashboard", icon: "▤", label: "My Dashboard" },
    { to: "/channels", icon: "◈", label: "My Channels" },
    { to: "/payments", icon: "↗", label: "My Payments" },
  ];

  return (
    <nav className="sidebar">
      <div className="sidebar-label">Navigate</div>
      {navItems.map((item) => (
        <div key={item.to} className="sidebar-section">
          <NavLink
            to={item.to}
            className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
          >
            <span className="icon">{item.icon}</span>
            {item.label}
          </NavLink>
        </div>
      ))}
    </nav>
  );
}

function MemberShell() {
  const [node, setNode] = useState<NodeInfo | null>(null);

  useEffect(() => {
    const load = () => api.getNode().then(setNode).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app-shell">
      <Topbar node={node} role="MEMBER" />
      <MemberSidebar />
      <main className="main-content">
        <Routes>
          <Route path="/dashboard" element={<MemberDashboard />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/payments" element={<MemberPaymentsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

// ─── Page stubs ────────────────────────────────────────────────────────────

function ChannelsPage() {
  const [channels, setChannels] = useState<
    Array<{
      channel_id: string;
      peer_pubkey: string;
      capacity_sat: number;
      local_balance_sat: number;
      remote_balance_sat: number;
      active: number;
    }>
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_BASE}/api/channels`)
      .then((r) => r.json())
      .then((d) => {
        setChannels(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Channels</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Active LND channel list
        </p>
      </div>

      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">◈</span>All Channels
          </span>
        </div>
        {loading ? (
          <div
            className="panel-body"
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            {[100, 80, 90].map((w, i) => (
              <div
                key={i}
                className="loading-shimmer"
                style={{ height: 16, width: `${w}%` }}
              />
            ))}
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Channel ID</th>
                  <th>Peer</th>
                  <th style={{ textAlign: "right" }}>Capacity</th>
                  <th style={{ textAlign: "right" }}>Local</th>
                  <th style={{ textAlign: "right" }}>Remote</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((c) => (
                  <tr key={c.channel_id}>
                    <td className="td-mono">{c.channel_id.slice(0, 16)}…</td>
                    <td className="td-mono">
                      {c.peer_pubkey.slice(0, 12)}…{c.peer_pubkey.slice(-6)}
                    </td>
                    <td className="td-num">{c.capacity_sat.toLocaleString()}</td>
                    <td className="td-num">{c.local_balance_sat.toLocaleString()}</td>
                    <td className="td-num">{c.remote_balance_sat.toLocaleString()}</td>
                    <td>
                      {c.active ? (
                        <span className="badge badge-green">active</span>
                      ) : (
                        <span className="badge badge-muted">inactive</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {channels.length === 0 && (
              <div className="empty-state">No channels found.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PaymentsPage() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Payments</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Payment history coming soon
        </p>
      </div>
      <div className="panel">
        <div className="empty-state" style={{ padding: "60px 20px" }}>
          Payment history view — coming soon.
        </div>
      </div>
    </div>
  );
}

function LiquidityPage() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Liquidity</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Liquidity management coming soon
        </p>
      </div>
      <div className="panel">
        <div className="empty-state" style={{ padding: "60px 20px" }}>
          Liquidity management view — coming soon.
        </div>
      </div>
    </div>
  );
}

function MemberPaymentsPage() {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>My Payments</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          Payment history coming soon
        </p>
      </div>
      <div className="panel">
        <div className="empty-state" style={{ padding: "60px 20px" }}>
          Payment history view — coming soon.
        </div>
      </div>
    </div>
  );
}

// ─── Root router ──────────────────────────────────────────────────────────

function Root() {
  const status = useAppStatus();

  if (status === "loading") {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--mono)",
            color: "var(--text-3)",
            fontSize: "0.875rem",
            letterSpacing: "0.1em",
          }}
        >
          INITIALIZING…
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/setup" element={<Wizard />} />
      {status === "treasury_setup" ? (
        <Route path="*" element={<Navigate to="/setup" replace />} />
      ) : status === "treasury" ? (
        <Route path="*" element={<AppShell />} />
      ) : (
        <Route path="*" element={<MemberShell />} />
      )}
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Root />
    </BrowserRouter>
  );
}
