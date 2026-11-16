// The Settings page's role panel — markup only, moved out of App.tsx
// (member-first-run-ui separation slice, B.3, ruling (b)). Its load effect and
// save handler are useChannelRole.ts. Rendered by SettingsPage for members.
//
// The role is a Choice (member-first-run-ui slice 1). Choosing (or arrowing)
// only changes the draft; "Save role" writes it, so moving through the options
// never saves.

import { useEffect, useState } from "react";
import { Choice } from "../Choice";
import { useChannelRole } from "./useChannelRole";

type Role = "merchant" | "farmer";

export default function ChannelRolePanel() {
  const { role, loading, saving, handleSetRole } = useChannelRole();
  const [draft, setDraft] = useState<Role | null>(null);
  useEffect(() => { setDraft(role === "unknown" ? null : role); }, [role]);

  const roles: { value: Role; icon: string; label: string; desc: string }[] = [
    { value: "merchant", icon: "↗", label: "Merchant", desc: "You send payments through the hub — outbound capacity matters most" },
    { value: "farmer", icon: "↙", label: "Farmer", desc: "You receive earnings through the hub — receiving capacity matters most" },
  ];
  const unsaved = draft !== null && draft !== role;

  return (
    <div className="panel ops" style={{ marginTop: 12 }}>
      <div className="panel-header">
        <span className="panel-title" id="channel-role-title"><span className="icon" aria-hidden="true">◈</span>Channel Role</span>
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
            <Choice
              name="channel-role"
              labelledBy="channel-role-title"
              layout="column"
              busy={saving}
              value={draft}
              onChange={setDraft}
              options={roles.map((r) => ({ value: r.value, icon: r.icon, label: r.label, description: r.desc }))}
            />
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                className="btn btn-primary"
                onClick={() => draft && handleSetRole(draft)}
                disabled={saving || !unsaved}
              >
                Save role
              </button>
              {role !== "unknown" && (
                <button
                  className="btn btn-ghost"
                  style={{ fontSize: "0.75rem", color: "var(--text-3)" }}
                  onClick={() => handleSetRole("unknown")}
                  disabled={saving}
                >
                  Clear role selection
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
