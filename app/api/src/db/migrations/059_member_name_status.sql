-- Migration 059: What the treasury last said about this member's Bitcorn-level
-- name (member_name_status).
--
-- Implements bitcorn-research specs/2026-09-25-member-name-signed-transport-
-- spec.md §6.3 (decision D8 call 8). After a token refresh that carried the
-- name, the member records the treasury's additive `name_status` here, so
-- Settings can say — generically, never why — that BitCorn could not accept it.
--
-- ⚠ name_sent IS LOAD-BEARING. A status is about ONE name. Settings shows the
-- rejected message only when status = 'rejected' AND name_sent equals the
-- current member_profile.bitcorn_name, so a status for an earlier name never
-- describes a newly saved one.
--
-- A table rather than member_profile columns: three ADD COLUMNs would need
-- three migration files under the one-statement rule below; one CREATE is one.
--
-- Scope note: exists on every install but only a MEMBER writes it
-- (subscription/tokenRefresh.ts). The treasury never sends a name, so it never
-- writes a row. member_pubkey is keyed exactly as member_profile is.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's and 058's headers).

CREATE TABLE IF NOT EXISTS member_name_status (
  member_pubkey TEXT PRIMARY KEY,
  name_sent     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'none')),
  received_at   INTEGER NOT NULL
);
