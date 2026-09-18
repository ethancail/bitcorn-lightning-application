// app/web/src/components/autoBuy/StrategyTab.tsx
import { useEffect, useRef, useState } from "react";
import { api, type AutoBuyMissed, type AutoBuyStatus, type AutoBuyZoneMultipliers, type CurrencyPreference, type ValuationCurrent, type ValuationZone } from "../../api/client";
import HistoryTable from "./HistoryTable";
import CoinbaseCard from "./CoinbaseCard";
import ActionConfirmModal, { useActionConfirm } from "../actionConfirm/ActionConfirmModal";
import { summarizeCatchUp, fmtUsd } from "../actionConfirm/confirmAction";
import { classifyConfirmError } from "../actionConfirm/confirmErrors";

interface Props {
  status: AutoBuyStatus | null;
  valuation: ValuationCurrent | null;
  onRefresh: () => Promise<unknown>;
  /**
   * The page's valuation fetch error, forwarded so the Missed-buys block can
   * check that B-degraded's "see the notice above" has a referent ON THIS TAB.
   * The banner itself is the page's; this prop is only the fact of it.
   */
  valuationError?: { code?: string } | null;
}

// One-line explanation per currency-preference option (spec §6 / §12.3).
const CURRENCY_PREF_HELP: Record<CurrencyPreference, string> = {
  usd_only: "Spends only your USD balance; ignores USDC even if it would cover the buy.",
  usdc_only: "Spends only your USDC balance; ignores USD even if it would cover the buy.",
  usd_preferred: "Spends whichever balance covers the buy, trying USD first.",
  usdc_preferred: "Spends whichever balance covers the buy, trying USDC first.",
};

const ZONE_ORDER: Array<{ key: keyof AutoBuyZoneMultipliers; label: string }> = [
  { key: "extreme_buy",  label: "Extreme Buy"  },
  { key: "undervalued",  label: "Undervalued"  },
  { key: "fair_value",   label: "Fair Value"   },
  { key: "elevated",     label: "Elevated"     },
  { key: "overvalued",   label: "Overvalued"   },
  { key: "extreme_sell", label: "Extreme Sell" },
];

/**
 * Zone token → the label the page already shows.
 *
 * ⚠ ZONE_ORDER is one of TWO component-local zone-label maps in this app; the
 * other is `ZONE_BANDS` / `zoneLabel()` in ValuationTab.tsx, whose own comment
 * says "Kept in sync manually". This function is a lookup over the map that is
 * already in this file — deliberately NOT a third copy. Lifting one of the two
 * to a shared home is a real cleanup and a different arc's: they are keyed by
 * different types (`keyof AutoBuyZoneMultipliers` here, `ValuationZone` there)
 * and ValuationTab's carries thresholds and colours mirroring the Worker, so
 * merging means deciding where THOSE live.
 */
function zoneLabelFor(zone: string): string {
  return ZONE_ORDER.find((z) => z.key === zone)?.label ?? zone;
}

/**
 * A missed slot's date. Date only, no time (DATE-FMT).
 *
 * Same call as HistoryTable's own slot dates, so a missed interval reads
 * identically in the block and in the history row that records it. That helper
 * is component-local there; this is the same one-liner rather than an import,
 * and lifting both is the same class of question as the zone maps above.
 */
function fmtSlotDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * What the member is told when the catch-up refuses.
 *
 * ⚠ EVERY BRANCH RETURNS COPY ETHAN ACCEPTED. Refusals with no accepted string
 * take the accepted GENERIC FRAME carrying the code verbatim — deliberately,
 * because inventing prose here is the one thing the spec forbids outright, and
 * a code a member can quote in a report beats a sentence nobody signed off.
 *
 * The split between member-facing prose and the generic frame is Ethan's
 * ruling: prose for the member's own switches and for what they can act on,
 * the gate's own reason inside one frame for everything else.
 */
function catchUpRefusalMessage(
  body: {
    error?: string;
    reason?: string;
    cap?: { window: "7d" | "30d"; cap_usd: number; headroom_usd: number; unit_usd: number };
    staleness?: { threshold_hours: number; age_hours: number };
    actual?: { intervals: number; usd: number };
  } | null,
  ctx: { pausedReason: string | null; zone: string | null },
): string {
  const code = body?.error ?? "unknown";
  const tail = "Nothing was bought; the missed intervals are still listed.";

  // NS — the member's own switch, or a system pause. Both put a banner on this
  // very surface (PausedBanner, above), so "the notice above" is true.
  if ((code === "not_schedulable" || code === "address_not_whitelisted") && ctx.pausedReason) {
    return `Not placed: Auto-Buy is paused — see the notice above. ${tail}`;
  }

  // R-cap — the only rolling refusal D5 leaves. Every figure is a FIELD.
  // "7-day" / "30-day", not "week"/"month": the windows are rolling.
  if (code === "rolling_cap_no_headroom" && body?.cap) {
    const { window, cap_usd, headroom_usd, unit_usd } = body.cap;
    const label = window === "7d" ? "7-day" : "30-day";
    return `Not placed: this ${label} limit of ${fmtUsd(cap_usd)} has ${fmtUsd(headroom_usd)} left — less than one missed buy (${fmtUsd(unit_usd)}). ${tail}`;
  }

  // R-stale — this node's threshold, not a hardcoded 48. The field's ABSENCE
  // is what routes `invalid_updated_at` (same code, no age) to the frame.
  if (code === "valuation_stale" && body?.staleness) {
    return `Not placed: the valuation is more than ${body.staleness.threshold_hours} hours old. ${tail}`;
  }

  // R-zero — the zone LABEL, never the wire token.
  if (code === "zero_multiplier") {
    const token = body?.reason?.startsWith("zone=") ? body.reason.slice(5) : ctx.zone ?? "";
    return `Not placed: the current zone (${zoneLabelFor(token)}) has a 0× multiplier, so there is nothing to buy. ${tail}`;
  }

  // R-409 — the ROUTE's 409. The middleware's confirmation_mismatch is a
  // different refusal and takes the frame.
  if (code === "catch_up_amount_changed" && body?.actual) {
    return `The amount changed since this was shown (now ${fmtUsd(body.actual.usd)}). Nothing was bought — review and confirm again.`;
  }

  // GEN. ⚠ `insufficient_funds` lands here ON PURPOSE: its structured `funds`
  // fields now exist so R-bal CAN be written, but Ethan has not written it, and
  // the frame is the accepted thing to say until he does.
  return `Not placed (${code}). ${tail}`;
}

/**
 * The Missed buys block (spec §4 A1–A3; §5 H / B-full / B-partial / B-degraded
 * / BTN / M-full / M-partial / OK).
 *
 * Renders ONLY when unclaimed intervals exist — no empty state, no "0 missed".
 * Renders while `enabled = 0` too: the intervals were missed either way, and a
 * refusal then carries NS, which points at the pause banner above.
 */
function MissedBuysBlock({
  missed, pausedReason, onRefresh,
}: {
  missed: AutoBuyMissed;
  pausedReason: string | null;
  onRefresh: () => Promise<unknown>;
}) {
  const confirm = useActionConfirm();
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  const n = missed.intervals;
  const dates = `${fmtSlotDate(missed.oldest_slot)} and ${fmtSlotDate(missed.newest_slot)}`;
  const lead = `${n} weekly ${plural(n, "buy", "buys")} ${plural(n, "was", "were")} missed between ${dates}`;

  // DEGRADED: count and dates are known, no amount is. Claim nothing else —
  // the row carries no cause, so the block asserts none and points at the
  // page's valuation notice, which renders on this tab.
  const degraded = missed.estimated_usd === null || missed.fits_now === null;

  const fits = missed.fits_now;
  const remainder = missed.remainder;

  const doConfirm = async (): Promise<void> => {
    if (!fits) return;
    const res = await api.catchUpAutoBuy({
      expected_intervals: fits.intervals,
      expected_usd: fits.estimated_usd,
    });
    const left = res.remainder_intervals;
    const clause = left > 0
      ? ` ${left} missed ${plural(left, "buy", "buys")} remain and can be bought once the limit frees up.`
      : "";
    setToast({ kind: "success", message: `Order placed for ${fmtUsd(res.usd)}.${clause} Check history.` });
    await onRefresh();
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Missed buys</div>
      <div className="panel-body">
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", marginBottom: 16 }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}

        {degraded ? (
          <p style={{ margin: 0 }}>{lead}. The amount can't be calculated right now — see the notice above.</p>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              {lead}. Buying them now would place one order of about {fmtUsd(missed.estimated_usd!)} ({n} × {fmtUsd(missed.base_unit_usd)} × {missed.multiplier}× {zoneLabelFor(missed.zone ?? "")}) at today's price. The final amount is set when you confirm.
            </p>

            {remainder && fits && (
              <p style={{ marginTop: 10, marginBottom: 0 }}>
                {fits.intervals} of {n} missed buys fit within this {remainder.binding_window === "7d" ? "7-day" : "30-day"} limit: about {fmtUsd(fits.estimated_usd)}. {remainder.intervals} missed {plural(remainder.intervals, "buy", "buys")} (about {fmtUsd(remainder.estimated_usd)}) remain and can be bought once the limit frees up.
              </p>
            )}

            <div style={{ marginTop: 14 }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (!fits) return;
                  confirm.open(summarizeCatchUp({
                    intervals: n,
                    fitsIntervals: fits.intervals,
                    fitsUsd: fits.estimated_usd,
                    remainderIntervals: remainder?.intervals ?? 0,
                  }));
                }}
              >
                Buy missed intervals
              </button>
            </div>
          </>
        )}
      </div>

      {/* The modal owns the typed challenge; the button inside it stays
          disabled until the two-decimal target is typed character for
          character. classifyConfirmError distinguishes a 409 from a 400 so a
          gate refusal never renders as "something went wrong". */}
      <ActionConfirmModal
        controller={confirm}
        onConfirm={async () => {
          try {
            await doConfirm();
          } catch (err) {
            const cls = classifyConfirmError(err);
            const body = (err as { body?: Parameters<typeof catchUpRefusalMessage>[0] })?.body ?? null;
            setToast({
              kind: "error",
              // A confirmation-gate failure with no route-level code is the
              // gate's own refusal — render its classified detail rather than
              // a frame carrying a code the member cannot act on.
              message: cls && cls.kind === "mismatch" && !body?.error
                ? cls.detail
                : catchUpRefusalMessage(body, { pausedReason, zone: missed.zone }),
            });
            throw err;
          }
        }}
      />
    </div>
  );
}

export default function StrategyTab({ status, valuation, onRefresh, valuationError }: Props) {
  if (!status?.config) {
    return (
      <div className="panel"><div className="panel-body">
        <em className="text-dim">Config unavailable. Backend may not be initialized.</em>
      </div></div>
    );
  }
  const cfg = status.config;

  // Next-buy banner
  const currentMultiplier = valuation ? cfg.zone_multipliers[valuation.zone as ValuationZone] ?? 0 : 0;
  const nextBuyUsd = Math.round(cfg.base_unit_usd * currentMultiplier * 100) / 100;

  return (
    <div>
      <MasterControl status={status} onRefresh={onRefresh} />

      {/* Unclaimed passed-over intervals. Renders only when there are some. */}
      {status.missed && (
        <MissedBuysBlock
          missed={status.missed}
          pausedReason={cfg.paused_reason}
          onRefresh={onRefresh}
        />
      )}

      {/* Summary banner */}
      <div className="panel" style={{ marginBottom: 16, background: "var(--panel)", borderLeft: `4px solid ${nextBuyUsd > 0 ? "var(--green)" : "var(--text-dim)"}` }}>
        <div className="panel-body">
          <div style={{ fontSize: "0.875rem", color: "var(--text-dim)", marginBottom: 4 }}>At current Z-score</div>
          <div style={{ fontSize: "1.25rem" }}>
            {valuation ? (
              <>If base = <strong>${cfg.base_unit_usd.toFixed(2)}</strong> the next buy is <strong>${nextBuyUsd.toFixed(2)}</strong> (zone: {valuation.zone}, {currentMultiplier}×)</>
            ) : (
              <em className="text-dim">Valuation not loaded — next-buy calculation unavailable.</em>
            )}
          </div>
        </div>
      </div>

      {/* Multipliers editor */}
      <MultipliersEditor config={cfg} onSaved={onRefresh} />

      <HistoryTable sweepDayOfWeek={cfg.sweep_day_of_week} />
      <CoinbaseCard status={status} onRefresh={onRefresh} />
    </div>
  );
}

function MultipliersEditor({ config, onSaved }: { config: NonNullable<AutoBuyStatus["config"]>; onSaved: () => Promise<unknown> }) {
  const [baseUnit, setBaseUnit] = useState(String(config.base_unit_usd));
  const [frequency, setFrequency] = useState(config.frequency);
  const [mult, setMult] = useState<AutoBuyZoneMultipliers>(config.zone_multipliers);
  const [currencyPref, setCurrencyPref] = useState<CurrencyPreference>(config.currency_preference);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  // Only sync from server when the user has NO unsaved edits. A background
  // 30s poll tick can re-render with a fresh `config` object reference; without
  // this guard, it would clobber in-progress edits. Detect "clean" state by
  // comparing current local form state to the last-applied server config.
  const lastAppliedRef = useRef<typeof config | null>(null);
  useEffect(() => {
    const applied = lastAppliedRef.current;
    const localMatchesApplied = applied
      ? String(applied.base_unit_usd) === baseUnit
        && applied.frequency === frequency
        && JSON.stringify(applied.zone_multipliers) === JSON.stringify(mult)
        && applied.currency_preference === currencyPref
      : true; // first mount: no local edits yet

    if (localMatchesApplied) {
      setBaseUnit(String(config.base_unit_usd));
      setFrequency(config.frequency);
      setMult(config.zone_multipliers);
      setCurrencyPref(config.currency_preference);
      lastAppliedRef.current = config;
    }
    // else: preserve the user's unsaved edits, ignore this server update
  }, [config, baseUnit, frequency, mult, currencyPref]);

  const handleSave = async () => {
    setSaving(true); setToast(null);
    try {
      const base = Number(baseUnit);
      if (!Number.isFinite(base) || base <= 0) { setToast({ kind: "error", message: "Base unit must be a positive number." }); setSaving(false); return; }
      for (const { key, label } of ZONE_ORDER) {
        const v = mult[key];
        if (!Number.isFinite(v) || v < 0) { setToast({ kind: "error", message: `${label} multiplier must be ≥ 0.` }); setSaving(false); return; }
      }
      await api.patchAutoBuyConfig({
        base_unit_usd: base,
        frequency,
        zone_multipliers: mult,
        currency_preference: currencyPref,
      });
      setToast({ kind: "success", message: "Saved." });
      await onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error.";
      setToast({ kind: "error", message: msg });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-header">Strategy</div>
      <div className="panel-body">
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", marginBottom: 16 }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="text-dim" style={{ fontSize: "0.75rem" }}>Base unit (USD)</span>
            <input type="number" step="1" min="1" value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="text-dim" style={{ fontSize: "0.75rem" }}>Frequency</span>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </label>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span className="text-dim" style={{ fontSize: "0.75rem" }}>Currency Preference</span>
            <select
              value={currencyPref}
              onChange={(e) => setCurrencyPref(e.target.value as CurrencyPreference)}
              title={CURRENCY_PREF_HELP[currencyPref]}
            >
              <option value="usd_only">USD only</option>
              <option value="usdc_only">USDC only</option>
              <option value="usd_preferred">Both, USD first</option>
              <option value="usdc_preferred">Both, USDC first</option>
            </select>
          </label>
          <div className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4 }}>
            {CURRENCY_PREF_HELP[currencyPref]}
          </div>
        </div>

        <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>Zone Buy Multipliers</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 16 }}>
          {ZONE_ORDER.map(({ key, label }) => (
            <label key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="text-dim" style={{ fontSize: "0.75rem" }}>{label}</span>
              <input
                type="number"
                step="0.25"
                min="0"
                value={mult[key]}
                onChange={(e) => setMult({ ...mult, [key]: Number(e.target.value) })}
              />
            </label>
          ))}
        </div>

        <button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save Strategy"}</button>
      </div>
    </div>
  );
}

function MasterControl({ status, onRefresh }: { status: AutoBuyStatus; onRefresh: () => Promise<unknown> }) {
  const cfg = status.config;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  if (!cfg) return null;
  const enabled = cfg.enabled;
  const pausedReason = cfg.paused_reason;
  const canEnable = !!status.credentials && !!cfg.withdraw_address_whitelisted_at && cfg.consecutive_failures < 3;

  const doEnable = async () => {
    setBusy(true); setToast(null);
    try { await api.enableAutoBuy(); setToast({ kind: "success", message: "Auto-Buy enabled." }); await onRefresh(); }
    catch (err) { setToast({ kind: "error", message: err instanceof Error ? err.message : "Enable failed." }); }
    finally { setBusy(false); }
  };
  const doPause = async () => {
    setBusy(true); setToast(null);
    try { await api.pauseAutoBuy(); setToast({ kind: "success", message: "Auto-Buy paused." }); await onRefresh(); }
    catch (err) { setToast({ kind: "error", message: err instanceof Error ? err.message : "Pause failed." }); }
    finally { setBusy(false); }
  };
  const doExecuteNow = async () => {
    if (!confirm("Run a buy tick now? This respects all caps and will only place a buy if the schedule is due.")) return;
    setBusy(true); setToast(null);
    try { await api.executeAutoBuyNow(); setToast({ kind: "success", message: "Tick executed. Check history." }); await onRefresh(); }
    catch (err) { setToast({ kind: "error", message: err instanceof Error ? err.message : "Execute failed." }); }
    finally { setBusy(false); }
  };

  return (
    <>
      {pausedReason && <PausedBanner reason={pausedReason} />}

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="panel-body" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: "1rem", fontWeight: 600, marginBottom: 2 }}>
              {enabled ? <span style={{ color: "var(--green)" }}>● Enabled</span> : <span className="text-dim">○ Paused</span>}
            </div>
            <div className="text-dim" style={{ fontSize: "0.75rem" }}>
              {enabled
                ? cfg.next_run_at
                  ? `Next scheduled tick: ${new Date(cfg.next_run_at * 1000).toLocaleString()}`
                  : "No scheduled tick yet"
                : pausedReason ? `Paused: ${pausedReason}` : "Master switch is off"}
            </div>
            {cfg.consecutive_failures > 0 && (
              <div style={{ fontSize: "0.75rem", color: "var(--amber)", marginTop: 2 }}>
                {cfg.consecutive_failures} consecutive failure{cfg.consecutive_failures === 1 ? "" : "s"} (auto-pause at 3)
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {enabled ? (
              <>
                <button onClick={doExecuteNow} disabled={busy}>{busy ? "…" : "Execute Now"}</button>
                <button onClick={doPause} disabled={busy}>{busy ? "…" : "Pause"}</button>
              </>
            ) : (
              <button onClick={doEnable} disabled={busy || !canEnable} title={!canEnable ? "Connect + whitelist credentials first" : ""}>
                {busy ? "…" : "Enable"}
              </button>
            )}
          </div>
        </div>
        {toast && (
          <div className="alert" style={{ background: toast.kind === "success" ? "var(--green)" : "var(--red)", color: "white", margin: "0 16px 16px" }}>
            <div className="alert-body">{toast.message}</div>
          </div>
        )}
      </div>
    </>
  );
}

function PausedBanner({ reason }: { reason: string }) {
  const { title, body } = PAUSED_MESSAGES[reason] ?? { title: "Auto-Buy paused", body: `paused_reason=${reason}` };
  return (
    <div className="alert warning" style={{ marginBottom: 16 }}>
      <span className="alert-icon">⚠</span>
      <div className="alert-body">
        <div className="alert-type">{title}</div>
        <div className="alert-msg">{body}</div>
      </div>
    </div>
  );
}

const PAUSED_MESSAGES: Record<string, { title: string; body: string }> = {
  user_paused:             { title: "Paused by operator",          body: "You can resume Auto-Buy from the master control." },
  no_credentials:          { title: "No Coinbase credentials",     body: "Connect a Coinbase Cloud Key in the integration panel below." },
  credentials_invalid:     { title: "Coinbase credentials invalid", body: "Coinbase rejected the API key. Rotate the key and re-connect." },
  credentials_corrupted:   { title: "Credentials corrupted",       body: "The encrypted key could not be decrypted. Reconnect to repair." },
  address_not_whitelisted: { title: "Withdrawal address not whitelisted", body: "Add the displayed address to Coinbase's allowlist and confirm via the integration panel below." },
  consecutive_failures:    { title: "Auto-paused after 3 failures", body: "Review the purchase history for error messages, then re-enable." },
};
