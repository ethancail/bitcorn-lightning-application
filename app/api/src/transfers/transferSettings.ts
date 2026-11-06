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

import type http from "http";
import { db } from "../db";
import { ENV } from "../config/env";

export type TransferStrategy = "save" | "open" | "manual";
export const STRATEGIES: readonly TransferStrategy[] = ["save", "open", "manual"];

export type TransferRails = {
  /** Fee limit per transfer, as a percentage, in basis points (200 = 2%). */
  fee_limit_pct_bps: number;
  /** Fee limit per transfer, in US cents. The limit is the LOWER of the two. */
  fee_limit_usd_cents: number;
  daily_fee_budget_usd_cents: number;
  max_moved_per_day_usd_cents: number;
};

export type TransferSettingsValues = { strategy: TransferStrategy } & TransferRails;

/** R15(3) strategy, R15(2) rails: "2% or $3, whichever is lower; $10; $500". */
export const TRANSFER_DEFAULTS: Readonly<TransferSettingsValues> = Object.freeze({
  strategy: "save",
  fee_limit_pct_bps: 200,
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

const FIELDS = ["strategy", "fee_limit_pct_bps", "fee_limit_usd_cents", "daily_fee_budget_usd_cents", "max_moved_per_day_usd_cents"] as const;
type Field = (typeof FIELDS)[number];

export type StoredTransferSettings = { [K in keyof TransferSettingsValues]: TransferSettingsValues[K] | null } & { updated_at: number | null };

export function readStoredTransferSettings(): StoredTransferSettings {
  const row = db.prepare(`
    SELECT strategy, fee_limit_pct_bps, fee_limit_usd_cents, daily_fee_budget_usd_cents,
           max_moved_per_day_usd_cents, updated_at
    FROM member_transfer_settings WHERE id = 1
  `).get() as StoredTransferSettings | undefined;
  return row ?? {
    strategy: null, fee_limit_pct_bps: null, fee_limit_usd_cents: null,
    daily_fee_budget_usd_cents: null, max_moved_per_day_usd_cents: null, updated_at: null,
  };
}

/** Each field: the member's saved value, else the default. */
export function effectiveTransferSettings(stored = readStoredTransferSettings()): TransferSettingsValues {
  return {
    strategy: stored.strategy ?? TRANSFER_DEFAULTS.strategy,
    fee_limit_pct_bps: stored.fee_limit_pct_bps ?? TRANSFER_DEFAULTS.fee_limit_pct_bps,
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
    } else if (key === "fee_limit_pct_bps") {
      // The percentage can never exceed the swap fee ceiling the server
      // already enforces on every Loop quote (env.ts loopMaxSwapFeePct).
      const maxBps = ENV.loopMaxSwapFeePct * 100;
      if (positiveInt(v) && (v as number) <= maxBps) patch.fee_limit_pct_bps = v as number;
      else errors.push(`fee_limit_pct_bps must be a whole number from 1 to ${maxBps}`);
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

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** GET /api/transfers/settings. */
export function handleTransferSettingsGet(res: http.ServerResponse): void {
  try {
    send(res, 200, transferSettingsResponse());
  } catch (err: any) {
    send(res, 500, { error: err?.message });
  }
}

/** PATCH /api/transfers/settings. EXEMPT from action-confirmation (R40(4); the
 *  2026-09-03 decision: routes that govern what an outflow may do are exempt),
 *  and in P3 nothing reads these values to move money. Resolves once the
 *  response is written. */
export function handleTransferSettingsPatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body || "{}");
        } catch {
          send(res, 400, { error: "invalid_json" });
          return resolve();
        }
        const v = validateTransferSettingsPatch(parsed);
        if (!v.ok) {
          send(res, 400, { error: "invalid_transfer_settings", details: v.errors });
          return resolve();
        }
        saveTransferSettings(v.patch);
        send(res, 200, transferSettingsResponse());
      } catch (err: any) {
        send(res, 500, { error: err?.message });
      }
      resolve();
    });
  });
}
