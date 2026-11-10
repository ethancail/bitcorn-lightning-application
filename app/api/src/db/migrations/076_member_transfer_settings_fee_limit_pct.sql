-- Migration 076: member_transfer_settings.fee_limit_pct_bps — the per-transfer
-- fee limit as a percentage, in basis points (200 = 2%); NULL = the default
-- (R15(2): 2% or $3, whichever is lower). The limit bounds the cost before a
-- transfer starts (R15(9)).
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE member_transfer_settings ADD COLUMN fee_limit_pct_bps INTEGER;
