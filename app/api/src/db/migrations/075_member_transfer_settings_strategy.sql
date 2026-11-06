-- Migration 075: member_transfer_settings.strategy — 'save' (Save on fees),
-- 'open' (Keep room open) or 'manual' (Manual only); NULL = the default,
-- Save on fees (R15(3)). Validated in transfers/transferSettings.ts.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE member_transfer_settings ADD COLUMN strategy TEXT;
