import React, { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import "./styles.css";
import bitcornLogo from "./assets/bitcorn-logo.svg";
import { api, type NodeInfo, type TreasuryFeePolicy, type Contact, type ChannelLiquidityHealth, type RecommendedPeer, resolveContactName, truncPubkey } from "./api/client";
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
    { to: "/channels", icon: "◈", label: "Channels" },
    { to: "/payments", icon: "↗", label: "Payments" },
    { to: "/liquidity", icon: "≋", label: "Liquidity" },
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
                  to="/withdraw"
                  className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
                  onClick={onClose}
                >
                  <span className="icon">↗</span>
                  Withdraw Bitcoin
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
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/payments" element={<Payments title="Payments" />} />
          <Route path="/liquidity" element={<LiquidityPage />} />
          <Route path="/deposit" element={<DepositBitcoin />} />
          <Route path="/withdraw" element={<WithdrawBitcoin />} />
          <Route path="/settings" element={<SettingsPage isTreasury />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

// ─── Member AppShell ───────────────────────────────────────────────────────

function MemberSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navItems = [
    { to: "/dashboard", icon: "▤", label: "My Dashboard" },
    { to: "/charts", icon: "⟠", label: "Charts" },
    { to: "/contacts", icon: "☰", label: "Contacts" },
    { to: "/channels", icon: "◈", label: "My Channels" },
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
                  to="/withdraw"
                  className={({ isActive }) => `sidebar-item ${isActive ? "active" : ""}`}
                  onClick={onClose}
                >
                  <span className="icon">↗</span>
                  Withdraw Bitcoin
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

  useEffect(() => {
    const load = () => api.getNode().then(setNode).catch(() => {});
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app-shell">
      <Topbar node={node} role="MEMBER" onMenuToggle={() => setMenuOpen((v) => !v)} />
      <div className={`sidebar-overlay ${menuOpen ? "visible" : ""}`} onClick={() => setMenuOpen(false)} />
      <MemberSidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <main className="main-content">
        <Routes>
          <Route path="/dashboard" element={<MemberDashboard />} />
          <Route path="/charts" element={<Charts />} />
          <Route path="/contacts" element={<Contacts />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/payments" element={<Payments title="My Payments" />} />
          <Route path="/deposit" element={<DepositBitcoin />} />
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
    <div className="fade-in">
      <h1 style={{ marginBottom: 4 }}>Settings</h1>
      <p style={{ color: "var(--text-3)", fontSize: "0.875rem", marginBottom: 28 }}>
        Preferences for your BitCorn node
      </p>

      <div className="panel">
        <div className="panel-header">
          <span className="panel-title"><span className="icon">◐</span>Appearance</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {options.map((opt) => (
            <button
              key={opt.value}
              className={`theme-option ${theme === opt.value ? "selected" : ""}`}
              onClick={() => changeTheme(opt.value)}
            >
              <span style={{ fontSize: "1.25rem" }}>{opt.icon}</span>
              <div>
                <div style={{ fontWeight: 600 }}>{opt.label}</div>
                <div style={{ fontSize: "0.75rem", color: theme === opt.value ? "var(--amber-dim)" : "var(--text-3)" }}>
                  {opt.desc}
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">A</span>Text Size</span>
          <span className="badge badge-muted">{Math.round(parseFloat(textScale) * 100)}%</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 6 }}>
            {TEXT_SCALE_PRESETS.map((preset) => (
              <button
                key={preset.value}
                className={`btn ${textScale === preset.value ? "btn-primary" : "btn-outline"}`}
                style={{ flex: 1, fontSize: "0.75rem", padding: "6px 8px" }}
                onClick={() => changeTextScale(preset.value)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: "0.75rem", color: "var(--text-3)", fontFamily: "var(--mono)", whiteSpace: "nowrap" }}>A</span>
            <input
              type="range"
              min="0.75"
              max="1.5"
              step="0.05"
              value={textScale}
              onChange={(e) => changeTextScale(e.target.value)}
              style={{ flex: 1, accentColor: "var(--amber)" }}
            />
            <span style={{ fontSize: "1.125rem", color: "var(--text-3)", fontFamily: "var(--mono)", whiteSpace: "nowrap" }}>A</span>
          </div>
          <div style={{ fontSize: "0.75rem", color: "var(--text-3)" }}>
            Scales all text from the default 14px base. Preview changes in real time.
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <span className="panel-title"><span className="icon">F</span>Font</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {FONT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className={`theme-option ${fontId === preset.id ? "selected" : ""}`}
              onClick={() => changeFont(preset.id)}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{preset.label}</div>
                <div
                  style={{
                    fontSize: "0.8125rem",
                    fontFamily: preset.sans,
                    color: fontId === preset.id ? "var(--amber-dim)" : "var(--text-3)",
                    marginTop: 2,
                  }}
                >
                  {preset.preview}
                </div>
                <div
                  style={{
                    fontSize: "0.75rem",
                    fontFamily: preset.mono,
                    color: fontId === preset.id ? "var(--amber-dim)" : "var(--text-3)",
                    marginTop: 2,
                  }}
                >
                  0123456789 sats
                </div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {isTreasury && (
        <div className="panel" style={{ marginTop: 20 }}>
          <div className="panel-header">
            <span className="panel-title"><span className="icon">⚙</span>Treasury</span>
          </div>
          <div className="panel-body">
            <button
              className="btn btn-outline"
              onClick={() => {
                localStorage.removeItem("bitcorn_setup_done");
                navigate("/setup");
              }}
            >
              Re-run Setup Wizard
            </button>
            <p style={{ fontSize: "0.75rem", color: "var(--text-3)", marginTop: 8 }}>
              Resets the setup flag and walks through initial configuration again.
            </p>
          </div>
        </div>
      )}
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

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/api/channels`).then((r) => r.json()),
      api.getContacts().catch(() => [] as Contact[]),
      api.getLiquidityHealth().catch(() => [] as ChannelLiquidityHealth[]),
    ]).then(([ch, ct, lh]) => {
      setChannels(ch);
      setContacts(ct);
      setHealth(lh);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const healthColor: Record<string, string> = {
    outbound_starved: "var(--red)",
    weak: "var(--yellow)",
    healthy: "var(--green)",
    inbound_heavy: "var(--blue)",
    critical: "var(--text-3)",
  };

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
                    {h && (
                      <span
                        className="badge"
                        style={{
                          background: `${healthColor[h.health_classification] ?? "var(--text-3)"}22`,
                          color: healthColor[h.health_classification] ?? "var(--text-3)",
                        }}
                      >
                        {h.health_classification.replace(/_/g, " ")}
                      </span>
                    )}
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

      <RecommendedPeersPanel />
    </div>
  );
}

function LiquidityPage() {
  return <MemberLiquidity />;
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
