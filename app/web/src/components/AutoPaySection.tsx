// AutoPaySection — member-facing subscription auto-pay opt-in control.
//
// Source: bitcorn-research/specs/2026-06-12-subscription-auto-pay-
// implementation.md §7A. Mounted in SubscriptionPanel's applicable branch as
// its own .sub-panel card (v1.17.18 relocation from Profile — auto-renew is a
// subscription concern, the automation of "Renew now", not an identity one).
// Member view only.
//
// A thin renderer over api.getAutoPayConfig()/setAutoPay(): a toggle, the
// always-visible standing-authorization status (decision §7 — the member must
// always be able to see auto-pay is on, the amount, and that it fires on
// lapse), and an expandable history. Off by default.

import { useCallback, useEffect, useState } from "react";
import { api, type AutoPayConfig, type AutoPayAlert } from "../api/client";
import { formatDistanceToNow } from "date-fns";
import { autoPayCanEnable, trustCopy, trustStateOfAutoPayConfig } from "./paymentTrust";
import { renewalAmount } from "./subscriptionBanner";

const sats = (n: number | null | undefined) =>
  typeof n === "number" ? `${new Intl.NumberFormat("en-US").format(n)} sats` : "—";

type Save = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

/** pausesOn: the status's grace.worker_until (ms), when hosted services pause
 *  if the subscription is not renewed. Auto-pay fires only once a lapse has
 *  begun (autoPayTrigger.ts, the recoverable-lapsed tiers), which is after
 *  that pause — the copy below says so (drive-mode P2 item 13, R6(b)(b)).
 *  payBlocked: payBlocked(status) from paymentTrust.ts; while true, the line
 *  saying the node pays from its balance is hidden (G3 finding 3, ruled
 *  2026-11-11) and the S-state shows as a pointer to the panel's notice.
 *  Omitted reads as blocked.
 *  usdRate: the panel's BTC/USD rate (drive-mode R45 A2, ruling 3), so the
 *  "your node pays …" line is dollars first like the rest of the panel; null
 *  or omitted shows sats. */
export default function AutoPaySection({
  pausesOn,
  payBlocked = true,
  usdRate = null,
}: { pausesOn?: number; payBlocked?: boolean; usdRate?: number | null } = {}) {
  const amount = (n: number | null | undefined) =>
    typeof n === "number" ? <span className="sub-amount">{renewalAmount(n, usdRate).text}</span> : "—";
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
  // treasury-price-trust (spec §8): why the current price is unavailable (S1–S5),
  // and opting IN only on a verified, payable status. Opting out always works.
  const trust = trustStateOfAutoPayConfig(cfg);
  const trustText = trust
    ? trustCopy(trust, trust.state === "S4_price_above_cap" ? sats(trust.price_sats) : undefined).text
    : null;
  const canEnable = autoPayCanEnable(cfg);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "0.875rem", fontWeight: 600 }}>Auto-renew subscription</span>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: saving ? "wait" : "pointer" }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving || !cfg || (!enabled && !canEnable)}
            onChange={(e) => void onToggle(e.target.checked)}
          />
          <span style={{ fontSize: "0.8125rem", color: enabled ? "var(--green, #22c55e)" : "var(--text-3)" }}>
            {enabled ? "On" : "Off"}
          </span>
        </label>
      </div>

      {/* One S-state per panel screen (drive-mode, accepted by Ethan
          2026-11-11): while payments are blocked the panel's page notice
          carries the full S-state, so this section only points to it, and
          only while auto-pay is on (drive-mode, accepted 2026-11-11); off,
          the off-state line below stands alone. */}
      {payBlocked ? (
        enabled && <p style={{ color: "var(--text)", fontSize: "0.8125rem", margin: "6px 0 0" }}>Auto-pay is paused (see above).</p>
      ) : trustText && (
        <p role="status" data-trust-state={trust!.state} style={{ color: "var(--text)", fontSize: "0.8125rem", margin: "6px 0 0" }}>
          {trustText}
        </p>
      )}

      {loadFailed && (
        <p style={{ color: "var(--text-3)", fontSize: "0.8125rem", margin: "6px 0 0" }}>
          Couldn't load auto-pay settings. It will retry when you reload.
        </p>
      )}

      {enabled && cfg && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-3)", lineHeight: 1.5, marginTop: 8 }}>
          {/* Past the pause (the screenshot gate): the lapse has begun, which is
              exactly when auto-pay fires, so say that rather than "if". */}
          {payBlocked ? null : pausesOn != null && pausesOn <= Date.now() ? (
            <p style={{ margin: "0 0 6px" }}>
              Your subscription has lapsed and hosted services are paused, so your node will pay{" "}
              <strong>{amount(cfg.current_price)}</strong> from its Bitcoin balance to renew it.
            </p>
          ) : (
            <p style={{ margin: "0 0 6px" }}>
              If your subscription lapses, your node pays <strong>{amount(cfg.current_price)}</strong> from its
              Bitcoin balance to renew it. That happens after hosted services pause
              {pausesOn ? ` on ${new Date(pausesOn).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` : ""}, so
              turning this on doesn't prevent the pause.
            </p>
          )}
          <p style={{ margin: "0 0 6px" }}>Requires sufficient on-chain BTC and your node to be online.</p>
          {/* pay-from-node D2/D3, 2026-11-05; wording approved at G3, 2026-11-06 (ruling R6). */}
          <p style={{ margin: "0 0 6px" }}>
            It never pays more than the price you last accepted, and it won't pay again while an
            earlier payment hasn't been credited.
          </p>
          <p style={{ margin: 0 }}>You can opt out at any time.</p>
          {cfg.enabled_at && (
            <p style={{ margin: "6px 0 0", fontFamily: "var(--mono)", fontSize: "0.75rem" }}>
              Enabled {formatDistanceToNow(new Date(cfg.enabled_at * 1000), { addSuffix: true })}
            </p>
          )}
        </div>
      )}

      {!enabled && cfg && (
        <p style={{ fontSize: "0.75rem", color: "var(--text-3)", lineHeight: 1.5, margin: "8px 0 0" }}>
          When on, your node renews from its Bitcoin balance once your subscription has lapsed.
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
        fontSize: "0.75rem",
        fontFamily: "var(--mono)",
        color: "var(--text-3)",
      }}
    >
      <span className={ok ? undefined : "warn-mark"} style={{ color: ok ? "var(--green, #22c55e)" : "var(--text)" }}>
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
    // pay-from-node, 2026-11-05; approved at G3, 2026-11-06 (ruling R6).
    case "AUTOPAY_SETTLEMENT_OVERDUE":
      return "Held: earlier payment not credited";
    case "AUTOPAY_PRICE_NOT_ACKNOWLEDGED":
      return "Price not accepted";
    // treasury-price-trust: drive-mode's plain-language review, 2026-11-10.
    // Without these the raw type name showed.
    case "AUTOPAY_STATUS_UNVERIFIED":
      return "Auto-pay paused: couldn't confirm the price came from Bitcorn";
    case "AUTOPAY_PAY_TARGET_REFUSED":
      return "Auto-pay paused: payment held for safety";
    default:
      return type;
  }
}
