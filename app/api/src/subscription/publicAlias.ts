// The treasury's public-alias store and its refresh.
//
// Spec: bitcorn-research specs/2026-09-24-public-alias-refresh-spec.md §5-§6
// (decision D7). Table: migration 057 (peer_public_alias).
//
// ─── WHAT THIS IS, AND WHAT IT IS NOT ───────────────────────────────────────
//
// It records what each roster member's node ANNOUNCES as its public Lightning
// alias, as one of four outcomes. It is NOT a name the treasury holds for the
// member — that is `contacts.name`, which this module neither reads nor
// writes (D7 §0). The roster shows the two in separate columns.
//
// ─── WHO WRITES IT ──────────────────────────────────────────────────────────
//
// Only the refresh below, which the route gates to the treasury. sync-peers
// shares the lookup (lightning/nodeAlias.ts) but not this store: it runs on
// member nodes too.

import { db } from "../db";
import { lookupNodeAlias } from "../lightning/nodeAlias";
import type { NodeAliasOutcome } from "../profile/publicAliasOutcome";
import { listRosterPubkeys } from "./adminMembersHandler";

export type DefinitiveOutcome = "alias" | "none_announced" | "not_in_graph";

export interface PublicAliasRow {
  pubkey: string;
  /** Last DEFINITIVE outcome; null = never definitively learned. */
  outcome: DefinitiveOutcome | null;
  /** Non-null iff outcome === "alias". */
  alias: string | null;
  outcome_at: number | null;
  last_attempt_at: number;
  /** 1 if the most recent lookup was definitive, 0 if it failed. */
  last_attempt_ok: number;
}

export interface PublicAliasRefreshCounts {
  total: number;
  alias: number;
  none_announced: number;
  not_in_graph: number;
  failed: number;
}

/**
 * At most this many lookups in flight at once (spec §6.2, PROPOSED value).
 *
 * ⚠ What bounding buys, exactly: it caps how many lookups WE are waiting on.
 * It cancels nothing — a lookup that hits its deadline frees its slot while its
 * gRPC call stays pending in LND (callDeadline.ts header), so after timeouts
 * the number of uncancelled calls can exceed this. And each getNode is two
 * RPCs (it also calls getWalletVersion), so 4 lookups ≈ 8 RPCs.
 *
 * Worst case for the whole refresh: ⌈P/4⌉ × LND_GOSSIP_CALL_TIMEOUT_MS for P
 * roster pubkeys, against P × that sequentially.
 */
export const PUBLIC_ALIAS_REFRESH_CONCURRENCY = 4;

// ─── Store: the "keep the last good value" property lives HERE ─────────────

const upsertDefinitive = () =>
  db.prepare(
    `INSERT INTO peer_public_alias
       (pubkey, outcome, alias, outcome_at, last_attempt_at, last_attempt_ok, last_error)
     VALUES (?, ?, ?, ?, ?, 1, NULL)
     ON CONFLICT(pubkey) DO UPDATE SET
       outcome = excluded.outcome,
       alias = excluded.alias,
       outcome_at = excluded.outcome_at,
       last_attempt_at = excluded.last_attempt_at,
       last_attempt_ok = 1,
       last_error = NULL`,
  );

// A failure touches ONLY the attempt fields. outcome, alias and outcome_at are
// deliberately absent from the UPDATE: a first-ever failure inserts a row with
// outcome NULL, and a failure after a definitive outcome leaves it standing.
const upsertFailure = () =>
  db.prepare(
    `INSERT INTO peer_public_alias
       (pubkey, outcome, alias, outcome_at, last_attempt_at, last_attempt_ok, last_error)
     VALUES (?, NULL, NULL, NULL, ?, 0, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       last_attempt_ok = 0,
       last_error = excluded.last_error`,
  );

/** Record one lookup's outcome. The pubkey is lowercased here, always. */
export function recordPublicAliasOutcome(pubkey: string, result: NodeAliasOutcome, now: number): void {
  const key = pubkey.toLowerCase();
  if (result.outcome === "failed") {
    upsertFailure().run(key, now, result.code);
    return;
  }
  const alias = result.outcome === "alias" ? result.alias : null;
  upsertDefinitive().run(key, result.outcome, alias, now, now);
}

export function listPublicAliases(): PublicAliasRow[] {
  return db
    .prepare(
      `SELECT pubkey, outcome, alias, outcome_at, last_attempt_at, last_attempt_ok
       FROM peer_public_alias ORDER BY pubkey`,
    )
    .all() as PublicAliasRow[];
}

// ─── Refresh ───────────────────────────────────────────────────────────────

/** Thrown when a refresh is requested while one is already running. */
export class PublicAliasRefreshInProgressError extends Error {
  constructor() {
    super("refresh_in_progress");
    this.name = "PublicAliasRefreshInProgressError";
  }
}

// Single-flight. Module state is correct here: one API process per node, and
// the point is that a double-click cannot multiply in-flight LND calls.
let refreshInFlight = false;

/**
 * Look up every roster pubkey's announced alias, at most
 * PUBLIC_ALIAS_REFRESH_CONCURRENCY at a time, writing each outcome AS IT
 * SETTLES so a slow tail cannot lose the fast results.
 *
 * Throws PublicAliasRefreshInProgressError — starting nothing — if a refresh
 * is already running.
 */
export async function refreshPublicAliases(): Promise<PublicAliasRefreshCounts> {
  if (refreshInFlight) throw new PublicAliasRefreshInProgressError();
  refreshInFlight = true;
  try {
    const pubkeys = listRosterPubkeys();
    const counts: PublicAliasRefreshCounts = {
      total: pubkeys.length,
      alias: 0,
      none_announced: 0,
      not_in_graph: 0,
      failed: 0,
    };

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < pubkeys.length) {
        const pubkey = pubkeys[next++];
        const result = await lookupNodeAlias(pubkey); // never throws
        recordPublicAliasOutcome(pubkey, result, Date.now());
        counts[result.outcome]++;
      }
    };

    // allSettled, not all: if one worker throws (a DB write failing), the
    // single-flight flag must not clear while the other workers still have
    // lookups in flight — that would let a second refresh stack on top.
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(PUBLIC_ALIAS_REFRESH_CONCURRENCY, pubkeys.length) }, worker),
    );
    const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failure) throw failure.reason;

    return counts;
  } finally {
    refreshInFlight = false;
  }
}
