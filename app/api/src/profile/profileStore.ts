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
