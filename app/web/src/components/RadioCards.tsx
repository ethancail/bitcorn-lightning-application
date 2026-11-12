// Radio cards — drive-mode's own (R59(6) [RELAYED — drive-mode arc chat,
// 2026-11-12]), shaped EXACTLY like member-first-run-ui's proposed Choice, so
// the Automatic transfers page can move onto that shared component when it
// ships without changing its call. Named RadioCards, not Choice, so the two
// never collide in the meantime.
//
// Native radios: one input[type=radio][value=key] per option, inside its own
// label card, all sharing `name` — so the browser gives arrow-key movement,
// one tab stop and form semantics for free. CONTROLLED: `value` decides what
// is checked; a click only calls onChange. The page commits the choice with
// its one Save.
//
// Per option: `badge` is a green badge ("Recommended"); `disabledReason`, a
// muted badge shown only while the option is disabled ("Needs a bigger
// connection"); `description` and `meta` sit under the label and describe the
// radio (aria-describedby). `busy` turns the whole group off (a save in
// flight).

import { useId, type ReactNode } from "react";

export type RadioCardOption<V extends string> = {
  value: V;
  label: string;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: ReactNode;
  badge?: string;
  disabled?: boolean;
  disabledReason?: string;
};

export type RadioCardsProps<V extends string> = {
  name: string;
  /** The group's name, as text. Give this or labelledBy. */
  label?: string;
  /** The id of the element that names the group. */
  labelledBy?: string;
  options: RadioCardOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  layout?: "row" | "column";
  busy?: boolean;
};

export function RadioCards<V extends string>({
  name, label, labelledBy, options, value, onChange, layout = "column", busy = false,
}: RadioCardsProps<V>) {
  const uid = useId();
  return (
    <div
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-busy={busy || undefined}
      data-layout={layout}
      className="radio-cards"
    >
      {options.map((o) => {
        const chosen = o.value === value;
        const descId = o.description != null ? `${uid}-${o.value}-desc` : null;
        const metaId = o.meta != null ? `${uid}-${o.value}-meta` : null;
        const describedBy = [descId, metaId].filter(Boolean).join(" ") || undefined;
        return (
          <label
            key={o.value}
            data-testid={`choice-${o.value}`}
            className={`radio-card${chosen ? " is-chosen" : ""}${o.disabled ? " is-disabled" : ""}`}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={chosen}
              disabled={!!o.disabled || busy}
              aria-describedby={describedBy}
              onChange={() => onChange(o.value)}
            />
            <span className="radio-card-body">
              <span className="radio-card-label">
                {o.icon != null && <span className="radio-card-icon" aria-hidden>{o.icon}</span>}
                {o.label}
                {o.badge && <span className="badge badge-green">{o.badge}</span>}
                {o.disabled && o.disabledReason && <span className="badge badge-muted">{o.disabledReason}</span>}
              </span>
              {descId && <span id={descId} className="radio-card-desc">{o.description}</span>}
              {metaId && <span id={metaId} className="radio-card-meta">{o.meta}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}
