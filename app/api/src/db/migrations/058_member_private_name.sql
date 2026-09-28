-- Migration 058: The treasury's store of members' Bitcorn-level names
-- (member_private_name).
--
-- Implements bitcorn-research specs/2026-09-25-member-name-signed-transport-
-- spec.md §6.1-§6.2 (decision D8). Each member's node sends its own
-- Bitcorn-level name (member_profile.bitcorn_name, 055) with every token
-- refresh, under a second signature bound to that refresh's challenge. The
-- treasury verifies it, normalizes and validates it, checks the treasury
-- operator's blocked_aliases, and stores it here — keyed on the VERIFIED
-- pubkey, never on anything the request claims.
--
-- signed_at is the challenge timestamp that signed the stored name. A write
-- lands only from a STRICTLY NEWER signed_at (the ON CONFLICT ... WHERE in
-- subscription/memberName.ts), so a replayed older request cannot revert it.
-- An absent name never clears a row (D8 call 2).
--
-- No outcome or attempt columns (D8 call 4): a member-supplied name has no
-- failed-lookup state, and absent, invalid and rejected names write nothing.
--
-- pubkey is lowercased on write, always.
--
-- Scope note: exists on every install (one migration set) but only the
-- TREASURY writes it — the /token handler that fills it mints on the treasury.
-- Same shape as 051's and 057's notes.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE. db/migrate.ts marks a whole file
-- applied when any statement in it hits "duplicate column"/"already exists",
-- skipping the rest forever (see 055's header). The primary key is the only
-- index needed.

CREATE TABLE IF NOT EXISTS member_private_name (
  pubkey       TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  signed_at    INTEGER NOT NULL,
  received_at  INTEGER NOT NULL
);
