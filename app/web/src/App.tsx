import React, { useEffect, useRef, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import "./styles.css";
import bitcornLogo from "./assets/bitcorn-logo.svg";
import { api, type NodeInfo, type TreasuryFeePolicy, type Contact, type ChannelLiquidityHealth, type RecommendedPeer, type PendingChannel, resolveContactName, truncPubkey } from "./api/client";
import { API_BASE } from "./config/api";
import Dashboard from "./pages/Dashboard";
import Wizard from "./pages/Wizard";
import MemberDashboard from "./pages/MemberDashboard";
import Charts from "./pages/Charts";
import Contacts from "./pages/Contacts";
import Payments from "./pages/Payments";
import MemberLiquidity from "./pages/MemberLiquidity";
import DepositBitcoin from "./pages/DepositBitcoin";
import WithdrawBitcoin from "./pages/WithdrawBitcoin";
import SwapOperations from "./pages/SwapOperations";
import RefillChannel from "./pages/RefillChannel";
import Peers from "./pages/Peers";
import ValuationInput from "./pages/ValuationInput";
import AutoBuy from "./pages/AutoBuy";
import NetworkGraph from "./components/NetworkGraph";
import Liquidity from "./pages/Liquidity";

// ─── Prevent scroll-to-change on number inputs ──────────────────────────
// Browsers change number input values on scroll wheel — confusing for sats fields.
document.addEventListener("wheel", (e) => {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement && el.type === "number") {
    el.blur();
  }
}, { passive: true });

// ─── Theme initialization ─────────────────────────────────────────────────
// Runs once on load — checks localStorage, falls back to OS preference.

type FontPreset = { id: string; label: string; mono: string; sans: string; preview: string };

const FONT_PRESETS: FontPreset[] = [
  { id: "plex", label: "IBM Plex", mono: "'IBM Plex Mono', monospace", sans: "'IBM Plex Sans', sans-serif", preview: "The quick brown fox" },
  { id: "inter", label: "Inter", mono: "'JetBrains Mono', monospace", sans: "'Inter', sans-serif", preview: "The quick brown fox" },
  { id: "source", label: "Source", mono: "'Source Code Pro', monospace", sans: "'Source Sans 3', sans-serif", preview: "The quick brown fox" },
  { id: "system", label: "System", mono: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace", sans: "system-ui, -apple-system, sans-serif", preview: "The quick brown fox" },
];

function applyFont(presetId: string) {
  const preset = FONT_PRESETS.find((p) => p.id === presetId) ?? FONT_PRESETS[0];
  document.documentElement.style.setProperty("--mono", preset.mono);
  document.documentElement.style.setProperty("--sans", preset.sans);
}

function initTheme() {
  const stored = localStorage.getItem("bitcorn_theme");
  if (stored === "light" || stored === "dark") {
    document.documentElement.dataset.theme = stored;
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = prefersDark ? "dark" : "light";
  }
  // Restore text scale
  const scale = localStorage.getItem("bitcorn_text_scale");
  if (scale) {
    document.documentElement.style.setProperty("--text-scale", scale);
  }
  // Restore font
  const font = localStorage.getItem("bitcorn_font");
  if (font) {
    applyFont(font);
  }
}
initTheme();

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

function Topbar({
  node,
  role,
  onMenuToggle,
}: {
  node: NodeInfo | null;
  role: "TREASURY" | "MEMBER";
  onMenuToggle: () => void;
}) {
  const syncColor = node?.synced_to_chain ? "var(--green)" : "var(--red)";

  return (
    <header className="topbar">
      <button className="hamburger-btn" onClick={onMenuToggle} aria-label="Toggle menu">
        ☰
      </button>
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

function BuyBitcoinButton() {
  const [loading, setLoading] = useState(false);

  async function handleBuy() {
    setLoading(true);
    try {
      const { url } = await api.getCoinbaseOnrampUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      // Silently fail — FundNodePanel on the dashboard is the primary entry point
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      className="sidebar-item"
      onClick={handleBuy}
      disabled={loading}
      style={{ width: "100%" }}
    >
      <span className="icon">₿</span>
      {loading ? "Opening…" : "Buy Bitcoin"}
    </button>
  );
}

function TreasurySidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();

  const navItems = [
    { to: "/dashboard", icon: "▤", label: "Dashboard" },
    { to: "/charts", icon: "⟠", label: "Charts" },
    { to: "/contacts", icon: "☰", label: "Contacts" },
    { to: "/peers", icon: "⟐", label: "Peers" },
    { to: "/channels", icon: "◈", label: "Channels" },
    { to: "/payments", icon: "↗", label: "Payments" },
    { to: "/liquidity", icon: "≋", label: "Liquidity" },
    { to: "/swaps", icon: "⟲", label: "Swaps" },
    { to: "/auto-buy", icon: "📈", label: "Auto-Buy" },
    { to: "/valuation-input", icon: "◐", label: "Valuation Inputs" },
  ];

  return (
    <nav className={`sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-mobile-header">
        <span className="sidebar-mobile-title">Menu</span>
        <button className="sidebar-close-btn" onClick={onClose} aria-label="Close menu">✕</button>
      </div>
      <div className="sidebar-label">Navigate</div>
      {navItems.map((item, i) => (
        <React.Fragment key={item.to}>
          <div className="sidebar-section">
            <NavLink
              to={item.to}
              className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
              onClick={onClose}
            >
              <span className="icon">{item.icon}</span>
              {item.label}
            </NavLink>
          </div>
          {i === 0 && (
            <>
              <div className="sidebar-section">
                <BuyBitcoinButton />
              </div>
              <div className="sidebar-section">
                <NavLink
                  to="/deposit"
                  className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
                  onClick={onClose}
                >
                  <span className="icon">↙</span>
                  Deposit Bitcoin
                </NavLink>
              </div>
            </>
          )}
        </React.Fragment>
      ))}

      <div style={{ flex: 1 }} />

      <div className="sidebar-section">
        <NavLink
          to="/settings"
          className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
          onClick={onClose}
        >
          <span className="icon">⚙</span>
          Settings
        </NavLink>
      </div>
    </nav>
  );
}

function AppShell() {
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const load = () => api.getNode().then(setNode).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app-shell">
      <Topbar node={node} role="TREASURY" onMenuToggle={() => setMenuOpen((v) => !v)} />
      <div className={`sidebar-overlay ${menuOpen ? "visible" : ""}`} onClick={() => setMenuOpen(false)} />
      <TreasurySidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <main className="main-content">
        <Routes>
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/charts" element={<Charts />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/peers" element={<Peers />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/payments" element={<Payments title="Payments" />} />
          <Route path="/liquidity" element={<LiquidityPage />} />
          <Route path="/deposit" element={<DepositBitcoin />} />
          <Route path="/swaps" element={<SwapOperations />} />
          <Route path="/auto-buy" element={<AutoBuy />} />
          <Route path="/valuation-input" element={<ValuationInput />} />
          <Route path="/settings" element={<SettingsPage isTreasury />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

// ─── Member AppShell ───────────────────────────────────────────────────────

function MemberSidebar({ open, onClose, channelRole }: { open: boolean; onClose: () => void; channelRole: string }) {
  const isMerchant = channelRole === "merchant";
  const liquidityLabel = isMerchant ? "Refill Channel" : "Cash Out";
  const liquidityIcon = isMerchant ? "↙" : "↗";
  const liquidityRoute = isMerchant ? "/refill" : "/cashout";

  const navItems = [
    { to: "/dashboard", icon: "▤", label: "My Dashboard" },
    { to: "/charts", icon: "⟠", label: "Charts" },
    { to: "/contacts", icon: "☰", label: "Contacts" },
    { to: "/channels", icon: "◈", label: "My Channels" },
    { to: "/auto-buy", icon: "📈", label: "Auto-Buy" },
    { to: "/payments", icon: "↗", label: "My Payments" },
  ];

  return (
    <nav className={`sidebar ${open ? "open" : ""}`}>
      <div className="sidebar-mobile-header">
        <span className="sidebar-mobile-title">Menu</span>
        <button className="sidebar-close-btn" onClick={onClose} aria-label="Close menu">✕</button>
      </div>
      <div className="sidebar-label">Navigate</div>
      {navItems.map((item, i) => (
        <React.Fragment key={item.to}>
          <div className="sidebar-section">
            <NavLink
              to={item.to}
              className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
              onClick={onClose}
            >
              <span className="icon">{item.icon}</span>
              {item.label}
            </NavLink>
          </div>
          {i === 0 && (
            <>
              <div className="sidebar-section">
                <BuyBitcoinButton />
              </div>
              <div className="sidebar-section">
                <NavLink
                  to="/deposit"
                  className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
                  onClick={onClose}
                >
                  <span className="icon">↙</span>
                  Deposit Bitcoin
                </NavLink>
              </div>
              <div className="sidebar-section">
                <NavLink
                  to={liquidityRoute}
                  className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
                  onClick={onClose}
                >
                  <span className="icon">{liquidityIcon}</span>
                  {liquidityLabel}
                </NavLink>
              </div>
            </>
          )}
        </React.Fragment>
      ))}

      <div style={{ flex: 1 }} />

      <div className="sidebar-section">
        <NavLink
          to="/settings"
          className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
          onClick={onClose}
        >
          <span className="icon">⚙</span>
          Settings
        </NavLink>
      </div>
    </nav>
  );
}

function MemberShell() {
  const [node, setNode] = useState<NodeInfo | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [channelRole, setChannelRole] = useState("unknown");

  useEffect(() => {
    const load = () => api.getNode().then(setNode).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // channelRole is polled every 15s AND refetched on a "bitcorn:role-changed" event
    // (dispatched by Settings after a role save). Without the poll, the sidebar would
    // show stale labels after role changes; without the event, it'd take up to 15s
    // to update after save.
    const loadRole = () => {
      api.getMemberLiquidityStatus()
        .then((s) => { if (s.classification?.channelRole) setChannelRole(s.classification.channelRole); })
        .catch(() => {});
    };
    loadRole();
    const id = setInterval(loadRole, 15_000);
    const onRoleChanged = () => loadRole();
    window.addEventListener("bitcorn:role-changed", onRoleChanged);
    return () => {
      clearInterval(id);
      window.removeEventListener("bitcorn:role-changed", onRoleChanged);
    };
  }, []);

  return (
    <div className="app-shell">
      <Topbar node={node} role="MEMBER" onMenuToggle={() => setMenuOpen((v) => !v)} />
      <div className={`sidebar-overlay ${menuOpen ? "visible" : ""}`} onClick={() => setMenuOpen(false)} />
      <MemberSidebar open={menuOpen} onClose={() => setMenuOpen(false)} channelRole={channelRole} />
      <main className="main-content">
        <Routes>
          <Route path="/dashboard" element={<MemberDashboard />} />
          <Route path="/charts" element={<Charts />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/payments" element={<Payments title="My Payments" />} />
          <Route path="/auto-buy" element={<AutoBuy />} />
          <Route path="/deposit" element={<DepositBitcoin />} />
          <Route path="/cashout" element={<WithdrawBitcoin />} />
          <Route path="/refill" element={<RefillChannel />} />
          <Route path="/withdraw" element={<WithdrawBitcoin />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

// ─── Settings page ─────────────────────────────────────────────────────────

type ThemeChoice = "dark" | "light" | "system";

const TEXT_SCALE_PRESETS = [
  { value: "0.85", label: "Small" },
  { value: "1", label: "Default" },
  { value: "1.15", label: "Large" },
  { value: "1.3", label: "Extra Large" },
];

function ChannelRolePanel() {
  const [role, setRole] = useState<"unknown" | "merchant" | "farmer">("unknown");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getMemberLiquidityStatus()
      .then((d) => {
        const r = d.classification?.channelRole;
        if (r === "merchant" || r === "farmer") setRole(r);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSetRole(newRole: "merchant" | "farmer" | "unknown") {
    setSaving(true);
    try {
      await api.setChannelRole(newRole);
      setRole(newRole);
      // Notify MemberShell so the sidebar refetches and updates labels immediately
      // (rather than waiting up to 15s for the next poll).
      window.dispatchEvent(new CustomEvent("bitcorn:role-changed"));
    } catch {}
    setSaving(false);
  }

  const roles: { value: "merchant" | "farmer"; icon: string; label: string; desc: string }[] = [
    { value: "merchant", icon: "↗", label: "Merchant", desc: "You send payments through the hub — outbound capacity matters most" },
    { value: "farmer", icon: "↙", label: "Farmer", desc: "You receive earnings through the hub — receiving capacity matters most" },
  ];

  return (
    <div className="panel ops" style={{ marginTop: 12 }}>
      <div className="panel-header">
        <span className="panel-title"><span className="icon">◈</span>Channel Role</span>
        {role !== "unknown" && (
          <span className={`badge ${role === "merchant" ? "badge-amber" : "badge-green"}`} style={{ textTransform: "capitalize" }}>
            {role}
          </span>
        )}
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: "0.8125rem", color: "var(--text-3)", marginBottom: 4 }}>
          Your channel role determines how liquidity recommendations are calculated.
        </div>
        {loading ? (
          <div className="loading-shimmer" style={{ height: 80, borderRadius: 6 }} />
        ) : (
          <>
            {roles.map((opt) => (
              <button
                key={opt.value}
                className={`theme-option ${role === opt.value ? "selected" : ""}`}
                onClick={() => handleSetRole(opt.value)}
                disabled={saving}
              >
                <span style={{ fontSize: "1.25rem" }}>{opt.icon}</span>
                <div>
                  <div style={{ fontWeight: 600 }}>{opt.label}</div>
                  <div style={{ fontSize: "0.75rem", color: role === opt.value ? "var(--amber-dim)" : "var(--text-3)" }}>
                    {opt.desc}
                  </div>
                </div>
              </button>
            ))}
            {role !== "unknown" && (
              <button
                className="btn btn-ghost"
                style={{ fontSize: "0.75rem", color: "var(--text-3)", alignSelf: "flex-start" }}
                onClick={() => handleSetRole("unknown")}
                disabled={saving}
              >
                Clear role selection
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SettingsPage({ isTreasury }: { isTreasury?: boolean }) {
  const navigate = useNavigate();
  const [theme, setTheme] = useState<ThemeChoice>(() => {
    const stored = localStorage.getItem("bitcorn_theme");
    if (stored === "light" || stored === "dark") return stored;
    return "system";
  });
  const [textScale, setTextScale] = useState(() => localStorage.getItem("bitcorn_text_scale") || "1");
  const [fontId, setFontId] = useState(() => localStorage.getItem("bitcorn_font") || "plex");

  function changeTheme(value: ThemeChoice) {
    setTheme(value);
    if (value === "system") {
      localStorage.removeItem("bitcorn_theme");
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = prefersDark ? "dark" : "light";
    } else {
      localStorage.setItem("bitcorn_theme", value);
      document.documentElement.dataset.theme = value;
    }
  }

  function changeTextScale(value: string) {
    setTextScale(value);
    document.documentElement.style.setProperty("--text-scale", value);
    if (value === "1") {
      localStorage.removeItem("bitcorn_text_scale");
    } else {
      localStorage.setItem("bitcorn_text_scale", value);
    }
  }

  function changeFont(id: string) {
    setFontId(id);
    applyFont(id);
    if (id === "plex") {
      localStorage.removeItem("bitcorn_font");
    } else {
      localStorage.setItem("bitcorn_font", id);
    }
  }

  const options: { value: ThemeChoice; icon: string; label: string; desc: string }[] = [
    { value: "dark", icon: "◐", label: "Dark", desc: "Amber on black — the original" },
    { value: "light", icon: "○", label: "Light", desc: "Warm cream with amber accents" },
    { value: "system", icon: "◑", label: "System", desc: "Follow your OS preference" },
  ];

  return (
    <div className="fade-in" style={{ maxWidth: 720, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 4 }}>Settings</h1>
      <p style={{ color: "var(--text-3)", fontSize: "0.875rem", marginBottom: 16 }}>
        Preferences for your BitCorn node
      </p>

      <div className="settings-section-label">Personal</div>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title"><span className="icon">◐</span>Appearance</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Theme: horizontal chips */}
          <div style={{ display: "flex", gap: 6 }}>
            {options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => changeTheme(opt.value)}
                style={{
                  flex: 1, padding: "8px 12px", borderRadius: 8, cursor: "pointer",
                  border: `2px solid ${theme === opt.value ? "var(--amber)" : "var(--border)"}`,
                  background: theme === opt.value ? "color-mix(in srgb, var(--amber) 10%, var(--bg-2))" : "var(--bg-2)",
                  color: theme === opt.value ? "var(--amber)" : "var(--text-3)",
                  textAlign: "center", fontSize: "0.8125rem", fontWeight: 600, fontFamily: "var(--sans)",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Text size: slider only, no presets */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: "0.8125rem", fontWeight: 500 }}>Text Size</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>{Math.round(parseFloat(textScale) * 100)}%</span>
            </div>
            <input
              type="range" min="0.75" max="1.5" step="0.05" value={textScale}
              onChange={(e) => changeTextScale(e.target.value)}
              style={{ width: "100%", accentColor: "var(--amber)" }}
            />
          </div>

          {/* Font: compact 2x2 grid */}
          <div>
            <span style={{ fontSize: "0.8125rem", fontWeight: 500, marginBottom: 4, display: "block" }}>Font</span>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
              {FONT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => changeFont(preset.id)}
                  style={{
                    padding: "8px 10px", borderRadius: 8, cursor: "pointer",
                    border: `2px solid ${fontId === preset.id ? "var(--amber)" : "var(--border)"}`,
                    background: fontId === preset.id ? "color-mix(in srgb, var(--amber) 10%, var(--bg-2))" : "var(--bg-2)",
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: "0.8125rem", color: fontId === preset.id ? "var(--amber)" : "var(--text)", fontFamily: preset.sans }}>
                    {preset.label}
                  </div>
                  <div style={{ fontSize: "0.6875rem", fontFamily: preset.mono, color: "var(--text-3)", marginTop: 2 }}>
                    0123456789
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Operations section — both roles have at least one operational panel,
          so the label is unconditional (member: Channel Role; treasury: Fee Policy + Capital Guardrails). */}
      <div className="settings-section-label ops">[ Operations ]</div>

      {!isTreasury && <ChannelRolePanel />}

      {isTreasury && <FeePolicyPanel />}
      {isTreasury && <CapitalPolicyPanel />}

      {isTreasury && (
        <div className="settings-footer-row">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              localStorage.removeItem("bitcorn_setup_done");
              navigate("/setup");
            }}
          >
            Re-run Setup Wizard
          </button>
          <p style={{ fontSize: "0.6875rem", color: "var(--text-3)", margin: 0 }}>
            Resets the setup flag and walks through initial configuration again.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Capital Policy Panel (treasury settings) ─────────────────────────────

type PolicyField = {
  key: string;
  label: string;
  unit: string;
  help: string;
  min?: number;
  step?: number;
};

const POLICY_FIELDS: PolicyField[] = [
  { key: "min_onchain_reserve_sats", label: "Min On-Chain Reserve", unit: "sats", help: "Minimum sats kept on-chain after channel opens", min: 0, step: 10000 },
  { key: "max_deploy_ratio_ppm", label: "Max Deploy Ratio", unit: "ppm (parts per million)", help: "Max fraction of on-chain balance deployable into channels. 600000 = 60%, 900000 = 90%", min: 0, step: 50000 },
  { key: "max_peer_capacity_sats", label: "Max Per-Peer Capacity", unit: "sats", help: "Maximum total channel capacity to a single peer", min: 100000, step: 100000 },
  { key: "max_pending_opens", label: "Max Pending Opens", unit: "channels", help: "Maximum simultaneous channel opens in flight", min: 1, step: 1 },
  { key: "peer_cooldown_minutes", label: "Peer Cooldown", unit: "minutes", help: "Minimum wait between channel opens to the same peer", min: 0, step: 10 },
  { key: "max_expansions_per_day", label: "Max Opens Per Day", unit: "channels", help: "Maximum channel opens in a 24h window", min: 1, step: 1 },
  { key: "max_daily_deploy_sats", label: "Max Daily Deploy", unit: "sats", help: "Maximum sats deployed into channels per day", min: 100000, step: 100000 },
  { key: "max_daily_loss_sats", label: "Max Daily Loss", unit: "sats", help: "Maximum sats in rebalance costs per day before automation pauses", min: 0, step: 1000 },
];

// ─── PolicyCard ─────────────────────────────────────────────────
// Dual-mode card used in FeePolicyPanel + CapitalPolicyPanel.
// Read mode: large mono value with unit + interactive caret.
// Edit mode: text input with inline-numeric comma formatting, matches
// the existing pattern in CapitalPolicyPanel.

type PolicyCardProps = {
  id: string;
  label: string;
  meta: string;
  value: number;
  unit: string;
  inputWidth?: number;
  isEditing: boolean;
  isFocused: boolean;
  onEditRequest: (id: string) => void;
  onValueChange: (id: string, next: number) => void;
};

function PolicyCard({
  id, label, meta, value, unit, inputWidth = 150,
  isEditing, isFocused, onEditRequest, onValueChange,
}: PolicyCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && isFocused && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing, isFocused]);

  if (isEditing) {
    return (
      <div className={`policy-card editing${isFocused ? " focus" : ""}`}>
        <div>
          <div className="policy-card-label">{label}</div>
          <div className="policy-card-meta">{meta}</div>
        </div>
        <div className="policy-card-edit">
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            value={value > 0 ? value.toLocaleString() : "0"}
            onChange={(e) => {
              const raw = e.target.value.replace(/[^0-9]/g, "");
              onValueChange(id, raw === "" ? 0 : Number(raw));
            }}
            style={{ width: inputWidth }}
          />
          <span className="unit">{unit}</span>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      className="policy-card"
      onClick={() => onEditRequest(id)}
      aria-label={`Edit ${label}`}
    >
      <div>
        <div className="policy-card-label">{label}</div>
        <div className="policy-card-meta">{meta}</div>
      </div>
      <div className="policy-card-value">
        {value.toLocaleString()}
        <span className="unit">{unit}</span>
        <span className="policy-card-caret">›</span>
      </div>
    </button>
  );
}

function FeePolicyPanel() {
  const [baseFee, setBaseFee] = useState(1000); // msat
  const [feeRate, setFeeRate] = useState(500); // ppm
  const [loadedBaseFee, setLoadedBaseFee] = useState(1000);
  const [loadedFeeRate, setLoadedFeeRate] = useState(500);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getFeePolicy()
      .then((p) => {
        setBaseFee(p.base_fee_msat); setFeeRate(p.fee_rate_ppm);
        setLoadedBaseFee(p.base_fee_msat); setLoadedFeeRate(p.fee_rate_ppm);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const dirtyCount =
    (baseFee !== loadedBaseFee ? 1 : 0) + (feeRate !== loadedFeeRate ? 1 : 0);

  function startEdit(fieldId: string) {
    setFocusedField(fieldId);
    setIsEditing(true);
    setSaved(false);
  }

  function cancelEdit() {
    setBaseFee(loadedBaseFee);
    setFeeRate(loadedFeeRate);
    setIsEditing(false);
    setFocusedField(null);
    setError(null);
  }

  async function handleSave() {
    setSaving(true); setError(null); setSaved(false);
    try {
      const resp = await api.setFeePolicy(baseFee, feeRate);
      const newBase = resp.base_fee_msat ?? baseFee;
      const newRate = resp.fee_rate_ppm ?? feeRate;
      setBaseFee(newBase); setFeeRate(newRate);
      setLoadedBaseFee(newBase); setLoadedFeeRate(newRate);
      setIsEditing(false); setFocusedField(null); setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) { setError(e.message ?? "Failed to save"); }
    finally { setSaving(false); }
  }

  // Keep a ref in sync with `saving` so the Esc handler sees the current value
  // across its lifetime without re-binding the listener on every save state change.
  const savingRef = useRef(saving);
  useEffect(() => { savingRef.current = saving; }, [saving]);

  // Esc-to-cancel while editing (skipped during an in-flight save)
  useEffect(() => {
    if (!isEditing) return;
    const el = panelRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !savingRef.current) {
        e.preventDefault();
        cancelEdit();
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
    // cancelEdit is intentionally omitted — loadedBaseFee/loadedFeeRate don't
    // mutate during edit mode, so the captured closure is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  // Example fee for 100k payment
  const examplePayment = 100_000;
  const exampleFee = Math.round(baseFee / 1000) + Math.round(examplePayment * feeRate / 1_000_000);
  const pctDisplay = (feeRate / 10_000).toFixed(2);

  return (
    <div ref={panelRef} className="panel ops" style={{ marginTop: 12 }}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">↗</span>Routing Fee Policy
          {isEditing && (
            <span style={{ marginLeft: 8, fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--amber)", letterSpacing: "0.04em", textTransform: "none" }}>
              · editing
            </span>
          )}
        </span>
        {saved && <span style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--green)" }}>✓ Applied</span>}
        {!saved && isEditing && dirtyCount > 0 && (
          <span aria-live="polite" style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>
            {dirtyCount} unsaved
          </span>
        )}
        {!saved && !isEditing && !loading && (
          <button
            className="btn btn-sm btn-outline"
            onClick={() => startEdit("base_fee_msat")}
          >
            Edit
          </button>
        )}
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {loading ? (
          <div className="loading-shimmer" style={{ height: 60, borderRadius: 6 }} />
        ) : (
          <>
            <p className="text-dim" style={{ fontSize: "0.75rem", margin: 0 }}>
              Fee charged on every payment routed through your channels. Applied to all channels.
            </p>

            <PolicyCard
              id="base_fee_msat"
              label="Base Fee"
              meta="Flat fee per routed payment"
              value={baseFee}
              unit="msat"
              inputWidth={120}
              isEditing={isEditing}
              isFocused={focusedField === "base_fee_msat"}
              onEditRequest={startEdit}
              onValueChange={(_id, v) => setBaseFee(v)}
            />
            <PolicyCard
              id="fee_rate_ppm"
              label="Fee Rate"
              meta={`Proportional fee per routed sat (${pctDisplay}%)`}
              value={feeRate}
              unit="ppm"
              inputWidth={120}
              isEditing={isEditing}
              isFocused={focusedField === "fee_rate_ppm"}
              onEditRequest={startEdit}
              onValueChange={(_id, v) => setFeeRate(v)}
            />

            <div style={{ padding: "8px 12px", background: "var(--bg-3)", borderRadius: 6, fontSize: "0.75rem", color: "var(--text-2)" }}>
              Example: a {examplePayment.toLocaleString()} sat payment would cost the sender <strong>{exampleFee.toLocaleString()} sats</strong> in routing fees ({pctDisplay}% + {Math.round(baseFee / 1000)} sat base).
            </div>

            {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}

            {isEditing && (
              <div className="policy-action-row">
                <button className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={saving}>Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving || dirtyCount === 0}>
                  {saving ? "Applying..." : "Save Changes"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CapitalPolicyPanel() {
  const [policy, setPolicy] = useState<Record<string, number> | null>(null);
  const [loadedPolicy, setLoadedPolicy] = useState<Record<string, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getCapitalPolicy()
      .then((p) => {
        const rec = p as unknown as Record<string, number>;
        setPolicy(rec); setLoadedPolicy(rec);
        setLoading(false);
      })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, []);

  const dirtyCount = policy && loadedPolicy
    ? POLICY_FIELDS.reduce((n, f) => n + ((policy[f.key] ?? 0) !== (loadedPolicy[f.key] ?? 0) ? 1 : 0), 0)
    : 0;

  function startEdit(fieldId: string) {
    setFocusedField(fieldId);
    setIsEditing(true);
    setSaved(false);
  }

  function cancelEdit() {
    if (loadedPolicy) setPolicy(loadedPolicy);
    setIsEditing(false); setFocusedField(null); setError(null);
  }

  function handleChange(key: string, value: number) {
    if (!policy) return;
    setPolicy({ ...policy, [key]: value });
    setSaved(false);
  }

  async function handleSave() {
    if (!policy) return;
    setSaving(true); setError(null); setSaved(false);
    try {
      const updated = await api.setCapitalPolicy(policy as any);
      const rec = updated as unknown as Record<string, number>;
      setPolicy(rec); setLoadedPolicy(rec);
      setIsEditing(false); setFocusedField(null); setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e: any) {
      setError(e.message ?? "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // Keep a ref in sync with `saving` so the Esc handler sees the current value
  // without re-binding the listener on every save state change.
  const savingRef = useRef(saving);
  useEffect(() => { savingRef.current = saving; }, [saving]);

  // Esc-to-cancel while editing (skipped during an in-flight save)
  useEffect(() => {
    if (!isEditing) return;
    const el = panelRef.current;
    if (!el) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !savingRef.current) {
        e.preventDefault();
        cancelEdit();
      }
    };
    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
    // cancelEdit is intentionally omitted — loadedPolicy doesn't mutate
    // during edit mode, so the captured closure is safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  return (
    <div ref={panelRef} className="panel ops" style={{ marginTop: 12 }}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">⊞</span>Capital Guardrails
          {isEditing && (
            <span style={{ marginLeft: 8, fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--amber)", letterSpacing: "0.04em", textTransform: "none" }}>
              · editing
            </span>
          )}
        </span>
        {saved && <span style={{ fontFamily: "var(--mono)", fontSize: "0.75rem", color: "var(--green)" }}>✓ Saved</span>}
        {!saved && isEditing && dirtyCount > 0 && (
          <span aria-live="polite" style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>
            {dirtyCount} unsaved
          </span>
        )}
        {!saved && !isEditing && !loading && policy && (
          <button
            className="btn btn-sm btn-outline"
            onClick={() => startEdit(POLICY_FIELDS[0].key)}
          >
            Edit
          </button>
        )}
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {loading ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="loading-shimmer" style={{ height: 48, borderRadius: 6 }} />
            ))}
          </div>
        ) : error && !policy ? (
          <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>
        ) : policy ? (
          <>
            <p className="text-dim" style={{ fontSize: "0.75rem", lineHeight: 1.5, margin: 0, marginBottom: 2 }}>
              Enforced before every channel open.
            </p>

            {POLICY_FIELDS.map((f) => (
              <PolicyCard
                key={f.key}
                id={f.key}
                label={f.label}
                meta={f.help}
                value={policy[f.key] ?? 0}
                unit={f.unit === "ppm (parts per million)" ? "ppm" : f.unit}
                inputWidth={150}
                isEditing={isEditing}
                isFocused={focusedField === f.key}
                onEditRequest={startEdit}
                onValueChange={handleChange}
              />
            ))}

            {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}

            {isEditing && (
              <div className="policy-action-row">
                <button className="btn btn-ghost btn-sm" onClick={cancelEdit} disabled={saving}>Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={handleSave} disabled={saving || dirtyCount === 0}>
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ─── Page stubs ────────────────────────────────────────────────────────────

function RecommendedPeersPanel() {
  const [peers, setPeers] = useState<RecommendedPeer[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [result, setResult] = useState<{ peerId: string; txid: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selectedSize, setSelectedSize] = useState<Record<string, number>>({});

  const PRESETS = [1_000_000, 5_000_000, 10_000_000];

  useEffect(() => {
    api.getRecommendedPeers()
      .then((p) => {
        setPeers(p);
        // Default each peer to its recommended size
        const defaults: Record<string, number> = {};
        for (const peer of p) defaults[peer.id] = peer.recommended_channel_size_sat;
        setSelectedSize(defaults);
      })
      .catch(() => setPeers([]))
      .finally(() => setLoading(false));
  }, []);

  async function handleOpen(peer: RecommendedPeer) {
    const amount = selectedSize[peer.id] ?? peer.recommended_channel_size_sat;
    setOpeningId(peer.id);
    setError(null);
    setResult(null);
    try {
      const res = await api.openRecommendedChannel(peer.id, amount);
      setResult({ peerId: peer.id, txid: res.funding_txid ?? "submitted" });
      api.getRecommendedPeers().then(setPeers).catch(() => {});
    } catch (e: any) {
      setError(e.message ?? "Failed to open channel");
    } finally {
      setOpeningId(null);
    }
  }

  const visiblePeers = showAdvanced ? peers : peers.filter((p) => !p.advanced);

  if (loading) {
    return (
      <div className="panel fade-in" style={{ marginTop: 16 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">⟐</span>Treasury-Approved External Peers</span>
        </div>
        <div className="panel-body">
          <div className="loading-shimmer" style={{ height: 60, borderRadius: 6 }} />
        </div>
      </div>
    );
  }

  if (peers.length === 0) return null;

  return (
    <div id="recommended-peers-panel" className="panel fade-in" style={{ marginTop: 16 }}>
      <div className="panel-header">
        <span className="panel-title"><span className="icon">⟐</span>Treasury-Approved External Peers</span>
        <span className="badge badge-muted">optional</span>
      </div>
      <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: "0.8125rem", color: "var(--text-3)", marginBottom: 4 }}>
          These are curated external routing peers vetted by the treasury operator.
          Your hub channel is your primary connection — external peers are optional
          and may improve routing diversity.
        </div>

        {error && (
          <div className="alert critical" style={{ marginBottom: 0 }}>
            <span className="alert-icon">✕</span>
            <div className="alert-body"><div className="alert-msg">{error}</div></div>
          </div>
        )}

        {visiblePeers.map((peer) => {
          const hasChannel = peer.has_channel && peer.channels.length > 0;
          const isOpening = openingId === peer.id;
          const justOpened = result?.peerId === peer.id;

          return (
            <div
              key={peer.id}
              style={{
                background: "var(--bg-3)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "12px 16px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: "0.9375rem" }}>{peer.label}</span>
                  {peer.advanced && <span className="badge badge-muted" style={{ fontSize: "0.625rem" }}>advanced</span>}
                  {peer.connected && <span className="badge badge-green" style={{ fontSize: "0.625rem" }}>connected</span>}
                  {hasChannel && <span className="badge badge-blue" style={{ fontSize: "0.625rem" }}>channel open</span>}
                </div>
              </div>
              <div style={{ fontSize: "0.8125rem", color: "var(--text-2)", marginBottom: 8 }}>
                {peer.description}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: "0.75rem", color: "var(--text-3)", marginBottom: 10 }}>
                <div style={{ fontFamily: "var(--mono)" }}>
                  {truncPubkey(peer.pubkey)} @ {peer.socket}
                </div>
                <div>
                  Recommended size: {peer.recommended_channel_size_sat.toLocaleString()} sats
                </div>
              </div>

              {/* Existing channels */}
              {hasChannel && peer.channels.map((ch) => {
                const localPct = ch.capacity_sat > 0 ? (ch.local_balance_sat / ch.capacity_sat) * 100 : 0;
                const chUndersized = classifyCapacity(ch.capacity_sat, false) === "undersized";
                const chUpgradeSize = peer.recommended_channel_size_sat > ch.capacity_sat
                  ? peer.recommended_channel_size_sat
                  : recommendedUpgradeSize(ch.capacity_sat, false);
                return (
                  <div key={ch.channel_id} style={{ marginBottom: 8 }}>
                    {chUndersized && (
                      <div style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        fontSize: "0.6875rem", color: "var(--yellow)", fontFamily: "var(--mono)",
                        marginBottom: 4, padding: "4px 8px", background: "var(--yellow-glow)", borderRadius: 4,
                      }}>
                        <span>⚠ Current channel undersized ({ch.capacity_sat.toLocaleString()} sats) — open a {chUpgradeSize.toLocaleString()} sat channel</span>
                      </div>
                    )}
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "var(--text-3)", marginBottom: 4 }}>
                      <span>Local {localPct.toFixed(0)}%</span>
                      <span>{ch.capacity_sat.toLocaleString()} sats</span>
                    </div>
                    <div style={{ height: 6, borderRadius: 3, background: "var(--bg-2)", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${localPct}%`, background: "var(--green)", borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}

              {/* Show open form for undersized existing channels too */}
              {hasChannel && peer.channels.some((ch) => classifyCapacity(ch.capacity_sat, false) === "undersized") && !justOpened && (() => {
                const chUpgradeSize = peer.recommended_channel_size_sat > (peer.channels[0]?.capacity_sat ?? 0)
                  ? peer.recommended_channel_size_sat
                  : recommendedUpgradeSize(peer.channels[0]?.capacity_sat ?? 0, false);
                return (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
                    <div style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>Open upgraded channel (sats)</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {PRESETS.map((preset) => (
                        <button
                          key={preset}
                          className={`btn ${(selectedSize[peer.id] ?? chUpgradeSize) === preset ? "btn-primary" : "btn-outline"}`}
                          style={{ fontSize: "0.75rem", padding: "4px 10px", flex: "1 1 auto" }}
                          onClick={() => setSelectedSize((s) => ({ ...s, [peer.id]: preset }))}
                        >
                          {preset >= 1_000_000
                            ? `${(preset / 1_000_000).toFixed(preset % 1_000_000 === 0 ? 0 : 1)}M`
                            : `${(preset / 1_000).toFixed(0)}k`}
                          {preset === chUpgradeSize ? " ★" : ""}
                        </button>
                      ))}
                    </div>
                    <input
                      type="number"
                      className="form-input"
                      style={{ fontSize: "0.8125rem" }}
                      min={100000}
                      step={100000}
                      value={selectedSize[peer.id] ?? chUpgradeSize}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val)) setSelectedSize((s) => ({ ...s, [peer.id]: val }));
                      }}
                    />
                    <button
                      className="btn btn-primary"
                      style={{ width: "100%" }}
                      onClick={() => handleOpen(peer)}
                      disabled={isOpening || (selectedSize[peer.id] ?? 0) < 100_000}
                    >
                      {isOpening ? "Opening channel…" : `Open ${(selectedSize[peer.id] ?? chUpgradeSize).toLocaleString()} sat channel`}
                    </button>
                  </div>
                );
              })()}

              {justOpened ? (
                <div className="alert healthy" style={{ marginBottom: 0, padding: "6px 10px" }}>
                  <span className="alert-icon">✓</span>
                  <div className="alert-body">
                    <div className="alert-msg" style={{ fontSize: "0.8125rem" }}>
                      Channel opening submitted{result.txid !== "submitted" ? ` — ${result.txid.slice(0, 16)}...` : ""}
                    </div>
                  </div>
                </div>
              ) : !hasChannel ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>Channel size (sats)</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {PRESETS.map((preset) => (
                      <button
                        key={preset}
                        className={`btn ${(selectedSize[peer.id] ?? peer.recommended_channel_size_sat) === preset ? "btn-primary" : "btn-outline"}`}
                        style={{ fontSize: "0.75rem", padding: "4px 10px", flex: "1 1 auto" }}
                        onClick={() => setSelectedSize((s) => ({ ...s, [peer.id]: preset }))}
                      >
                        {preset === peer.recommended_channel_size_sat
                          ? `${(preset / 1_000_000).toFixed(preset % 1_000_000 === 0 ? 0 : 1)}M ★`
                          : preset >= 1_000_000
                            ? `${(preset / 1_000_000).toFixed(preset % 1_000_000 === 0 ? 0 : 1)}M`
                            : `${(preset / 1_000).toFixed(0)}k`}
                      </button>
                    ))}
                  </div>
                  <input
                    type="number"
                    className="form-input"
                    style={{ fontSize: "0.8125rem" }}
                    min={100000}
                    step={100000}
                    value={selectedSize[peer.id] ?? peer.recommended_channel_size_sat}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val)) setSelectedSize((s) => ({ ...s, [peer.id]: val }));
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    style={{ width: "100%" }}
                    onClick={() => handleOpen(peer)}
                    disabled={isOpening || (selectedSize[peer.id] ?? 0) < 100_000}
                  >
                    {isOpening ? "Opening channel…" : `Open ${(selectedSize[peer.id] ?? peer.recommended_channel_size_sat).toLocaleString()} sat channel`}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}

        {peers.some((p) => p.advanced) && (
          <button
            className="btn btn-ghost"
            style={{ fontSize: "0.75rem" }}
            onClick={() => setShowAdvanced(!showAdvanced)}
          >
            {showAdvanced ? "Hide advanced peers" : "Show advanced peers"}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Capacity classification ──────────────────────────────────────────────
// Treasury channels carry all member traffic (forced routing), need more capacity.
// External peers are supplementary routing — lower thresholds.

const TREASURY_PUBKEY = "02b759b1552f6471599420c9aa8b7fb52c0a343ecc8a06157b452b5a3b107a1bca";

type CapacityStatus = "undersized" | "adequate" | "large";

function classifyCapacity(capacitySat: number, isTreasury: boolean): CapacityStatus {
  if (isTreasury) {
    if (capacitySat < 2_000_000) return "undersized";
    if (capacitySat < 10_000_000) return "adequate";
    return "large";
  }
  if (capacitySat < 1_000_000) return "undersized";
  if (capacitySat < 5_000_000) return "adequate";
  return "large";
}

function recommendedUpgradeSize(capacitySat: number, isTreasury: boolean): number {
  if (isTreasury) {
    if (capacitySat < 2_000_000) return 5_000_000;
    return 10_000_000;
  }
  if (capacitySat < 1_000_000) return 1_000_000;
  return 5_000_000;
}

function ChannelsPage() {
  const navigate = useNavigate();
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
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [health, setHealth] = useState<ChannelLiquidityHealth[]>([]);
  const [expandedHint, setExpandedHint] = useState<string | null>(null);
  const [nodeRole, setNodeRole] = useState<string | null>(null);
  const [closingChannel, setClosingChannel] = useState<string | null>(null);
  const [closeConfirm, setCloseConfirm] = useState<{ channelId: string; peerName: string; capacity: number } | null>(null);
  const [closeFeeRate, setCloseFeeRate] = useState<number | undefined>(undefined); // Economy default (LND estimator)
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closeResult, setCloseResult] = useState<{ channelId: string; txid: string | null } | null>(null);
  const [closingPubkeys, setClosingPubkeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.getNode().then((n) => setNodeRole(n.node_role)).catch(() => {});
    Promise.all([
      fetch(`${API_BASE}/api/channels`).then((r) => r.json()),
      api.getContacts().catch(() => [] as Contact[]),
      api.getLiquidityHealth().catch(() => [] as ChannelLiquidityHealth[]),
      api.getPendingChannels().catch(() => [] as PendingChannel[]),
    ]).then(([ch, ct, lh, pend]) => {
      setChannels(ch);
      setContacts(ct);
      setHealth(lh);
      setClosingPubkeys(new Set(pend.filter((p: PendingChannel) => p.status === "closing").map((p: PendingChannel) => p.peer_pubkey)));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  function refreshChannels() {
    Promise.all([
      fetch(`${API_BASE}/api/channels`).then((r) => r.json()),
      api.getContacts().catch(() => [] as Contact[]),
      api.getLiquidityHealth().catch(() => [] as ChannelLiquidityHealth[]),
      api.getPendingChannels().catch(() => [] as PendingChannel[]),
    ]).then(([ch, ct, lh, pend]) => {
      setChannels(ch); setContacts(ct); setHealth(lh);
      setClosingPubkeys(new Set(pend.filter((p: PendingChannel) => p.status === "closing").map((p: PendingChannel) => p.peer_pubkey)));
    });
  }

  async function handleCloseChannel() {
    if (!closeConfirm) return;
    setClosingChannel(closeConfirm.channelId);
    setCloseError(null);
    const channelId = closeConfirm.channelId;
    const feeRate = closeFeeRate;
    setCloseConfirm(null);
    setCloseFeeRate(undefined); // reset to Economy for next open
    try {
      const res = await api.treasuryCloseChannel({ channel_id: channelId, fee_rate: feeRate });
      setCloseResult({ channelId, txid: res.closing_txid });
      setTimeout(refreshChannels, 3000);
    } catch (e: any) {
      setCloseError(e.message ?? "Failed to close channel");
    } finally {
      setClosingChannel(null);
    }
  }

  const healthColor: Record<string, string> = {
    outbound_starved: "var(--red)",
    weak: "var(--yellow)",
    healthy: "var(--green)",
    inbound_heavy: "var(--blue)",
    critical: "var(--text-3)",
  };

  return (
    <div>
      {/* Close channel confirmation dialog */}
      {closeConfirm && (
        <div className="dialog-overlay">
          <div className="dialog-card">
            <div className="dialog-title">Close Channel?</div>
            <div className="dialog-body">
              This will cooperatively close the channel to <strong>{closeConfirm.peerName}</strong> ({closeConfirm.capacity.toLocaleString()} sats).
              Funds will return to your on-chain wallet after confirmation. This cannot be undone.
            </div>
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: "0.625rem", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 6 }}>
                On-chain fee rate
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  { label: "Economy", rate: undefined, desc: "~1 sat/vB", time: "1–3 hours", cost: "~192 sats" },
                  { label: "Normal", rate: 5, desc: "~5 sat/vB", time: "~30 min", cost: "~960 sats" },
                  { label: "Priority", rate: 15, desc: "~15 sat/vB", time: "~10 min", cost: "~2,885 sats" },
                ].map((opt) => {
                  const selected = closeFeeRate === opt.rate;
                  return (
                    <button
                      key={opt.label}
                      className={`btn ${selected ? "btn-primary" : "btn-outline"}`}
                      onClick={() => setCloseFeeRate(opt.rate)}
                      style={{ flex: "1 1 auto", fontSize: "0.7rem", padding: "6px 10px", textAlign: "left", lineHeight: 1.3 }}
                    >
                      <div style={{ fontWeight: 600 }}>{opt.label}</div>
                      <div style={{ fontSize: "0.65rem", opacity: 0.8 }}>{opt.desc}</div>
                      <div style={{ fontSize: "0.6rem", opacity: 0.7 }}>{opt.time} · {opt.cost}</div>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={() => { setCloseConfirm(null); setCloseFeeRate(undefined); }}>Cancel</button>
              <button className="btn btn-danger" onClick={handleCloseChannel}>Close Channel</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 24 }}>
        <h1 style={{ marginBottom: 4 }}>Channels</h1>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>
          {nodeRole === "treasury" ? "Channel lifecycle management" : "Active LND channel list"}
        </p>
      </div>

      {closeError && (
        <div className="alert warning" style={{ marginBottom: 16 }}>
          <span className="alert-icon">⚠</span>
          <div className="alert-body">
            <div className="alert-msg">{closeError}</div>
          </div>
        </div>
      )}

      {/* ─── Treasury: Purpose / State lane view ─────────────────────────── */}
      {nodeRole === "treasury" && !loading && channels.length > 0 && (() => {
        // ── Lane purpose (stable) ──────────────────────────────────────
        // Determined by explicit contact tags or known pubkeys. NEVER by balance.
        // Purpose reflects WHY the channel exists in the Bitcorn topology.
        type LanePurpose = "merchant_lane" | "farmer_lane" | "external_peer" | "unclassified";

        // ── Lane state (dynamic) ───────────────────────────────────────
        // Computed from balance. Interpretation depends on purpose.
        type MerchantState = "fresh" | "active" | "degrading" | "renew_soon" | "exhausted";
        type FarmerState = "open_for_receiving" | "earning" | "getting_full" | "full_needs_withdrawal";
        type ExternalState = "healthy" | "constrained" | "critical";
        type LaneState = MerchantState | FarmerState | ExternalState | "unknown";

        function merchantState(treasuryLocalPct: number): MerchantState {
          // As merchant spends → treasury local rises → channel depletes
          if (treasuryLocalPct < 30) return "fresh";
          if (treasuryLocalPct < 50) return "active";
          if (treasuryLocalPct < 70) return "degrading";
          if (treasuryLocalPct < 85) return "renew_soon";
          return "exhausted";
        }

        function farmerState(treasuryLocalPct: number): FarmerState {
          // As farmer earns → treasury local falls → farmer side fills
          if (treasuryLocalPct >= 70) return "open_for_receiving";
          if (treasuryLocalPct >= 30) return "earning";
          if (treasuryLocalPct >= 15) return "getting_full";
          return "full_needs_withdrawal";
        }

        function externalState(treasuryLocalPct: number): ExternalState {
          if (treasuryLocalPct >= 25 && treasuryLocalPct <= 75) return "healthy";
          if (treasuryLocalPct >= 15 && treasuryLocalPct <= 85) return "constrained";
          return "critical";
        }

        function stateLabel(state: LaneState): string {
          const labels: Record<string, string> = {
            fresh: "Fresh", active: "Active", degrading: "Degrading",
            renew_soon: "Renew Soon", exhausted: "Exhausted",
            open_for_receiving: "Receiving", earning: "Earning",
            getting_full: "Getting Full", full_needs_withdrawal: "Needs Withdrawal",
            healthy: "Healthy", constrained: "Constrained", critical: "Critical",
          };
          return labels[state] ?? state;
        }

        function stateBadge(state: LaneState): string {
          const green: LaneState[] = ["fresh", "active", "open_for_receiving", "earning", "healthy"];
          const amber: LaneState[] = ["degrading", "renew_soon", "getting_full", "constrained"];
          if (green.includes(state)) return "badge-green";
          if (amber.includes(state)) return "badge-amber";
          return "badge-red"; // exhausted, full_needs_withdrawal, critical
        }

        function stateColor(state: LaneState): string {
          const cls = stateBadge(state);
          if (cls === "badge-green") return "var(--green)";
          if (cls === "badge-amber") return "var(--amber)";
          return "var(--red)";
        }

        // ── Known external pubkeys ─────────────────────────────────────
        const externalPubkeys = new Set([
          "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f", // ACINQ
        ]);

        // ── Classify channels ──────────────────────────────────────────
        type LaneChannel = typeof channels[0] & {
          localPct: number; peerName: string;
          purpose: LanePurpose; state: LaneState;
        };

        const merchantLanes: LaneChannel[] = [];
        const farmerLanes: LaneChannel[] = [];
        const externalLanes: LaneChannel[] = [];
        const unclassifiedLanes: LaneChannel[] = [];

        for (const c of channels) {
          // Skip channels that are in the process of closing — they appear in the CLOSING section
          if (closingPubkeys.has(c.peer_pubkey)) continue;

          const contact = contacts.find((ct) => ct.pubkey === c.peer_pubkey);
          const tags = (contact?.tags ?? []).map((t) => t.toLowerCase());
          const localPct = c.capacity_sat > 0 ? Math.round((c.local_balance_sat / c.capacity_sat) * 100) : 0;
          const peerName = resolveContactName(c.peer_pubkey, contacts);

          // Purpose: explicit tags or known pubkeys — never balance
          let purpose: LanePurpose = "unclassified";
          let state: LaneState = "unknown";

          if (externalPubkeys.has(c.peer_pubkey) || tags.includes("external")) {
            purpose = "external_peer";
            state = externalState(localPct);
          } else if (tags.includes("merchant")) {
            purpose = "merchant_lane";
            state = merchantState(localPct);
          } else if (tags.includes("farmer")) {
            purpose = "farmer_lane";
            state = farmerState(localPct);
          }

          const entry: LaneChannel = { ...c, localPct, peerName, purpose, state };

          if (purpose === "merchant_lane") merchantLanes.push(entry);
          else if (purpose === "farmer_lane") farmerLanes.push(entry);
          else if (purpose === "external_peer") externalLanes.push(entry);
          else unclassifiedLanes.push(entry);
        }

        // Renewal alert: merchant lanes in renew_soon or exhausted
        const needsRenewal = merchantLanes.filter((c) => c.state === "renew_soon" || c.state === "exhausted");
        const projectedCapitalNeeded = needsRenewal.reduce((sum, c) => sum + c.capacity_sat, 0);

        // Shared close button renderer
        const closeBtn = (c: LaneChannel, label?: string) => (
          <>
            {c.active === 1 && closingChannel !== c.channel_id && closeResult?.channelId !== c.channel_id && (
              <button
                className="btn btn-outline btn-sm"
                onClick={() => setCloseConfirm({ channelId: c.channel_id, peerName: c.peerName, capacity: c.capacity_sat })}
              >
                {label ?? "Close"}
              </button>
            )}
            {closingChannel === c.channel_id && (
              <span style={{ fontSize: "0.75rem", color: "var(--amber)" }}>Closing…</span>
            )}
            {closeResult?.channelId === c.channel_id && (
              <span style={{ fontSize: "0.75rem", color: "var(--green)" }}>✓ Closing</span>
            )}
          </>
        );

        // Shared capacity formatter
        const fmtCap = (sats: number) =>
          sats >= 1_000_000
            ? `${(sats / 1_000_000).toFixed(sats % 1_000_000 === 0 ? 0 : 1)}M`
            : `${(sats / 1_000).toFixed(0)}k`;

        return (
          <>
            {/* ── Unclassified channels — prompt to tag ───────────────── */}
            {unclassifiedLanes.length > 0 && (
              <div className="alert info" style={{ marginBottom: 16 }}>
                <span className="alert-icon">◈</span>
                <div className="alert-body">
                  <div className="alert-type">{unclassifiedLanes.length} Unclassified Channel{unclassifiedLanes.length > 1 ? "s" : ""}</div>
                  <div className="alert-msg">
                    {unclassifiedLanes.map((c) => c.peerName).join(", ")} — tag as
                    <strong> merchant</strong> or <strong>farmer</strong> in Contacts to classify.
                  </div>
                </div>
              </div>
            )}

            {/* ── Projected Capital Needs ─────────────────────────────── */}
            {needsRenewal.length > 0 && (
              <div className="alert warning" style={{ marginBottom: 16 }}>
                <span className="alert-icon">⚠</span>
                <div className="alert-body">
                  <div className="alert-type">Merchant Channel Renewals Needed</div>
                  <div className="alert-msg">
                    {needsRenewal.length} merchant channel{needsRenewal.length > 1 ? "s" : ""} approaching exhaustion.
                    Estimated on-chain capital needed: {projectedCapitalNeeded.toLocaleString()} sats.
                  </div>
                </div>
              </div>
            )}

            {/* ── Shared column widths for consistent alignment ────── */}
            {/* All lane tables use: Name(auto) | Capacity(90px) | Detail(120px) | Gauge(140px) | State(110px) | Action(80px) */}

            {/* ── Merchant Lanes ──────────────────────────────────────── */}
            <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
              <div className="panel-header">
                <span className="panel-title"><span className="icon">↗</span>Merchant Lanes</span>
                <span className="badge badge-muted">{merchantLanes.length}</span>
              </div>
              {merchantLanes.length === 0 ? (
                <div className="empty-state">No merchant channels. Tag contacts as "merchant" to classify.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table" style={{ tableLayout: "fixed", width: "100%" }}>
                    <colgroup>
                      <col style={{ width: "25%" }} />
                      <col style={{ width: "12%" }} />
                      <col style={{ width: "15%" }} />
                      <col style={{ width: "20%" }} />
                      <col style={{ width: "15%" }} />
                      <col style={{ width: "13%" }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Merchant</th>
                        <th>Capacity</th>
                        <th style={{ textAlign: "right" }}>Forwarded</th>
                        <th>Forwarding Left</th>
                        <th>State</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {merchantLanes.map((c) => {
                        const fwdLeftPct = 100 - c.localPct;
                        const color = stateColor(c.state);
                        const actionLabel = c.state === "exhausted" ? "Renew Now" : c.state === "renew_soon" ? "Renew Soon" : "Close";
                        return (
                          <tr key={c.channel_id}>
                            <td style={{ fontWeight: 500 }}>{c.peerName}</td>
                            <td className="td-mono">{fmtCap(c.capacity_sat)}</td>
                            <td className="td-num" style={{ fontFamily: "var(--mono)" }}>
                              {c.remote_balance_sat.toLocaleString()}
                            </td>
                            <td>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{ width: 60, height: 6, borderRadius: 3, background: "var(--bg-3)", overflow: "hidden", flexShrink: 0 }}>
                                  <div style={{ height: "100%", width: `${fwdLeftPct}%`, background: color, borderRadius: 3 }} />
                                </div>
                                <span style={{ fontFamily: "var(--mono)", color, fontSize: "0.75rem" }}>{fwdLeftPct}%</span>
                              </div>
                            </td>
                            <td>
                              <span className={`badge ${stateBadge(c.state)}`}>{stateLabel(c.state)}</span>
                            </td>
                            <td>{closeBtn(c, actionLabel)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Farmer Lanes ────────────────────────────────────────── */}
            <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
              <div className="panel-header">
                <span className="panel-title"><span className="icon">↙</span>Farmer Lanes</span>
                <span className="badge badge-muted">{farmerLanes.length}</span>
              </div>
              {farmerLanes.length === 0 ? (
                <div className="empty-state">No farmer channels. Tag contacts as "farmer" to classify.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table" style={{ tableLayout: "fixed", width: "100%" }}>
                    <colgroup>
                      <col style={{ width: "25%" }} />
                      <col style={{ width: "12%" }} />
                      <col style={{ width: "15%" }} />
                      <col style={{ width: "20%" }} />
                      <col style={{ width: "15%" }} />
                      <col style={{ width: "13%" }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Farmer</th>
                        <th>Capacity</th>
                        <th style={{ textAlign: "right" }}>Accumulated</th>
                        <th>Receive Capacity</th>
                        <th>State</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {farmerLanes.map((c) => {
                        const accumulated = c.remote_balance_sat;
                        const recvPct = c.localPct;
                        const color = stateColor(c.state);
                        return (
                          <tr key={c.channel_id}>
                            <td style={{ fontWeight: 500 }}>{c.peerName}</td>
                            <td className="td-mono">{fmtCap(c.capacity_sat)}</td>
                            <td className="td-num" style={{ fontFamily: "var(--mono)" }}>
                              {accumulated.toLocaleString()}
                            </td>
                            <td>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{ width: 60, height: 6, borderRadius: 3, background: "var(--bg-3)", overflow: "hidden", flexShrink: 0 }}>
                                  <div style={{ height: "100%", width: `${recvPct}%`, background: color, borderRadius: 3 }} />
                                </div>
                                <span style={{ fontFamily: "var(--mono)", color, fontSize: "0.75rem" }}>{recvPct}%</span>
                              </div>
                            </td>
                            <td>
                              <span className={`badge ${stateBadge(c.state)}`}>{stateLabel(c.state)}</span>
                            </td>
                            <td>{closeBtn(c)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── External Routing Peers ──────────────────────────────── */}
            {externalLanes.length > 0 && (
              <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
                <div className="panel-header">
                  <span className="panel-title"><span className="icon">⟐</span>External Routing Peers</span>
                  <span className="badge badge-muted">{externalLanes.length}</span>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table" style={{ tableLayout: "fixed", width: "100%" }}>
                    <colgroup>
                      <col style={{ width: "25%" }} />
                      <col style={{ width: "12%" }} />
                      <col style={{ width: "15%" }} />
                      <col style={{ width: "20%" }} />
                      <col style={{ width: "15%" }} />
                      <col style={{ width: "13%" }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Peer</th>
                        <th>Capacity</th>
                        <th style={{ textAlign: "right" }}>Local</th>
                        <th>Balance</th>
                        <th>State</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {externalLanes.map((c) => {
                        const color = stateColor(c.state);
                        return (
                          <tr key={c.channel_id}>
                            <td style={{ fontWeight: 500 }}>{c.peerName}</td>
                            <td className="td-mono">{fmtCap(c.capacity_sat)}</td>
                            <td className="td-num" style={{ fontFamily: "var(--mono)" }}>
                              {c.local_balance_sat.toLocaleString()}
                            </td>
                            <td>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{ width: 60, height: 6, borderRadius: 3, background: "var(--bg-3)", overflow: "hidden", flexShrink: 0 }}>
                                  <div style={{ height: "100%", width: `${c.localPct}%`, background: color, borderRadius: 3 }} />
                                </div>
                                <span style={{ fontFamily: "var(--mono)", color, fontSize: "0.75rem" }}>{c.localPct}%</span>
                              </div>
                            </td>
                            <td>
                              <span className={`badge ${stateBadge(c.state)}`}>{stateLabel(c.state)}</span>
                            </td>
                            <td>{closeBtn(c)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Unclassified Channels table ────────────────────────── */}
            {unclassifiedLanes.length > 0 && (
              <div className="panel ops fade-in" style={{ marginBottom: 16 }}>
                <div className="panel-header">
                  <span className="panel-title"><span className="icon">?</span>Unclassified</span>
                  <span className="badge badge-muted">{unclassifiedLanes.length}</span>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table" style={{ tableLayout: "fixed", width: "100%" }}>
                    <colgroup>
                      <col style={{ width: "25%" }} />
                      <col style={{ width: "12%" }} />
                      <col style={{ width: "15%" }} />
                      <col style={{ width: "20%" }} />
                      <col style={{ width: "15%" }} />
                      <col style={{ width: "13%" }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Peer</th>
                        <th>Capacity</th>
                        <th style={{ textAlign: "right" }}>Local</th>
                        <th>Balance</th>
                        <th></th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unclassifiedLanes.map((c) => (
                        <tr key={c.channel_id}>
                          <td style={{ fontWeight: 500 }}>{c.peerName}</td>
                          <td className="td-mono">{fmtCap(c.capacity_sat)}</td>
                          <td className="td-num" style={{ fontFamily: "var(--mono)" }}>
                            {c.local_balance_sat.toLocaleString()}
                          </td>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <div style={{ width: 60, height: 6, borderRadius: 3, background: "var(--bg-3)", overflow: "hidden", flexShrink: 0 }}>
                                <div style={{ height: "100%", width: `${c.localPct}%`, background: "var(--text-3)", borderRadius: 3 }} />
                              </div>
                              <span style={{ fontFamily: "var(--mono)", color: "var(--text-3)", fontSize: "0.75rem" }}>{c.localPct}%</span>
                            </div>
                          </td>
                          <td></td>
                          <td>{closeBtn(c)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* ─── Member / loading / empty: original channel list ─────────────── */}
      {(nodeRole !== "treasury" || loading || channels.length === 0) && (
      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title">
            <span className="icon">◈</span>All Channels
          </span>
          {!loading && channels.length > 0 && (
            <span className="badge badge-amber">{channels.length}</span>
          )}
        </div>
        {loading ? (
          <div
            className="panel-body"
            style={{ display: "flex", flexDirection: "column", gap: 12 }}
          >
            {[1, 2, 3].map((i) => (
              <div key={i} className="channel-card">
                <div className="loading-shimmer" style={{ height: 14, width: "50%", marginBottom: 8 }} />
                <div className="loading-shimmer" style={{ height: 8, width: "100%", borderRadius: 4, marginBottom: 8 }} />
                <div className="loading-shimmer" style={{ height: 12, width: "70%" }} />
              </div>
            ))}
          </div>
        ) : channels.length === 0 ? (
          <div className="empty-state">No channels found.</div>
        ) : (
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {channels.map((c) => {
              const localPct = c.capacity_sat > 0 ? (c.local_balance_sat / c.capacity_sat) * 100 : 0;
              const remotePct = c.capacity_sat > 0 ? (c.remote_balance_sat / c.capacity_sat) * 100 : 0;
              const h = health.find((x) => x.channel_id === c.channel_id);
              const isTreasury = c.peer_pubkey === TREASURY_PUBKEY;
              const capStatus = classifyCapacity(c.capacity_sat, isTreasury);
              const upgradeSize = recommendedUpgradeSize(c.capacity_sat, isTreasury);
              const isExpanded = expandedHint === c.channel_id;
              return (
                <div key={c.channel_id} className="channel-card">
                  <div className="channel-card-top">
                    <span className="channel-peer mono">
                      {resolveContactName(c.peer_pubkey, contacts)}
                    </span>
                    {capStatus === "undersized" && (
                      <span className="badge badge-red">undersized</span>
                    )}
                    {c.active ? (
                      <span className="badge badge-green">active</span>
                    ) : (
                      <span className="badge badge-muted">inactive</span>
                    )}
                  </div>
                  <div className="channel-capacity mono">
                    {c.capacity_sat.toLocaleString()} sats
                  </div>
                  <div className="channel-balance-bar">
                    <div
                      className="channel-balance-local"
                      style={{ width: `${localPct}%` }}
                    />
                  </div>
                  <div className="channel-balance-labels">
                    <span className="channel-label-local">
                      <span className="channel-dot" style={{ background: "var(--green)" }} />
                      Local: {c.local_balance_sat.toLocaleString()}
                      <span className="channel-pct">({localPct.toFixed(0)}%)</span>
                    </span>
                    <span className="channel-label-remote">
                      <span className="channel-dot" style={{ background: "var(--red)" }} />
                      Remote: {c.remote_balance_sat.toLocaleString()}
                      <span className="channel-pct">({remotePct.toFixed(0)}%)</span>
                    </span>
                  </div>
                  {capStatus === "undersized" && (
                    <div style={{ marginTop: 6 }}>
                      <div
                        onClick={() => setExpandedHint(isExpanded ? null : c.channel_id)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          cursor: "pointer",
                          fontSize: "0.75rem",
                          color: "var(--yellow)",
                          fontFamily: "var(--mono)",
                        }}
                      >
                        <span>⚠</span>
                        <span>Upgrade recommended → {upgradeSize.toLocaleString()} sats</span>
                        <span style={{ fontSize: "0.625rem", color: "var(--text-3)", marginLeft: 4 }}>
                          {isExpanded ? "▲" : "▼"}
                        </span>
                      </div>
                      {isExpanded && (
                        <div
                          style={{
                            marginTop: 6,
                            padding: "8px 12px",
                            background: "var(--bg-3)",
                            border: "1px solid var(--border)",
                            borderRadius: 6,
                            fontSize: "0.75rem",
                            color: "var(--text-2)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                          }}
                        >
                          <div>
                            <span style={{ color: "var(--text-3)" }}>Current capacity: </span>
                            <span style={{ fontFamily: "var(--mono)" }}>{c.capacity_sat.toLocaleString()} sats</span>
                          </div>
                          <div>
                            <span style={{ color: "var(--text-3)" }}>Recommended: </span>
                            <span style={{ fontFamily: "var(--mono)", color: "var(--amber)" }}>{upgradeSize.toLocaleString()} sats</span>
                          </div>
                          <div style={{ color: "var(--text-3)", fontSize: "0.6875rem" }}>
                            {isTreasury
                              ? "Treasury channels carry all routed payments. Open a larger channel to increase routing capacity."
                              : "Open a larger channel alongside this one to improve routing diversity."}
                          </div>
                          <button
                            className="btn btn-outline btn-sm"
                            style={{ alignSelf: "flex-start", marginTop: 4 }}
                            onClick={() => {
                              if (isTreasury) {
                                navigate(`/dashboard?upgrade_capacity=${upgradeSize}`);
                              } else {
                                const el = document.getElementById("recommended-peers-panel");
                                if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                              }
                            }}
                          >
                            {isTreasury ? "Upgrade Treasury Channel →" : "View Recommended Peers →"}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* Treasury: Open Channel panel */}
      {nodeRole === "treasury" && <TreasuryOpenChannelPanel contacts={contacts} onChannelOpened={() => {
        // Refresh channel list after opening
        Promise.all([
          fetch(`${API_BASE}/api/channels`).then((r) => r.json()),
          api.getContacts().catch(() => [] as Contact[]),
        ]).then(([ch, ct]) => { setChannels(ch); setContacts(ct); });
      }} />}

      {/* RecommendedPeersPanel removed — hub-and-spoke model uses intentionally
         unbalanced merchant/farmer lanes; members don't need external peers */}
    </div>
  );
}

// ─── Treasury Open Channel ────────────────────────────────────────────────

const TREASURY_CHANNEL_PRESETS = [1_000_000, 5_000_000, 10_000_000];

function TreasuryOpenChannelPanel({ contacts, onChannelOpened }: { contacts: Contact[]; onChannelOpened: () => void }) {
  const [selectedPubkey, setSelectedPubkey] = useState("");
  const [manualPubkey, setManualPubkey] = useState("");
  const [useManual, setUseManual] = useState(false);
  const [capacity, setCapacity] = useState(5_000_000);
  const [feeRate, setFeeRate] = useState<number | undefined>(undefined); // undefined = LND default
  const [opening, setOpening] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; txid: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [pending, setPending] = useState<PendingChannel[]>([]);

  const activePubkey = useManual ? manualPubkey.trim() : selectedPubkey;
  const selectedContact = contacts.find((c) => c.pubkey === selectedPubkey);

  // Poll pending channels every 15s
  useEffect(() => {
    const load = () => api.getPendingChannels().then(setPending).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  async function handleOpen() {
    if (!activePubkey) { setError(useManual ? "Peer pubkey is required" : "Select a contact"); return; }
    if (capacity < 100_000) { setError("Minimum 100,000 sats"); return; }
    setOpening(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.treasuryOpenChannel({
        peer_pubkey: activePubkey,
        capacity_sats: capacity,
        ...(feeRate ? { fee_rate: feeRate } : {}),
      });
      setResult({ ok: true, txid: res.funding_txid });
      // Refresh pending list immediately
      api.getPendingChannels().then(setPending).catch(() => {});
      onChannelOpened();
    } catch (e: any) {
      setError(e.message ?? "Failed to open channel");
    } finally {
      setOpening(false);
    }
  }

  function handleReset() {
    setSelectedPubkey("");
    setManualPubkey("");
    setUseManual(false);
    setCapacity(5_000_000);
    setResult(null);
    setError(null);
  }

  return (
    <div className="panel ops fade-in" style={{ marginTop: 16 }}>
      <div className="panel-header">
        <span className="panel-title">
          <span className="icon">+</span>Open Channel
        </span>
        {!showForm && !result && (
          <button className="btn btn-outline btn-sm" onClick={() => setShowForm(true)}>
            New Channel
          </button>
        )}
      </div>

      {!showForm && !result && (() => {
        const openingChannels = pending.filter((p) => p.status === "opening");
        const closingChannels = pending.filter((p) => p.status === "closing");
        const hasPending = openingChannels.length > 0 || closingChannels.length > 0;

        return (
          <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {!hasPending && (
              <div className="empty-state" style={{ padding: "16px 20px" }}>
                Open a new channel to a peer to expand routing capacity.
              </div>
            )}
            {openingChannels.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: "0.625rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 2 }}>
                  Opening ({openingChannels.length})
                </div>
                {openingChannels.map((p, i) => (
                  <div
                    key={`open-${p.peer_pubkey}-${i}`}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "8px 12px", background: "var(--bg-3)", border: "1px solid var(--border)", borderRadius: 6,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "0.875rem", fontWeight: 500 }}>{resolveContactName(p.peer_pubkey, contacts)}</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>{p.capacity_sat.toLocaleString()} sats</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="loading-shimmer" style={{ width: 10, height: 10, borderRadius: "50%" }} />
                      <span className="badge badge-amber">opening</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {closingChannels.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: "0.625rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-3)", marginBottom: 2 }}>
                  Closing ({closingChannels.length})
                </div>
                {closingChannels.map((p, i) => (
                  <div
                    key={`close-${p.peer_pubkey}-${i}`}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "8px 12px", background: "var(--bg-3)", border: "1px solid var(--border)", borderRadius: 6,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "0.875rem", fontWeight: 500 }}>{resolveContactName(p.peer_pubkey, contacts)}</div>
                      <div style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>{p.capacity_sat.toLocaleString()} sats</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="loading-shimmer" style={{ width: 10, height: 10, borderRadius: "50%" }} />
                      <span className="badge badge-red">closing</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {result && (
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="alert healthy" style={{ marginBottom: 0 }}>
            <span className="alert-icon">✓</span>
            <div className="alert-body">
              <div className="alert-type">Channel opening submitted</div>
              <div className="alert-msg">
                Channel will become active after 1–3 on-chain confirmations.
              </div>
            </div>
          </div>
          {result.txid && (
            <div
              style={{
                background: "var(--bg-3)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "8px 12px",
                fontFamily: "var(--mono)",
                fontSize: "0.75rem",
                wordBreak: "break-all",
                color: "var(--text-2)",
              }}
            >
              {result.txid}
            </div>
          )}
          <button className="btn btn-outline btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => { handleReset(); setShowForm(true); }}>
            Open Another
          </button>
        </div>
      )}

      {showForm && !result && (
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Peer selection */}
          <div>
            <label className="form-label">Peer</label>
            {!useManual ? (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {contacts.length > 0 ? (
                    contacts.map((c) => (
                      <button
                        key={c.pubkey}
                        onClick={() => setSelectedPubkey(c.pubkey)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "8px 12px",
                          background: selectedPubkey === c.pubkey ? "var(--amber-glow)" : "var(--bg-3)",
                          border: `1px solid ${selectedPubkey === c.pubkey ? "var(--amber-dim)" : "var(--border)"}`,
                          borderRadius: 6,
                          cursor: "pointer",
                          textAlign: "left",
                          width: "100%",
                          color: "var(--text)",
                          fontFamily: "inherit",
                          fontSize: "inherit",
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{c.name}</div>
                          <div style={{ fontFamily: "var(--mono)", fontSize: "0.6875rem", color: "var(--text-3)" }}>
                            {c.pubkey.slice(0, 16)}…{c.pubkey.slice(-8)}
                          </div>
                        </div>
                        {selectedPubkey === c.pubkey && (
                          <span style={{ color: "var(--amber)", fontSize: "0.875rem" }}>✓</span>
                        )}
                      </button>
                    ))
                  ) : (
                    <div style={{ color: "var(--text-3)", fontSize: "0.8125rem", padding: "8px 0" }}>
                      No contacts yet — add peers in the Contacts page, or enter a pubkey manually.
                    </div>
                  )}
                </div>
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: "0.75rem", padding: "4px 0", marginTop: 6 }}
                  onClick={() => setUseManual(true)}
                >
                  Enter pubkey manually
                </button>
              </>
            ) : (
              <>
                <input
                  type="text"
                  className="form-input"
                  value={manualPubkey}
                  onChange={(e) => setManualPubkey(e.target.value)}
                  placeholder="03..."
                  style={{ fontFamily: "var(--mono)", fontSize: "0.8125rem" }}
                />
                {contacts.length > 0 && (
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: "0.75rem", padding: "4px 0", marginTop: 6 }}
                    onClick={() => { setUseManual(false); setManualPubkey(""); }}
                  >
                    Select from contacts
                  </button>
                )}
              </>
            )}
          </div>

          {/* Capacity */}
          <div>
            <label className="form-label">Channel Capacity (sats)</label>
            <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
              {TREASURY_CHANNEL_PRESETS.map((preset) => (
                <button
                  key={preset}
                  className={`btn ${capacity === preset ? "btn-primary" : "btn-outline"}`}
                  style={{ fontSize: "0.75rem", padding: "4px 10px", flex: "1 1 auto" }}
                  onClick={() => setCapacity(preset)}
                >
                  {preset >= 1_000_000
                    ? `${(preset / 1_000_000).toFixed(preset % 1_000_000 === 0 ? 0 : 1)}M`
                    : `${(preset / 1_000).toFixed(0)}k`}
                </button>
              ))}
            </div>
            <div style={{ position: "relative" }}>
              <input
                type="text"
                inputMode="numeric"
                className="form-input"
                value={capacity > 0 ? capacity.toLocaleString() : ""}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^0-9]/g, "");
                  if (raw === "") { setCapacity(0); return; }
                  setCapacity(Number(raw));
                }}
                style={{ paddingRight: 42 }}
              />
              <span style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                fontSize: "0.75rem", color: "var(--text-3)", fontFamily: "var(--mono)", pointerEvents: "none",
              }}>
                sats
              </span>
            </div>
            <p className="text-dim" style={{ fontSize: "0.6875rem", marginTop: 4 }}>
              Minimum: 100,000 sats. Subject to capital guardrails and on-chain balance.
            </p>
            {capacity > 0 && capacity < 100_000 && (
              <div style={{ fontSize: "0.75rem", color: "var(--red)", marginTop: 4 }}>
                Channel capacity must be at least 100,000 sats.
              </div>
            )}
          </div>

          {/* Fee rate selector */}
          <div>
            <label className="form-label">Confirmation Speed</label>
            <div style={{ display: "flex", gap: 6 }}>
              {([
                { label: "Economy", rate: undefined, desc: "~1 sat/vB", time: "1–3 hours", cost: "~155 sats" },
                { label: "Normal", rate: 5, desc: "~5 sat/vB", time: "~30 min", cost: "~770 sats" },
                { label: "Priority", rate: 15, desc: "~15 sat/vB", time: "~10 min", cost: "~2,300 sats" },
              ] as const).map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => setFeeRate(opt.rate)}
                  style={{
                    flex: 1, padding: "8px 6px", borderRadius: 8, cursor: "pointer",
                    border: `2px solid ${feeRate === opt.rate ? "var(--amber)" : "var(--border)"}`,
                    background: feeRate === opt.rate ? "color-mix(in srgb, var(--amber) 10%, var(--bg-2))" : "var(--bg-2)",
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: "0.8125rem", fontWeight: 600, color: feeRate === opt.rate ? "var(--amber)" : "var(--text)" }}>
                    {opt.label}
                  </div>
                  <div style={{ fontSize: "0.6875rem", color: feeRate === opt.rate ? "var(--amber)" : "var(--text-2)" }}>
                    {opt.time}
                  </div>
                  <div style={{ fontSize: "0.625rem", color: "var(--text-3)", fontFamily: "var(--mono)" }}>
                    {opt.cost}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {error && <div style={{ color: "var(--red)", fontSize: "0.8125rem" }}>{error}</div>}

          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={handleOpen}
              disabled={opening || !activePubkey}
            >
              {opening
                ? "Opening..."
                : `Open ${capacity.toLocaleString()} sat channel${selectedContact ? ` to ${selectedContact.name}` : ""}`}
            </button>
            <button className="btn btn-outline" onClick={() => { handleReset(); setShowForm(false); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function LiquidityPage() {
  return <Liquidity />;
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
