// Automatic renewal (subscription auto-pay) — the Membership panel's switch and
// its "About automatic renewal" row (member-first-run-ui slice 4, R2).
//
// Source: bitcorn-research/specs/2026-06-12-subscription-auto-pay-
// implementation.md §7A. It was its own card under the panel (v1.17.18); slice
// 4 splits it: the switch, "Renew automatically", with one line, is always
// visible; everything else the card said is in the "About automatic renewal"
// row. The panel reads the settings ONCE (useAutoRenew) and passes them to
// both, and to the not-applicable states' price. Member view only. Off by
// default.
//
// Decision §7 holds: the member can always see that auto-pay is on (the
// switch), the amount and that it fires on lapse (the row).

import { useCallback, useEffect, useState } from "react";
import { api, type AutoPayConfig, type AutoPayAlert, type ExchangeRate } from "../api/client";
import { formatDistanceToNow } from "date-fns";
import { autoPayCanEnable, trustCopy, trustStateOfAutoPayConfig } from "./paymentTrust";
import { usableUsd } from "./amount/Amount";
import { inlineAmount } from "./amount/inlineAmount";
import { MEMBERSHIP_COPY as COPY } from "./membership/membershipDescriptor";
import { Sentence } from "./membership/Sentence";

type Save = { kind: "idle" } | { kind: "saving" } | { kind: "error"; message: string };

export type AutoRenew = {
  cfg: AutoPayConfig | null;
  loadFailed: boolean;
  save: Save;
  toggle: (next: boolean) => Promise<void>;
};

/** The one auto-pay read for the panel: on mount, and again after a toggle. */
export function useAutoRenew(): AutoRenew {
  const [cfg, setCfg] = useState<AutoPayConfig | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [save, setSave] = useState<Save>({ kind: "idle" });

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

  const toggle = useCallback(async (next: boolean) => {
    setSave((s) => (s.kind === "saving" ? s : { kind: "saving" }));
    try {
      await api.setAutoPay(next);
      await load();
      setSave({ kind: "idle" });
    } catch (e: any) {
      setSave({ kind: "error", message: e?.detail ?? e?.message ?? COPY.autoPaySaveFailed });
    }
  }, [load]);

  return { cfg, loadFailed, save, toggle };
}

/** The always-visible switch and its one line (R2). payBlocked: payBlocked(status)
 *  from paymentTrust.ts; while true, no line says the node pays (G3 finding 3):
 *  on, the line is the pointer to the panel's notice; off, the off line. */
export function AutoRenewSwitch({
  auto,
  payBlocked,
  rate,
}: {
  auto: AutoRenew;
  payBlocked: boolean;
  rate: ExchangeRate | null | undefined;
}) {
  const { cfg, loadFailed, save } = auto;
  const saving = save.kind === "saving";
  const enabled = cfg?.enabled ?? false;
  // treasury-price-trust (spec §8): why the current price is unavailable (S1–S5),
  // and opting IN only on a verified, payable status. Opting out always works.
  const trust = trustStateOfAutoPayConfig(cfg);
  const s4Price = trust?.state === "S4_price_above_cap" ? inlineAmount(trust.price_sats, usableUsd(rate)) : undefined;
  const trustText = trust ? trustCopy(trust, s4Price).text : null;
  const canEnable = autoPayCanEnable(cfg);

  const line = !cfg ? null : enabled ? (payBlocked ? COPY.autoPayPaused : COPY.switchOn) : COPY.switchOff;

  return (
    <div className="membership-switch">
      <div className="membership-switch-row">
        <span className="membership-switch-label">{COPY.switchLabel}</span>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: saving ? "wait" : "pointer" }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving || !cfg || (!enabled && !canEnable)}
            onChange={(e) => {
              if (!saving) void auto.toggle(e.target.checked);
            }}
            aria-label={COPY.switchLabel}
          />
          <span className="membership-switch-state">{enabled ? COPY.on : COPY.off}</span>
        </label>
      </div>
      {line && <p className="membership-switch-line">{line}</p>}
      {!payBlocked && trustText && (
        <p className="membership-warning" role="status" data-trust-state={trust!.state}>
          <Sentence text={trustText} amounts={s4Price ? [s4Price] : []} />
        </p>
      )}
      {loadFailed && <p className="membership-warning">{COPY.autoPayLoadFailed}</p>}
      {save.kind === "error" && <p className="membership-error">{save.message}</p>}
    </div>
  );
}

/** "About automatic renewal": everything else the auto-pay card said (R2).
 *  pausesOn: the status's grace.worker_until (ms), when hosted services pause;
 *  auto-pay fires only once a lapse has begun (autoPayTrigger.ts), after that
 *  pause, and the line says so (drive-mode P2 item 13). While payments are
 *  blocked, the "your node pays …" line is hidden (G3 finding 3). */
export function AutoRenewAbout({
  auto,
  pausesOn,
  payBlocked,
  rate,
}: {
  auto: AutoRenew;
  pausesOn: number;
  payBlocked: boolean;
  rate: ExchangeRate | null | undefined;
}) {
  const { cfg } = auto;
  const enabled = cfg?.enabled ?? false;
  const usd = usableUsd(rate);
  const price = typeof cfg?.current_price === "number" ? inlineAmount(cfg.current_price, usd) : "—";
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<{ kind: "ok"; rows: AutoPayAlert[] } | { kind: "failed" } | null>(null);

  async function onToggleHistory() {
    const next = !showHistory;
    setShowHistory(next);
    if (next && (history === null || history.kind === "failed")) {
      try {
        setHistory({ kind: "ok", rows: await api.getAutoPayHistory() });
      } catch {
        setHistory({ kind: "failed" });
      }
    }
  }

  const pauseDate = new Date(pausesOn).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  const paysLine = pausesOn <= Date.now() ? COPY.aboutLapsedNow(price) : COPY.aboutIfLapses(price, pauseDate);

  return (
    <div className="membership-about">
      {enabled && cfg && (
        <>
          {!payBlocked && <p><Sentence text={paysLine} amounts={[price]} /></p>}
          <p>{COPY.aboutRequires}</p>
          {/* pay-from-node D2/D3, 2026-11-05; wording approved at G3, 2026-11-06 (ruling R6). */}
          <p>{COPY.aboutNeverMore}</p>
          <p>{COPY.aboutOptOut}</p>
          {cfg.enabled_at && (
            <p className="membership-mono">{COPY.enabledAgo(formatDistanceToNow(new Date(cfg.enabled_at * 1000), { addSuffix: true }))}</p>
          )}
        </>
      )}
      {!enabled && cfg && <p>{COPY.aboutOffLine}</p>}

      {cfg && (
        <button className="sub-link sub-link-button" onClick={() => void onToggleHistory()}>
          {showHistory ? COPY.historyHide : COPY.historyShow}
        </button>
      )}

      {showHistory && history !== null && (
        <div className="membership-history">
          {history.kind === "failed" ? (
            <p className="membership-error" role="alert">{COPY.historyFailed}</p>
          ) : history.rows.length === 0 ? (
            <p>{COPY.historyEmpty}</p>
          ) : (
            history.rows.map((a) => <AutoPayHistoryRow key={a.id} alert={a} />)
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
    // Without these the raw type name showed. "BitCorn": slice 4.
    case "AUTOPAY_STATUS_UNVERIFIED":
      return "Auto-pay paused: couldn't confirm the price came from BitCorn";
    case "AUTOPAY_PAY_TARGET_REFUSED":
      return "Auto-pay paused: payment held for safety";
    default:
      return type;
  }
}
