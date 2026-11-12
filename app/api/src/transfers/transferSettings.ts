// Automatic-transfer settings, stored on the member's node (drive-mode P3,
// spec §3.1 "Transfer settings"; plan item 1).
//
// ─── NULL MEANS "USE THE CODE DEFAULT" ──────────────────────────────────────
// A column holds a value only once the member has saved one. R15(2)'s rail
// defaults and R15(3)'s strategy default are shape (2) — they lack Ethan's
// direct yes (spec §6, item 1) — so they live in ONE constant below and are
// never written to a row: if Ethan rules different values, every member who
// never chose their own follows the ruling with no data migration. (The 032
// advisor row is the counter-example: its seeded values outrank its code
// defaults to this day.)
//
// ─── NOTHING HERE MOVES MONEY ───────────────────────────────────────────────
// P3 stores and shows these values. No scheduler reads them; there is no
// "enabled" column (that is P4's), so P3 has no way to say "on" (D3.2).
//
// ─── FLOORS ARE CONSTANTS, NOT COLUMNS ──────────────────────────────────────
// R16(2): Save on fees $70 farmer / $200 merchant; Keep room open double.
// They are not member-editable, so nothing stores them.
//
// ─── DAY BOUNDARY ───────────────────────────────────────────────────────────
// R16(4): the daily rails reset at US-Central midnight (America/Chicago,
// daylight saving included). P3 only states it; P4 counts by it.
//
// ─── ONE FEE NUMBER, NO PERCENT (R48; R50(4), ruled R59(1)) ─────────────────
// The per-transfer fee limit is a dollar figure only. The percent limit is
// gone from the code and the API; migration 076's percent column
// stays in the table, UNREAD — no SELECT names it and a PATCH that sends it is
// an unknown field. noFeePercent.test.ts proves a stored percent changes
// nothing and that no reference to it returns.

import { db } from "../db";

export type TransferStrategy = "save" | "open" | "manual";
export const STRATEGIES: readonly TransferStrategy[] = ["save", "open", "manual"];

export type TransferRails = {
  /** "Most you'll pay per transfer", in US cents: the ONE fee limit (R48). */
  fee_limit_usd_cents: number;
  daily_fee_budget_usd_cents: number;
  max_moved_per_day_usd_cents: number;
};

export type TransferSettingsValues = { strategy: TransferStrategy } & TransferRails;

/** R15(3) strategy; rails: R48's $3 per transfer, R15(2)'s $10 and $500. */
export const TRANSFER_DEFAULTS: Readonly<TransferSettingsValues> = Object.freeze({
  strategy: "save",
  fee_limit_usd_cents: 300,
  daily_fee_budget_usd_cents: 1_000,
  max_moved_per_day_usd_cents: 50_000,
});

/** R16(2): each strategy's room floor, by role, in US cents. Manual only runs
 *  nothing; where a floor is needed for it (advice, card recommendation), it
 *  is Save on fees' (R21(1)). */
export const STRATEGY_FLOORS_USD_CENTS = Object.freeze({
  farmer: Object.freeze({ save: 7_000, open: 14_000 }),
  merchant: Object.freeze({ save: 20_000, open: 40_000 }),
});

/** R16(4). */
export const DAY_BOUNDARY_TZ = "America/Chicago";

const FIELDS = ["strategy", "fee_limit_usd_cents", "daily_fee_budget_usd_cents", "max_moved_per_day_usd_cents"] as const;
type Field = (typeof FIELDS)[number];

export type StoredTransferSettings = { [K in keyof TransferSettingsValues]: TransferSettingsValues[K] | null } & { updated_at: number | null };

export function readStoredTransferSettings(): StoredTransferSettings {
  const row = db.prepare(`
    SELECT strategy, fee_limit_usd_cents, daily_fee_budget_usd_cents,
           max_moved_per_day_usd_cents, updated_at
    FROM member_transfer_settings WHERE id = 1
  `).get() as StoredTransferSettings | undefined;
  return row ?? {
    strategy: null, fee_limit_usd_cents: null,
    daily_fee_budget_usd_cents: null, max_moved_per_day_usd_cents: null, updated_at: null,
  };
}

/** Each field: the member's saved value, else the default. */
export function effectiveTransferSettings(stored = readStoredTransferSettings()): TransferSettingsValues {
  return {
    strategy: stored.strategy ?? TRANSFER_DEFAULTS.strategy,
    fee_limit_usd_cents: stored.fee_limit_usd_cents ?? TRANSFER_DEFAULTS.fee_limit_usd_cents,
    daily_fee_budget_usd_cents: stored.daily_fee_budget_usd_cents ?? TRANSFER_DEFAULTS.daily_fee_budget_usd_cents,
    max_moved_per_day_usd_cents: stored.max_moved_per_day_usd_cents ?? TRANSFER_DEFAULTS.max_moved_per_day_usd_cents,
  };
}

export type TransferSettingsPatch = Partial<{ [K in Field]: TransferSettingsValues[K] | null }>;

/**
 * Validate a PATCH body. Every present field must be valid or null (null =
 * back to the default); an unknown field, or no field at all, is refused. Any
 * error refuses the whole patch — nothing is written.
 */
export function validateTransferSettingsPatch(body: unknown):
  | { ok: true; patch: TransferSettingsPatch }
  | { ok: false; errors: string[] } {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const b = body as Record<string, unknown>;
  const errors: string[] = [];
  const patch: TransferSettingsPatch = {};
  for (const key of Object.keys(b)) {
    if (!(FIELDS as readonly string[]).includes(key)) errors.push(`unknown field: ${key}`);
  }
  const positiveInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
  for (const key of FIELDS) {
    if (!(key in b)) continue;
    const v = b[key];
    if (v === null) { (patch as any)[key] = null; continue; }
    if (key === "strategy") {
      if (typeof v === "string" && (STRATEGIES as readonly string[]).includes(v)) patch.strategy = v as TransferStrategy;
      else errors.push("strategy must be 'save', 'open' or 'manual'");
    } else {
      if (positiveInt(v)) (patch as any)[key] = v;
      else errors.push(`${key} must be a positive whole number of cents`);
    }
  }
  if (errors.length === 0 && Object.keys(patch).length === 0) errors.push("no settings to update");
  return errors.length ? { ok: false, errors } : { ok: true, patch };
}

/** Write a validated patch. The row is created on the first save. */
export function saveTransferSettings(patch: TransferSettingsPatch, now = Date.now()): void {
  const keys = Object.keys(patch) as Field[];
  if (keys.length === 0) return;
  const write = db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO member_transfer_settings (id, updated_at) VALUES (1, ?)").run(now);
    db.prepare(
      `UPDATE member_transfer_settings SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = 1`,
    ).run(...keys.map((k) => patch[k] ?? null), now);
  });
  write();
}

/** The GET body: what applies, what the member saved, the defaults, the floors
 *  and the day boundary — so the page states every figure from the server. */
export function transferSettingsResponse() {
  const stored = readStoredTransferSettings();
  return {
    settings: effectiveTransferSettings(stored),
    stored,
    defaults: TRANSFER_DEFAULTS,
    floors_usd_cents: STRATEGY_FLOORS_USD_CENTS,
    day_boundary_tz: DAY_BOUNDARY_TZ,
  };
}
