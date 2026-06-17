// AutoPaySection — member-facing subscription auto-pay opt-in control.
//
// Source: bitcorn-research/specs/2026-06-12-subscription-auto-pay-
// implementation.md §7A. Rendered inside ProfilePanel, below the alias
// controls. Member view only.
//
// A thin renderer over api.getAutoPayConfig()/setAutoPay(): a toggle, the
// always-visible standing-authorization status (decision §7 — the member must
// always be able to see auto-pay is on, the amount, and that it fires on
// lapse), and an expandable history. Off by default.

import { useCallback, useEffect, useState } from "react";
import { api, type AutoPayConfig, type AutoPayAlert } from "../api/client";
import { formatDistanceToNow } from "date-fns";

const sats = (n: number | null | undefined) =>
  typeof n === "number" ? `${new Intl.NumberFormat("en-US").format(n)} sats` : "—";

type Save = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

export default function AutoPaySection() {
  const [cfg, setCfg] = useState<AutoPayConfig | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [save, setSave] = useState<Save>({ kind: "idle" });
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<AutoPayAlert[] | null>(null);

  const load = useCallback(async () => {
    try {
      setCfg(await api.getAutoPayConfig());
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saving = save.kind === "saving";

  async function onToggle(next: boolean) {
    if (saving) return;
    setSave({ kind: "saving" });
    try {
      await api.setAutoPay(next);
      await load();
      setSave({ kind: "idle" });
    } catch (e: any) {
      setSave({ kind: "error", message: e?.detail ?? e?.message ?? "Could not update auto-pay." });
    }
  }

  async function onToggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next && history === null) {
      try {
        setHistory(await api.getAutoPayHistory());
      } catch {
        setHistory([]);
      }
    }
  }

  const enabled = cfg?.enabled ?? false;

  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "0.875rem", fontWeight: 600 }}>Auto-renew subscription</span>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: saving ? "wait" : "pointer" }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving || !cfg}
            onChange={(e) => void onToggle(e.target.checked)}
          />
          <span style={{ fontSize: "0.8125rem", color: enabled ? "var(--green, #22c55e)" : "var(--text-3)" }}>
            {enabled ? "On" : "Off"}
          </span>
        </label>
      </div>

      {loadFailed && (
        <p style={{ color: "var(--text-3)", fontSize: "0.8125rem", margin: "6px 0 0" }}>
          Couldn't load auto-pay settings. It will retry when you reload.
        </p>
      )}

      {enabled && cfg && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-3)", lineHeight: 1.5, marginTop: 8 }}>
          <p style={{ margin: "0 0 6px" }}>
            Your node will automatically pay <strong>{sats(cfg.current_price)}</strong> to renew your
            subscription when it would otherwise lapse.
          </p>
          <p style={{ margin: "0 0 6px" }}>Requires sufficient on-chain BTC and your node to be online.</p>
          <p style={{ margin: 0 }}>You can opt out at any time.</p>
          {cfg.enabled_at && (
            <p style={{ margin: "6px 0 0", fontFamily: "var(--mono)", fontSize: "0.6875rem" }}>
              Enabled {formatDistanceToNow(new Date(cfg.enabled_at * 1000), { addSuffix: true })}
            </p>
          )}
        </div>
      )}

      {!enabled && cfg && (
        <p style={{ fontSize: "0.75rem", color: "var(--text-3)", lineHeight: 1.5, margin: "8px 0 0" }}>
          When enabled, your node renews your subscription automatically from its on-chain wallet so
          it never lapses while you're away.
        </p>
      )}

      {save.kind === "error" && (
        <p style={{ color: "var(--red, #ef4444)", fontSize: "0.8125rem", margin: "6px 0 0" }}>{save.message}</p>
      )}

      {cfg && (
        <button
          onClick={() => void onToggleHistory()}
          style={{
            background: "none",
            border: "none",
            padding: "8px 0 0",
            color: "var(--text-3)",
            fontSize: "0.75rem",
            cursor: "pointer",
            fontFamily: "var(--sans)",
          }}
        >
          {showHistory ? "Hide auto-pay history" : "View auto-pay history →"}
        </button>
      )}

      {showHistory && history !== null && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          {history.length === 0 ? (
            <p style={{ fontSize: "0.75rem", color: "var(--text-3)", margin: 0 }}>No auto-pay events yet.</p>
          ) : (
            history.map((a) => <AutoPayHistoryRow key={a.id} alert={a} />)
          )}
        </div>
      )}
    </div>
  );
}

function AutoPayHistoryRow({ alert }: { alert: AutoPayAlert }) {
  const when = Number.isFinite(alert.updated_at)
    ? formatDistanceToNow(new Date(alert.updated_at * 1000), { addSuffix: true })
    : null;
  const ok = alert.severity === "info";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        fontSize: "0.6875rem",
        fontFamily: "var(--mono)",
        color: "var(--text-3)",
      }}
    >
      <span style={{ color: ok ? "var(--green, #22c55e)" : "var(--amber)" }}>
        {autoPayLabel(alert.type)}
      </span>
      <span>
        {alert.status}
        {alert.consecutive_count > 1 ? ` ×${alert.consecutive_count}` : ""}
        {when ? ` · ${when}` : ""}
      </span>
    </div>
  );
}

export function autoPayLabel(type: string): string {
  switch (type) {
    case "AUTOPAY_SUCCEEDED":
      return "Renewed";
    case "AUTOPAY_INSUFFICIENT_FUNDS":
      return "Insufficient funds";
    case "AUTOPAY_LND_UNAVAILABLE":
      return "Wallet unreachable";
    case "AUTOPAY_PAYMENT_FAILED":
      return "Payment failed";
    case "AUTOPAY_FEE_ESTIMATE_FAILED":
      return "Fee estimate failed";
    default:
      return type;
  }
}
