-- Migration 062: swap_requests.quoted_miner_fee_sat — the quote's on-chain
-- fee, stored so execute can send it as loopd's max_miner_fee and check the
-- fee rate against it before initiation.
--
-- Implements bitcorn-research specs/2026-11-02-loop-fee-ceilings-spec.md §5
-- (F3). For Loop Out it is the quoted sweep fee; for Loop In, the quoted HTLC
-- publish fee.
--
-- Additive only, no backfill (see 060's header).
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE swap_requests ADD COLUMN quoted_miner_fee_sat INTEGER;
