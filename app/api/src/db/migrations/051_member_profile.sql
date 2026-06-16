-- Migration 051: Member profile (public Lightning alias) + operator blocklist
--
-- Implements specs/2026-06-12-member-naming-and-identity-implementation.md §2.
-- Members may opt into a public Lightning alias (gossiped via their own node's
-- node_announcement). Two tables ship together in one migration.
--
-- Why a NEW member_profile table rather than a column on a subscription table:
-- an alias is member identity, not subscription state. The subscription tables
-- (migration 036+) are keyed by member pubkey but model a different lifecycle
-- (tiers, paid_through, tokens) and churn frequently (037-042). Bolting `alias`
-- onto a subscription row couples two unrelated lifecycles and would leave a
-- member with no subscription row nowhere to store an alias. A dedicated table
-- keyed on pubkey matches how lnd_node_info / contacts isolate single-purpose
-- state.
--
-- Scope note: these tables exist on every install (one migration set) but are
-- only written/read on MEMBER nodes. The treasury's alias (BitCorn1) is set via
-- Umbrel/lnd.conf and never touched by application code.

CREATE TABLE IF NOT EXISTS member_profile (
  member_pubkey    TEXT PRIMARY KEY,
  alias            TEXT,    -- nullable; NULL = not set (pseudonymous default)
  alias_set_at     INTEGER, -- unix seconds; when the member last set/changed it
  alias_applied_at INTEGER  -- unix seconds; when updateAlias last succeeded vs LND
);

-- Operator-managed reserved-names blocklist. The migration SEEDS NOTHING:
-- the reserved names (BitCorn1, "treasury", operator personal names) must not
-- live in this public repo, where a committed list is both readable and
-- statically bypassable. The operator inserts rows via SQL at deployment time;
-- protection comes from those rows + the Levenshtein <= 2 check in
-- profile/aliasValidation.ts. An empty table simply accepts every well-formed
-- alias — an acceptable v1 posture for an operator-controlled deployment.
CREATE TABLE IF NOT EXISTS blocked_aliases (
  alias     TEXT PRIMARY KEY, -- the reserved string; compared case-insensitively
  reason    TEXT,             -- optional operator note
  added_at  INTEGER NOT NULL,
  added_by  TEXT              -- optional
);
