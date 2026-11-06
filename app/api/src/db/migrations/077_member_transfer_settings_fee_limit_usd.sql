-- Migration 077: member_transfer_settings.fee_limit_usd_cents — the per-transfer
-- fee limit's dollar cap, in US cents; NULL = the default, $3 (R15(2)).
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE member_transfer_settings ADD COLUMN fee_limit_usd_cents INTEGER;
