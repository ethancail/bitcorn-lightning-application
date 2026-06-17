// Member-profile DB access (member_profile + blocked_aliases, migration 051).
//
// All reads/writes are keyed on the local member pubkey. On a member node the
// table holds at most one row (the local node); keying on pubkey keeps it
// consistent with the rest of the schema. Only ever written/read on member
// nodes — the treasury's alias is set via Umbrel/lnd.conf (spec §2/§4).

import { db } from "../db";

export interface MemberProfileRow {
  member_pubkey: string;
  alias: string | null;
  alias_set_at: number | null;
  alias_applied_at: number | null;
  // Auto-pay opt-in + price-acknowledgment state (migration 052). NULL/0 on
  // rows that predate auto-pay (column DEFAULTs apply).
  auto_pay_enabled: number; // 0 | 1
  auto_pay_enabled_at: number | null; // epoch seconds
  last_acknowledged_price: number | null; // sats
  last_acknowledged_price_at: number | null; // epoch seconds
}

/** All operator-blocked alias strings (full-table scan; handful-of-rows scale). */
export function getBlockedAliasList(): string[] {
  return db
    .prepare("SELECT alias FROM blocked_aliases")
    .all()
    .map((r: any) => r.alias as string);
}

export function getMemberProfile(pubkey: string): MemberProfileRow | null {
  const row = db
    .prepare("SELECT * FROM member_profile WHERE member_pubkey = ?")
    .get(pubkey);
  return row ? (row as MemberProfileRow) : null;
}

/**
 * Record member intent to set an alias: persist `alias` + `alias_set_at`,
 * leaving `alias_applied_at` untouched (it is bumped only on a successful LND
 * apply via markAliasApplied). Upsert keyed on pubkey.
 */
export function recordAliasIntent(pubkey: string, alias: string, setAt: number): void {
  db.prepare(
    `INSERT INTO member_profile (member_pubkey, alias, alias_set_at)
     VALUES (?, ?, ?)
     ON CONFLICT(member_pubkey) DO UPDATE SET
       alias = excluded.alias,
       alias_set_at = excluded.alias_set_at`,
  ).run(pubkey, alias, setAt);
}

/**
 * Set the auto-pay opt-in flag (migration 052). On enable, stamp
 * `auto_pay_enabled_at` and seed `last_acknowledged_price` to the current
 * price (when known) so the price-change banner starts silent. On disable,
 * clear only the flag — `last_acknowledged_price`/timestamps are preserved for
 * state/history. Upserts the row so a member with no profile row (never set an
 * alias) can still opt in/out.
 */
export function setAutoPayEnabled(
  pubkey: string,
  enabled: boolean,
  now: number,
  seedAckPrice?: number | null,
): void {
  if (enabled) {
    db.prepare(
      `INSERT INTO member_profile
         (member_pubkey, auto_pay_enabled, auto_pay_enabled_at,
          last_acknowledged_price, last_acknowledged_price_at)
       VALUES (?, 1, ?, ?, ?)
       ON CONFLICT(member_pubkey) DO UPDATE SET
         auto_pay_enabled = 1,
         auto_pay_enabled_at = excluded.auto_pay_enabled_at,
         last_acknowledged_price = excluded.last_acknowledged_price,
         last_acknowledged_price_at = excluded.last_acknowledged_price_at`,
    ).run(pubkey, now, seedAckPrice ?? null, seedAckPrice != null ? now : null);
  } else {
    db.prepare(
      `INSERT INTO member_profile (member_pubkey, auto_pay_enabled)
       VALUES (?, 0)
       ON CONFLICT(member_pubkey) DO UPDATE SET auto_pay_enabled = 0`,
    ).run(pubkey);
  }
}

/**
 * Acknowledge the current subscription price (§6): advance
 * `last_acknowledged_price` so the price-change banner clears. Upserts keyed
 * on pubkey.
 */
export function acknowledgePrice(pubkey: string, price: number, now: number): void {
  db.prepare(
    `INSERT INTO member_profile
       (member_pubkey, last_acknowledged_price, last_acknowledged_price_at)
     VALUES (?, ?, ?)
     ON CONFLICT(member_pubkey) DO UPDATE SET
       last_acknowledged_price = excluded.last_acknowledged_price,
       last_acknowledged_price_at = excluded.last_acknowledged_price_at`,
  ).run(pubkey, price, now);
}

/** Record a successful LND apply (set or startup re-assert). */
export function markAliasApplied(pubkey: string, appliedAt: number): void {
  db.prepare(
    "UPDATE member_profile SET alias_applied_at = ? WHERE member_pubkey = ?",
  ).run(appliedAt, pubkey);
}

/**
 * Clear local alias state: alias = NULL, alias_set_at = NULL (§3.B). Leaves
 * alias_applied_at as historical record; with alias NULL the UI shows the
 * pseudonymous "not set" state regardless. Upserts the row so a clear on a
 * never-set profile is a no-op success.
 */
export function clearMemberAliasRow(pubkey: string): void {
  db.prepare(
    `INSERT INTO member_profile (member_pubkey, alias, alias_set_at)
     VALUES (?, NULL, NULL)
     ON CONFLICT(member_pubkey) DO UPDATE SET
       alias = NULL,
       alias_set_at = NULL`,
  ).run(pubkey);
}
