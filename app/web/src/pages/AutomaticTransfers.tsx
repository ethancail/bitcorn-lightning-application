// Automatic transfers — the member's settings page (drive-mode P3, plan item 2;
// R14's terms; mockup r5's layout, with P3's rulings applied).
//
// Shows and saves the strategy and the three rails. NOTHING MOVES IN P3: there
// is no "Turn on" (D3.2), no badge — "Automatic transfers aren't switched on
// yet." instead (R40(3)) — no gauge mark and no "For you" line about what
// would move on its own. Those are P4's.
//
// Every figure is the server's (GET /api/transfers/settings): the defaults
// (NULL = default), R16(2)'s floors, the day boundary, and the ONE minimum
// connection size for the strategy the member is on (R19(6); one formula,
// R40(2)). Manual only shows Save on fees' size as advice, with no gate
// (R21(1)); Keep room open, below its own size, is unavailable and its
// sentence names that size (R21(2)) — the only second size on the screen.
//
// Amounts use the amount component's interim, dollars with sats beneath, until
// member-first-run-ui ships the component (spec §1.3). The radio rows and
// money inputs are page-local for the same reason: no shared primitive exists.

import { useEffect, useState } from "react";
import {
  api,
  transfersApi,
  type ExchangeRate,
  type TransferSettingsPatch,
  type TransferSettingsResponse,
  type TransferStrategy,
} from "../api/client";
import { rateNote } from "../api/rate";

/** Ethan's one-line descriptions, verbatim (mockup r5, STRAT). */
const STRATEGIES: Array<{ key: TransferStrategy; name: string; desc: string }> = [
  { key: "save", name: "Save on fees", desc: "Bigger moves, made when network fees are calm. Room dips lower between moves." },
  { key: "open", name: "Keep room open", desc: "Moves sooner and smaller, accepting a higher cost per dollar moved." },
  { key: "manual", name: "Manual only", desc: "Nothing moves on its own. Your dashboard recommends when to move." },
];
const NAME: Record<TransferStrategy, string> = { save: "Save on fees", open: "Keep room open", manual: "Manual only" };

export const NOT_ON_SENTENCE = "Automatic transfers aren't switched on yet.";
export const DAY_BOUNDARY_SENTENCE = "Daily limits reset at midnight US Central time.";

/** The interim amount: dollars, with sats beneath; sats alone with no rate. */
function Amount({ sats, usd }: { sats: number; usd: number | null }) {
  const dollars = usd != null ? `$${((sats / 100_000_000) * usd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null;
  if (!dollars) return <span data-testid="amount" data-sats={sats} style={{ fontWeight: 600 }}>{sats.toLocaleString()} sats</span>;
  return (
    <span data-testid="amount" data-sats={sats} style={{ display: "inline-flex", flexDirection: "column", verticalAlign: "top", lineHeight: 1.2 }}>
      <span style={{ fontWeight: 600 }}>{dollars}</span>
      <span style={{ fontSize: "0.6875rem", color: "var(--text-3)" }}>{sats.toLocaleString()} sats</span>
    </span>
  );
}

type Form = { strategy: TransferStrategy; pct: string; feeUsd: string; budgetUsd: string; maxDayUsd: string };

const centsToInput = (c: number) => (c / 100).toFixed(2);
const bpsToInput = (b: number) => String(b / 100);
const inputToCents = (s: string) => Math.round(Number(s) * 100);
const inputToBps = (s: string) => Math.round(Number(s) * 100);

function formFrom(r: TransferSettingsResponse): Form {
  const s = r.settings;
  return {
    strategy: s.strategy,
    pct: bpsToInput(s.fee_limit_pct_bps),
    feeUsd: centsToInput(s.fee_limit_usd_cents),
    budgetUsd: centsToInput(s.daily_fee_budget_usd_cents),
    maxDayUsd: centsToInput(s.max_moved_per_day_usd_cents),
  };
}

/** Only what the member changed is sent; untouched fields stay NULL
 *  (= the default) on the server. */
function patchFrom(form: Form, r: TransferSettingsResponse): TransferSettingsPatch {
  const s = r.settings;
  const p: TransferSettingsPatch = {};
  if (form.strategy !== s.strategy) p.strategy = form.strategy;
  if (inputToBps(form.pct) !== s.fee_limit_pct_bps) p.fee_limit_pct_bps = inputToBps(form.pct);
  if (inputToCents(form.feeUsd) !== s.fee_limit_usd_cents) p.fee_limit_usd_cents = inputToCents(form.feeUsd);
  if (inputToCents(form.budgetUsd) !== s.daily_fee_budget_usd_cents) p.daily_fee_budget_usd_cents = inputToCents(form.budgetUsd);
  if (inputToCents(form.maxDayUsd) !== s.max_moved_per_day_usd_cents) p.max_moved_per_day_usd_cents = inputToCents(form.maxDayUsd);
  return p;
}

function MoneyInput({ value, onChange, label, prefix, suffix }: { value: string; onChange: (v: string) => void; label: string; prefix?: string; suffix?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {prefix && <span className="text-dim">{prefix}</span>}
      <input
        className="form-input"
        aria-label={label}
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        style={{ width: 88 }}
      />
      {suffix && <span className="text-dim">{suffix}</span>}
    </span>
  );
}

export default function AutomaticTransfers() {
  const [data, setData] = useState<TransferSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [rate, setRate] = useState<ExchangeRate | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    transfersApi.getTransferSettings()
      .then((r) => { setData(r); setForm(formFrom(r)); })
      .catch((e) => setLoadError(e?.message ?? "Request failed"));
    api.getExchangeRate().then(setRate).catch(() => {});
  }, []);

  const usd = rate && rate.state !== "none" ? rate.usd : null;

  async function save() {
    if (!data || !form) return;
    const patch = patchFrom(form, data);
    if (Object.keys(patch).length === 0) { setSaveMsg({ ok: true, text: "Nothing changed." }); return; }
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await transfersApi.patchTransferSettings(patch);
      setData(r);
      setForm(formFrom(r));
      setSaveMsg({ ok: true, text: "Saved." });
    } catch (e: any) {
      const details: string[] | undefined = e?.body?.details;
      setSaveMsg({ ok: false, text: `Couldn't save: ${details?.length ? details.join("; ") : e?.message ?? "request failed"}.` });
    } finally {
      setSaving(false);
    }
  }

  const head = (intro: string | null) => (
    <div style={{ marginBottom: 16 }}>
      <h1 style={{ marginBottom: 4 }}>Automatic transfers</h1>
      {intro && <p className="text-dim" style={{ fontSize: "0.875rem" }}>{intro}</p>}
      {rateNote(rate) && <p className="text-dim" style={{ fontSize: "0.75rem", marginTop: 4 }}>{rateNote(rate)}</p>}
    </div>
  );

  if (loadError) {
    return (
      <div>
        {head(null)}
        <div className="alert warning"><span className="alert-icon" aria-hidden>⚠</span>
          <div className="alert-body"><div className="alert-msg">Couldn't load your settings: {loadError}.</div></div>
        </div>
      </div>
    );
  }
  if (!data || !form) {
    return <div>{head(null)}<div className="loading-shimmer" style={{ height: 240, borderRadius: 8 }} /></div>;
  }

  const m = data.member;
  const farmer = m.role === "farmer";
  if (m.role === "unknown") {
    return (
      <div>
        {head(null)}
        <p data-testid="not-on" style={{ fontSize: "0.875rem" }}>{NOT_ON_SENTENCE}</p>
        <p className="text-dim" style={{ fontSize: "0.875rem" }}>Set your channel role in Settings to see what automatic transfers would do for your connection.</p>
      </div>
    );
  }

  const cap = m.capacity_sats;
  // R19(6): ONE minimum — the strategy the member is on; Manual only shows
  // Save on fees' size as advice (R21(1)).
  const sizeKey = form.strategy === "open" ? "open" : "save";
  const min = m[sizeKey]?.sats ?? null;
  const below = min != null && cap != null && cap < min;
  const openMin = m.open?.sats ?? null;
  // R17(1) + R21(2): below its own size, Keep room open can't be chosen (unless
  // it is already the member's strategy), and its sentence names that size.
  const openUnavailable = form.strategy !== "open" && openMin != null && cap != null && cap < openMin;

  let minLine: JSX.Element | null = null;
  if (min != null && cap != null) {
    minLine = form.strategy === "manual" ? (
      <p data-testid="min-line" style={{ fontSize: "0.8125rem", color: "var(--text-2)" }}>
        <b>Advice:</b> to move on its own, Save on fees needs a connection of at least <Amount sats={min} usd={usd} />; yours is <Amount sats={cap} usd={usd} />{below ? ", so it couldn't yet" : ""}. Nothing is held back by this under Manual only.
      </p>
    ) : (
      <p data-testid="min-line" style={{ fontSize: "0.8125rem", color: "var(--text-2)" }}>
        {NAME[form.strategy]} needs a connection of at least <Amount sats={min} usd={usd} />; yours is <Amount sats={cap} usd={usd} />{below ? ", so it couldn't run on its own yet. A bigger connection lets it start." : "."}
      </p>
    );
  }

  const set = (k: keyof Form) => (v: string) => setForm({ ...form, [k]: v });
  const rowStyle = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" as const, padding: "10px 0", borderTop: "1px solid var(--border)" };

  return (
    <div>
      {head(farmer
        ? "Moves your earnings from your connection to your node's wallet on its own, so you always have room to receive."
        : "Tops up your connection from your node's wallet on its own, so you always have room to send.")}

      <div className="alert info" style={{ marginBottom: 12 }}>
        <span className="alert-icon" aria-hidden>ℹ</span>
        <div className="alert-body"><div className="alert-msg" data-testid="not-on">{NOT_ON_SENTENCE}</div></div>
      </div>

      <div className="panel fade-in">
        <div className="panel-header">
          <span className="panel-title"><span className="icon">↻</span>{farmer ? "Auto-transfer to wallet" : "Auto top-up"}</span>
        </div>
        <div className="panel-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="form-label" id="strat-label">Strategy</div>
          <div role="radiogroup" aria-labelledby="strat-label" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {STRATEGIES.map((s) => {
              const na = s.key === "open" && openUnavailable;
              return (
                <label
                  key={s.key}
                  data-testid={`strategy-${s.key}`}
                  style={{
                    display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 10px", padding: "10px 12px",
                    border: `1px solid ${form.strategy === s.key ? "var(--amber)" : "var(--border)"}`, borderRadius: 8,
                    opacity: na ? 0.7 : 1, cursor: na ? "default" : "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name="strategy"
                    value={s.key}
                    checked={form.strategy === s.key}
                    disabled={na}
                    onChange={() => setForm({ ...form, strategy: s.key })}
                    style={{ marginTop: 3 }}
                  />
                  <span style={{ fontWeight: 600 }}>
                    {s.name}
                    {s.key === "save" && <span className="badge badge-green" style={{ marginLeft: 8 }}>Recommended</span>}
                    {na && <span className="badge badge-muted" style={{ marginLeft: 8 }}>Unavailable</span>}
                  </span>
                  <span />
                  <span className="text-dim" style={{ fontSize: "0.8125rem" }}>{s.desc}</span>
                  {na && openMin != null && (
                    <>
                      <span />
                      <span data-testid="open-unavailable" style={{ fontSize: "0.8125rem" }}>
                        <b>Unavailable:</b> Keep room open needs a connection of at least <Amount sats={openMin} usd={usd} />.
                      </span>
                    </>
                  )}
                </label>
              );
            })}
          </div>
          {minLine}

          <div className="form-label" style={{ marginTop: 8 }}>Safety rails</div>
          <p className="text-dim" style={{ fontSize: "0.8125rem", marginTop: -6 }}>
            Every automatic transfer stays inside these, whatever the strategy. A transfer you start yourself that costs more asks you first.
          </p>
          <div>
            <div style={rowStyle}>
              <div style={{ flex: "1 1 260px" }}>
                <div style={{ fontWeight: 600 }} data-testid="fee-limit-label">Fee limit per transfer, checked before it starts</div>
                <div className="text-dim" style={{ fontSize: "0.75rem" }} data-testid="fee-limit-help">
                  Bitcorn checks the quote against this and won't start a transfer that costs more.{" "}
                  {farmer
                    ? "Once a transfer has started, the Bitcoin network fee for its last step follows the market and is capped only by Loop's own limit, 20% of the amount; Bitcorn can't lower that cap."
                    : "Once a top-up has started, its network fee follows the market."}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <MoneyInput value={form.pct} onChange={set("pct")} label="Maximum fee percent" suffix="%" />
                <span className="text-dim">and</span>
                <MoneyInput value={form.feeUsd} onChange={set("feeUsd")} label="Maximum fee dollars" prefix="$" />
                <span className="text-dim">whichever is lower</span>
              </div>
            </div>
            <div style={rowStyle}>
              <div style={{ flex: "1 1 260px" }}>
                <div style={{ fontWeight: 600 }}>Daily fee budget</div>
                <div className="text-dim" style={{ fontSize: "0.75rem" }}>Automatic transfers stop for the day once their fees reach this, and an alert says so.</div>
              </div>
              <MoneyInput value={form.budgetUsd} onChange={set("budgetUsd")} label="Daily fee budget" prefix="$" />
            </div>
            <div style={rowStyle}>
              <div style={{ flex: "1 1 260px" }}>
                <div style={{ fontWeight: 600 }}>Most moved per day</div>
                <div className="text-dim" style={{ fontSize: "0.75rem" }}>A transfer bigger than what's left today moves what fits, if that's still at least Loop's smallest; otherwise it moves tomorrow.</div>
              </div>
              <MoneyInput value={form.maxDayUsd} onChange={set("maxDayUsd")} label="Most moved per day" prefix="$" />
            </div>
            <p className="text-dim" data-testid="day-boundary" style={{ fontSize: "0.75rem", margin: "4px 0 0" }}>{DAY_BOUNDARY_SENTENCE}</p>
          </div>

          <div className="form-label" style={{ marginTop: 8 }}>Where it goes</div>
          <div style={rowStyle}>
            <div style={{ flex: "1 1 260px" }}>
              <div style={{ fontWeight: 600 }}>{farmer ? "Earnings go to" : "Top-ups come from"}</div>
              <div className="text-dim" style={{ fontSize: "0.75rem" }}>Your node's own Bitcoin wallet, the one Umbrel set up with your Lightning node. This is fixed.</div>
            </div>
            <span style={{ fontWeight: 600 }}>Your wallet</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            {saveMsg && (
              <span data-testid="save-msg" style={{ fontSize: "0.8125rem", color: saveMsg.ok ? "var(--text-2)" : "var(--red)" }}>{saveMsg.text}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
