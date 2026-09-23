-- Migration 056: When the member last set their Bitcorn-level name
-- (member_profile.bitcorn_name_set_at, unix seconds, nullable).
--
-- Implements specs/2026-09-23-member-name-prompt-spec.md §3-§4. Mirrors
-- alias_set_at (051). Companion to 055.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE — it is separate from 055 so that
-- neither can be half-applied. db/migrate.ts marks a whole file applied when
-- any statement in it hits "duplicate column"/"already exists", skipping the
-- rest forever (spec §4.1; see 055's header and
-- db/migrate.memberProfileName.test.ts (d)).

ALTER TABLE member_profile ADD COLUMN bitcorn_name_set_at INTEGER;
