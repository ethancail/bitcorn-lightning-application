-- Migration 057: The treasury's public-alias store (peer_public_alias).
--
-- Implements bitcorn-research specs/2026-09-24-public-alias-refresh-spec.md §5
-- (decision D7). One row per roster pubkey, holding the OUTCOME of the last
-- gossip-graph lookup of that node's announced alias — not just a name:
--
--   outcome = 'alias'           the node announces a real alias (in `alias`)
--           = 'none_announced'  it announces none — empty, or a pubkey-derived
--                               form (LND's 20-hex default, the old 8…6
--                               placeholder), which is NEVER stored as a name
--           = 'not_in_graph'    the graph does not know the node
--           = NULL              never definitively learned
--
-- The last DEFINITIVE outcome is held apart from the last ATTEMPT, so a failed
-- lookup updates only last_attempt_at / last_attempt_ok / last_error and keeps
-- the last good value (spec §5.2 — the write rules live in
-- subscription/publicAlias.ts). last_error holds a short code, never LND text.
--
-- pubkey is lowercased on write, always. Rows are never deleted by the refresh.
--
-- Scope note: exists on every install (one migration set) but only the
-- TREASURY writes it — the refresh route is treasury-gated. sync-peers, which
-- runs on member nodes too, does not touch it. Same shape as 051's note.
--
-- CHECKs: `IS` rather than `=` in the pairing, deliberately. With `=`, an
-- outcome of NULL makes the whole comparison NULL, which a CHECK treats as
-- PASSING — so `outcome NULL, alias 'x'` would be admitted. `IS` is null-safe
-- and yields 0/1, so alias is non-NULL exactly when outcome is 'alias'.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE. db/migrate.ts marks a whole file
-- applied when any statement in it hits "duplicate column"/"already exists",
-- skipping the rest forever (see 055's header). The primary key is the only
-- index needed, so there is no second statement to separate.

CREATE TABLE IF NOT EXISTS peer_public_alias (
  pubkey          TEXT PRIMARY KEY,
  outcome         TEXT CHECK (outcome IN ('alias', 'none_announced', 'not_in_graph')),
  alias           TEXT,
  outcome_at      INTEGER,
  last_attempt_at INTEGER NOT NULL,
  last_attempt_ok INTEGER NOT NULL CHECK (last_attempt_ok IN (0, 1)),
  last_error      TEXT,
  CHECK ((outcome IS 'alias') = (alias IS NOT NULL))
);
