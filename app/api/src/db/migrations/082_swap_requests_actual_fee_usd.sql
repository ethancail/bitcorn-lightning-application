-- Migration 082: swap_requests.actual_fee_usd_cents — the completed swap's fee
-- (actual_fee_sat) in US cents at the BTC/USD rate when it completed, written
-- by the swap poller ONLY when the cached rate is fresh (R18(9); drive-mode
-- P3, R40(5)). NULL otherwise, and on every row from before this migration:
-- a historical record with no stored dollar value shows sats (the amount
-- component spec §1.1), never today's price.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE swap_requests ADD COLUMN actual_fee_usd_cents INTEGER;
