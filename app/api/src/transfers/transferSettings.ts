// Automatic-transfer settings, stored on the member's node (drive-mode P3,
// spec §3.1 "Transfer settings"; plan item 1).
//
// ─── NULL MEANS "USE THE CODE DEFAULT" ──────────────────────────────────────
// A column holds a value only once the member has saved one. R15(2)'s rail
// defaults and R15(3)'s strategy default are shape (2) — they lack Ethan's
// direct yes (spec §6, item 1) — so they live in ONE place below
// (transferDefaults) and are never written to a row: if Ethan rules different
// values, every member who never chose their own follows the ruling with no
// data migration. The per-transfer figure is keyed by role (R59(3)), so a
// member with nothing saved follows a role change too. (The 032
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
import type { MemberRole } from "./minimumConnection";

// R50(1), ruled R59(4): two answers, "Wait for low fees" (save) and "Move
// sooner" (open). "Manual only" is dropped: a row that stored "manual" keeps
// it (no migration) and it READS as "save", which is how it always behaved
// (swapOptions and the minimum formula, R21(1)). A PATCH cannot store it.
export type TransferStrategy = "save" | "open";
export const STRATEGIES: readonly TransferStrategy[] = ["save", "open"];

/** A stored strategy as it applies: "manual" (dropped) is "save"; NULL is
 *  NULL, so the default applies. */
function strategyOf(stored: string | null): TransferStrategy | null {
  if (stored === "open") return "open";
  if (stored === "save" || stored === "manual") return "save";
  return null;
}

export type TransferRails = {
  /** "Most you'll pay per transfer", in US cents: the ONE fee limit (R48). */
  fee_limit_usd_cents: number;
  daily_fee_budget_usd_cents: number;
  max_moved_per_day_usd_cents: number;
};

export type TransferSettingsValues = { strategy: TransferStrategy } & TransferRails;

/** R48's per-transfer default, by role (R59(3)): farmer $3, merchant $5;
 *  a member with no role set gets $3, the lower. */
export const FEE_LIMIT_DEFAULT_USD_CENTS: Readonly<Record<MemberRole | "unknown", number>> = Object.freeze({
  farmer: 300,
  merchant: 500,
  unknown: 300,
});

/** R15(3) strategy; rails: the role's per-transfer default, R15(2)'s $10 a
 *  day in fees and $500 moved a day. */
export function transferDefaults(role: MemberRole | "unknown"): Readonly<TransferSettingsValues> {
  return Object.freeze({
    strategy: "save",
    fee_limit_usd_cents: FEE_LIMIT_DEFAULT_USD_CENTS[role],
    daily_fee_budget_usd_cents: 1_000,
    max_moved_per_day_usd_cents: 50_000,
  });
}

/** The member's role, from the advisor config's channel_role (032). The
 *  per-transfer default follows it; it is never inferred from balances. */
export function memberRole(): MemberRole | "unknown" {
  const row = db.prepare("SELECT channel_role FROM member_liquidity_advisor_config WHERE id = 1").get() as
    | { channel_role: string | null }
    | undefined;
  return row?.channel_role === "farmer" || row?.channel_role === "merchant" ? row.channel_role : "unknown";
}

/** R16(2): each strategy's room floor, by role, in US cents. */
export const STRATEGY_FLOORS_USD_CENTS = Object.freeze({
  farmer: Object.freeze({ save: 7_000, open: 14_000 }),
  merchant: Object.freeze({ save: 20_000, open: 40_000 }),
});

/** R16(4). */
export const DAY_BOUNDARY_TZ = "America/Chicago";

const FIELDS = ["strategy", "fee_limit_usd_cents", "daily_fee_budget_usd_cents", "max_moved_per_day_usd_cents"] as const;
type Field = (typeof FIELDS)[number];

/** The row as stored. strategy is the raw column: it may still hold a
 *  dropped "manual" (read through strategyOf). */
export type StoredTransferSettings =
  { [K in Exclude<keyof TransferSettingsValues, "strategy">]: TransferSettingsValues[K] | null }
  & { strategy: string | null; updated_at: number | null };

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

/** Each field: the member's saved value, else the default for their role.
 *  A saved figure stays saved across a role change; an empty column follows
 *  the role. */
export function effectiveTransferSettings(stored = readStoredTransferSettings(), role = memberRole()): TransferSettingsValues {
  const d = transferDefaults(role);
  return {
    strategy: strategyOf(stored.strategy) ?? d.strategy,
    fee_limit_usd_cents: stored.fee_limit_usd_cents ?? d.fee_limit_usd_cents,
    daily_fee_budget_usd_cents: stored.daily_fee_budget_usd_cents ?? d.daily_fee_budget_usd_cents,
    max_moved_per_day_usd_cents: stored.max_moved_per_day_usd_cents ?? d.max_moved_per_day_usd_cents,
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
      else errors.push("strategy must be 'save' or 'open'");
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
  const role = memberRole();
  return {
    settings: effectiveTransferSettings(stored, role),
    stored,
    defaults: transferDefaults(role),
    floors_usd_cents: STRATEGY_FLOORS_USD_CENTS,
    day_boundary_tz: DAY_BOUNDARY_TZ,
  };
}
