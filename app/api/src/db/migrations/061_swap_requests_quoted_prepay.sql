-- Migration 061: swap_requests.quoted_prepay_sat — the Loop Out quote's
-- prepay, stored so execute can bind loopd's max_prepay_amt to it.
--
-- Implements bitcorn-research specs/2026-11-02-loop-fee-ceilings-spec.md §5
-- (F1). Replaces the fixed 50,000-sat prepay ceiling on the member/admin path.
-- Loop In has no prepay; its rows keep NULL here by design.
--
-- Additive only, no backfill (see 060's header).
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE swap_requests ADD COLUMN quoted_prepay_sat INTEGER;
