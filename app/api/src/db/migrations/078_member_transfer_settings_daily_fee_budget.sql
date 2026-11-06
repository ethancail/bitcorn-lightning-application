-- Migration 078: member_transfer_settings.daily_fee_budget_usd_cents — the daily
-- fee budget, in US cents; NULL = the default, $10 (R15(2)). The day is the
-- US-Central calendar day (R16(4)).
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE member_transfer_settings ADD COLUMN daily_fee_budget_usd_cents INTEGER;
