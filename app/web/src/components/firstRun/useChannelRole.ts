// ChannelRolePanel's behaviour — the load effect and the save handler, moved as
// they are out of App.tsx (member-first-run-ui separation slice, B.3, ruling (b)).
//
// Carried as they are, NOT fixed (B): the load error and the save error are
// both swallowed.

import { useEffect, useState } from "react";
import { api } from "../../api/client";

export function useChannelRole() {
  const [role, setRole] = useState<"unknown" | "merchant" | "farmer">("unknown");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getMemberLiquidityStatus()
      .then((d) => {
        const r = d.channelRole ?? d.classification?.channelRole; // SH9, as in MemberShell
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

  return { role, loading, saving, handleSetRole };
}
