// The Settings page's role panel — markup only, moved out of App.tsx
// (member-first-run-ui separation slice, B.3, ruling (b)). Its load effect and
// save handler are useChannelRole.ts. Rendered by SettingsPage for members.

import { useChannelRole } from "./useChannelRole";

export default function ChannelRolePanel() {
  const { role, loading, saving, handleSetRole } = useChannelRole();

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
                  <div style={{ fontSize: "0.75rem", color: role === opt.value ? "var(--text-2)" : "var(--text-3)" }}>
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
