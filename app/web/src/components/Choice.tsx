// One "choice" control for the option cards that were built separately — the
// Settings theme chips, the channel role panel, both fee-speed pickers and the
// close-channel fee picker (member-first-run-ui slice 1, ruled 2026-11-13).
//
// Native radios inside label cards, so the group behaves as a radio group with
// no script of its own: Tab enters at the checked option (the first, if none
// is), the arrow keys move AND select, Space selects, disabled options are
// skipped. Selection follows focus — so a site whose choice writes to the
// server must commit it separately (the role panel has a Save button).
//
// Values are strings. A site whose real value is not a string (a fee rate,
// where Economy is `undefined`) maps string keys to its values itself.

import type { ReactNode } from "react";

export type ChoiceOption<V extends string> = {
  value: V;
  label: ReactNode;
  description?: ReactNode;
  /** A secondary line in the identifier/number face, e.g. "~10 min · ~2,300 sats". */
  meta?: ReactNode;
  /** A cost on its own last line, never split across two, e.g. "~192 sats". */
  cost?: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
  disabledReason?: ReactNode;
};

type GroupName =
  | { label: ReactNode; labelledBy?: never }
  | { labelledBy: string; label?: never };

export type ChoiceProps<V extends string> = GroupName & {
  /** The radio group's name; unique on the page. */
  name: string;
  options: ChoiceOption<V>[];
  /** null: nothing chosen yet. */
  value: V | null;
  onChange: (value: V) => void;
  /** row: short options side by side (theme, fee speed); column: stacked cards (role). */
  layout?: "row" | "column";
  /** The whole group is off, e.g. while a save is in flight. */
  busy?: boolean;
};

export function Choice<V extends string>({
  name, options, value, onChange, layout = "row", busy = false, label, labelledBy,
}: ChoiceProps<V>) {
  return (
    <fieldset
      className={`choice choice-${layout}`}
      aria-labelledby={labelledBy}
      aria-busy={busy || undefined}
      disabled={busy}
    >
      {label != null && <legend className="choice-legend">{label}</legend>}
      <div className="choice-options">
        {options.map((o) => {
          const checked = value === o.value;
          return (
            <label
              key={o.value}
              className={`choice-option${checked ? " checked" : ""}${o.disabled ? " disabled" : ""}`}
              data-value={o.value}
            >
              <input
                className="choice-input"
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                disabled={o.disabled}
                onChange={() => onChange(o.value)}
              />
              {o.icon != null && <span className="choice-icon" aria-hidden>{o.icon}</span>}
              <span className="choice-text">
                <span className="choice-label">{o.label}{o.badge}</span>
                {o.description != null && <span className="choice-desc">{o.description}</span>}
                {o.meta != null && <span className="choice-meta">{o.meta}</span>}
                {o.cost != null && <span className="choice-cost">{o.cost}</span>}
                {o.disabled && o.disabledReason != null && <span className="choice-reason">{o.disabledReason}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
