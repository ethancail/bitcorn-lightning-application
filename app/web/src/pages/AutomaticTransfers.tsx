// Automatic transfers — the member's settings page, redesigned (R48, R50,
// R51; built under R59 [RELAYED — drive-mode arc chat, 2026-11-12]). The
// approved mockup is drive-mode-evidence/design/at-redesign (R51: "design
// approved with those"), with R51's five changes and R59's rulings.
//
// NOTHING MOVES YET. There is no "Turn on" (P4 adds it, R59(5)): the status
// line says automatic transfers aren't switched on, and no string claims a
// transfer happens.
//
//   - ONE question, two answers (R50(1), R59(4)): "Wait for low fees"
//     (save, Recommended) and "Move sooner" / merchant "Top up sooner"
//     (open). Radio cards (components/RadioCards.tsx), committed ONLY by the
//     one Save.
//   - The minimum connection size shows only where it blocks, as ONE
//     sentence in a card's meta: in the chosen card when the chosen answer
//     is too big for the connection; else in "Move sooner"'s card when that
//     one is unavailable (R21(2): disabled unless it is the member's current
//     strategy). No "What can I do?" until "who pays for a bigger
//     connection" is decided (R51).
//   - Limits: one number, "Most you'll pay per transfer" (R48: $3 farmer /
//     $5 merchant, no percent, R59(1)), with the daily budget and daily max
//     behind "Change limits" (R48), each with a one-line hint (R51).
//   - "How this works" holds the technical notes (R48), with R50(2)'s Loop
//     sentence for farmers and R50(3)'s cost text.
//   - Amounts are the interim tap-for-sats (components/TapAmount.tsx). With
//     no price: the rate sentence once (rate.ts), amounts in sats, and no
//     minimum sentence (the server sends no sizes without a rate).
//   - Connection down: nothing new here (R41); the capacity is the server's
//     hub channel for display.
//
// Every figure is the server's (GET /api/transfers/settings).

import { useEffect, useId, useState, type ReactNode } from "react";
import {
  api,
  transfersApi,
  type ExchangeRate,
  type TransferSettingsPatch,
  type TransferSettingsResponse,
  type TransferStrategy,
} from "../api/client";
import { rateNote } from "../api/rate";
import { RadioCards, type RadioCardOption } from "../components/RadioCards";
import { TapAmount } from "../components/TapAmount";

export const NOT_ON_SENTENCE = "Automatic transfers aren't switched on yet.";
export const DAY_BOUNDARY_SENTENCE = "Daily limits reset at midnight US Central time.";

/** R50(3)'s cost text is for a 250,000-sat move (the cost check's size). */
const EXAMPLE_MOVE_SATS = 250_000;

type Role = "farmer" | "merchant";

const COPY: Record<Role, {
  lede: string;
  notOn: string;
  question: string;
  answers: Record<TransferStrategy, { label: string; desc: string }>;
  perMove: string;
  perMoveHint: string;
  budgetHint: string;
  perDay: string;
  perDayHint: string;
  where: string;
  help: (amount: ReactNode) => ReactNode[];
}> = {
  farmer: {
    lede: "Bitcorn can move your earnings to your wallet for you, so there's always room to get paid.",
    notOn: NOT_ON_SENTENCE,
    question: "How should Bitcorn move your earnings?",
    answers: {
      save: { label: "Wait for low fees", desc: "Moves bigger amounts when fees are low. Cheapest." },
      open: { label: "Move sooner", desc: "Smaller, more frequent moves. Costs a little more." },
    },
    perMove: "Most you'll pay per transfer",
    perMoveHint: "Checked against the quote before a move starts. A move that costs more waits.",
    budgetHint: "Moves stop for the day once their fees reach this.",
    perDay: "Most moved per day",
    perDayHint: "A bigger move is cut to fit, or waits until tomorrow.",
    where: "Where it goes:",
    help: (amount) => [
      "Your earnings build up in your connection to Bitcorn. To make room, Bitcorn sends a batch out through Loop, a swap service, and it lands in your node's wallet as regular bitcoin.",
      <>A move of {amount} costs about $1, including Bitcorn's fee.</>,
      "If a move would cost more than your limit, it waits until fees come down.",
      "Once a move has started, its network fee can rise with the market, up to Loop's own limit.",
    ],
  },
  merchant: {
    lede: "Bitcorn can top up your connection from your wallet for you, so you always have room to pay.",
    notOn: "Auto top-up isn't switched on yet.",
    question: "How should Bitcorn top up your connection?",
    answers: {
      save: { label: "Wait for low fees", desc: "Adds bigger amounts when fees are low. Cheapest." },
      open: { label: "Top up sooner", desc: "Smaller, more frequent top-ups. Costs a little more." },
    },
    perMove: "Most you'll pay per top-up",
    perMoveHint: "Checked against the quote before a top-up starts. A top-up that costs more waits.",
    budgetHint: "Top-ups stop for the day once their fees reach this.",
    perDay: "Most added per day",
    perDayHint: "A bigger top-up is cut to fit, or waits until tomorrow.",
    where: "Where it comes from:",
    help: (amount) => [
      "Every payment you make uses up room in your connection to Bitcorn. When room runs low, Bitcorn sends bitcoin from your node's wallet back into it through Loop, a swap service.",
      <>A top-up of {amount} costs about $2–3.</>,
      "If a top-up would cost more than your limit, it waits until fees come down.",
      "Once a top-up has started, its network fee follows the market.",
    ],
  },
};

type Form = { strategy: TransferStrategy; feeUsd: string; budgetUsd: string; maxDayUsd: string };

const centsToInput = (c: number) => (c / 100).toFixed(2);
const inputToCents = (s: string) => Math.round(Number(s) * 100);
/** A dollar setting as the collapsed limits row says it: "$3", "$2.50". */
const settingText = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

function formFrom(r: TransferSettingsResponse): Form {
  const s = r.settings;
  return {
    strategy: s.strategy,
    feeUsd: centsToInput(s.fee_limit_usd_cents),
    budgetUsd: centsToInput(s.daily_fee_budget_usd_cents),
    maxDayUsd: centsToInput(s.max_moved_per_day_usd_cents),
  };
}

/** Only what the member changed is sent; untouched fields stay NULL
 *  (= the default) on the server. Empty = the form matches the server. */
function patchFrom(form: Form, r: TransferSettingsResponse): TransferSettingsPatch {
  const s = r.settings;
  const p: TransferSettingsPatch = {};
  if (form.strategy !== s.strategy) p.strategy = form.strategy;
  if (inputToCents(form.feeUsd) !== s.fee_limit_usd_cents) p.fee_limit_usd_cents = inputToCents(form.feeUsd);
  if (inputToCents(form.budgetUsd) !== s.daily_fee_budget_usd_cents) p.daily_fee_budget_usd_cents = inputToCents(form.budgetUsd);
  if (inputToCents(form.maxDayUsd) !== s.max_moved_per_day_usd_cents) p.max_moved_per_day_usd_cents = inputToCents(form.maxDayUsd);
  return p;
}

function MoneyField({ label, hint, value, onChange, disabled }: {
  label: string; hint: string; value: string; onChange: (v: string) => void; disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="at-field">
      <div className="at-field-text">
        <label id={`${id}-label`} htmlFor={`${id}-input`}>{label}</label>
        <div id={`${id}-hint`} className="at-field-hint">{hint}</div>
      </div>
      <div className="at-money">
        <span aria-hidden>$</span>
        <input
          id={`${id}-input`}
          className="form-input"
          inputMode="decimal"
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        />
      </div>
    </div>
  );
}

/** The one minimum sentence (R51), its amounts tap-for-sats. */
function TooSmall({ cap, need, rate, marked }: { cap: number; need: number; rate: ExchangeRate | null | undefined; marked: boolean }) {
  return (
    <span className={marked ? "warn-mark" : undefined}>
      Your connection is too small for this yet: it holds <TapAmount sats={cap} rate={rate} />, and this needs <TapAmount sats={need} rate={rate} />.
    </span>
  );
}

export default function AutomaticTransfers() {
  const [data, setData] = useState<TransferSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  // undefined while loading (no rate sentence, amounts not tappable, R31);
  // null when the read failed.
  const [rate, setRate] = useState<ExchangeRate | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const qId = useId();
  const helpId = useId();
  const limitsId = useId();

  useEffect(() => {
    transfersApi.getTransferSettings()
      .then((r) => { setData(r); setForm(formFrom(r)); })
      .catch((e) => setLoadError(e?.message ?? "Request failed"));
    api.getExchangeRate().then(setRate).catch(() => setRate(null));
  }, []);

  const note = rateNote(rate);
  const head = (lede: string | null) => (
    <header className="at-head">
      <h1>Automatic transfers</h1>
      {lede && <p className="at-lede">{lede}</p>}
      {note && <p className="at-rate-note">{note}</p>}
    </header>
  );

  if (loadError) {
    return (
      <div className="at-page">
        {head(null)}
        <div className="alert warning"><span className="alert-icon" aria-hidden>⚠</span>
          <div className="alert-body"><div className="alert-msg">Couldn't load your settings: {loadError}.</div></div>
        </div>
      </div>
    );
  }
  if (!data || !form) {
    return <div className="at-page">{head(null)}<div className="loading-shimmer" style={{ height: 240, borderRadius: 8 }} /></div>;
  }

  const m = data.member;
  if (m.role === "unknown") {
    return (
      <div className="at-page">
        {head(null)}
        <p data-testid="not-on" className="at-status-line"><span className="at-dot" aria-hidden />{NOT_ON_SENTENCE}</p>
        <p className="at-lede">Set your channel role in Settings to see what automatic transfers would do for your connection.</p>
      </div>
    );
  }

  const role: Role = m.role;
  const c = COPY[role];
  const dirty = Object.keys(patchFrom(form, data)).length > 0;

  // The minimum sentence (R51): one, only where it blocks. No sizes come
  // without a rate, so with no price there is none and nothing is disabled.
  const cap = m.capacity_sats;
  const need = (k: TransferStrategy) => m[k]?.sats ?? null;
  const blocked = (k: TransferStrategy) => cap != null && need(k) != null && cap < need(k)!;
  const chosenBlocked = blocked(form.strategy);
  // R21(2): below its size, "Move sooner" can't be chosen, unless it is the
  // member's current (saved) strategy.
  const openUnavailable = data.settings.strategy !== "open" && blocked("open");

  const options: RadioCardOption<TransferStrategy>[] = (["save", "open"] as const).map((k) => {
    let meta: ReactNode = undefined;
    if (k === form.strategy && chosenBlocked) meta = <TooSmall cap={cap!} need={need(k)!} rate={rate} marked />;
    else if (k === "open" && openUnavailable && !chosenBlocked) meta = <TooSmall cap={cap!} need={need(k)!} rate={rate} marked={false} />;
    return {
      value: k,
      label: c.answers[k].label,
      description: c.answers[k].desc,
      badge: k === "save" ? "Recommended" : undefined,
      meta,
      disabled: k === "open" && openUnavailable,
      disabledReason: "Needs a bigger connection",
    };
  });

  const edit = (next: Partial<Form>) => { setForm({ ...form, ...next }); setSaveMsg(null); };
  const feeCents = inputToCents(form.feeUsd);
  const feeShown = settingText(Number.isFinite(feeCents) && feeCents > 0 ? feeCents : data.settings.fee_limit_usd_cents);

  async function save() {
    if (!data || !form) return;
    const patch = patchFrom(form, data);
    if (Object.keys(patch).length === 0) return;
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

  return (
    <div className="at-page">
      {head(c.lede)}

      <div className="panel at-panel fade-in">
        <section className="at-section">
          <p data-testid="not-on" className="at-status-line"><span className="at-dot" aria-hidden />{c.notOn}</p>
        </section>

        <section className="at-section">
          <div className="at-q">
            <h2 id={qId}>{c.question}</h2>
            <button
              type="button"
              className="at-help-btn"
              aria-expanded={helpOpen}
              aria-controls={helpId}
              onClick={() => setHelpOpen(!helpOpen)}
            >
              <span className="at-help-q" aria-hidden>?</span>How this works
            </button>
          </div>
          <div id={helpId} className="at-help" data-testid="help" hidden={!helpOpen}>
            {helpOpen && c.help(<TapAmount sats={EXAMPLE_MOVE_SATS} rate={rate} />).map((p, i) => <p key={i}>{p}</p>)}
          </div>
          <RadioCards<TransferStrategy>
            name="strategy"
            labelledBy={qId}
            options={options}
            value={form.strategy}
            onChange={(v) => edit({ strategy: v })}
            layout="column"
            busy={saving}
          />
        </section>

        <section className="at-section">
          <div className="at-limits-row">
            {!limitsOpen && (
              <>
                <span data-testid="limits-summary">{c.perMove}: <b>{feeShown}</b></span>
                <span className="at-sep" aria-hidden>·</span>
              </>
            )}
            <button
              type="button"
              className="at-link"
              aria-expanded={limitsOpen}
              aria-controls={limitsId}
              onClick={() => setLimitsOpen(!limitsOpen)}
            >
              {limitsOpen ? "Hide limits ▾" : "Change limits ▸"}
            </button>
          </div>
          <div id={limitsId} className="at-limits" hidden={!limitsOpen}>
            {limitsOpen && (
              <>
                <MoneyField label={c.perMove} hint={c.perMoveHint} value={form.feeUsd} onChange={(v) => edit({ feeUsd: v })} disabled={saving} />
                <MoneyField label="Daily fee budget" hint={c.budgetHint} value={form.budgetUsd} onChange={(v) => edit({ budgetUsd: v })} disabled={saving} />
                <MoneyField label={c.perDay} hint={c.perDayHint} value={form.maxDayUsd} onChange={(v) => edit({ maxDayUsd: v })} disabled={saving} />
                <p className="at-reset" data-testid="day-boundary">{DAY_BOUNDARY_SENTENCE}</p>
              </>
            )}
          </div>
        </section>

        <section className="at-section">
          <p className="at-where" data-testid="where">{c.where} <b>Your node's wallet</b></p>
        </section>

        {(dirty || saving || saveMsg) && (
          <section className="at-section at-save-row">
            {(dirty || saving) && (
              <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            )}
            {saveMsg && (
              <span data-testid="save-msg" className={`at-save-msg${saveMsg.ok ? "" : " is-error"}`}>{saveMsg.text}</span>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
