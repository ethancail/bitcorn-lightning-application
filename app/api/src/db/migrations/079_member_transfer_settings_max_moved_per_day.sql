-- Migration 079: member_transfer_settings.max_moved_per_day_usd_cents — the most
-- moved per day, in US cents; NULL = the default, $500 (R15(2)). The day is
-- the US-Central calendar day (R16(4)).
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE member_transfer_settings ADD COLUMN max_moved_per_day_usd_cents INTEGER;
