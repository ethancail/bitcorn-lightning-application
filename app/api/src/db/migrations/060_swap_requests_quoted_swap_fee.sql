-- Migration 060: swap_requests.quoted_swap_fee_sat — the quote's server swap
-- fee, stored so execute can bind loopd's max_swap_fee to it.
--
-- Implements bitcorn-research specs/2026-11-02-loop-fee-ceilings-spec.md §5
-- (F1). Before this, swap_requests kept only quoted_fee_sat, a sum, so execute
-- could not recover the components and fell back to 15% of the amount.
-- For Loop In it holds the quoted swap fee alone, without the HTLC fee
-- (spec ruling 10).
--
-- Additive only, no backfill: a row quoted before this migration keeps NULL
-- here and is refused at execute with requote_required (spec §5, D8) — never
-- a fallback to the 15% formula.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header): the runner
-- marks a whole file applied when a statement hits "duplicate column".

ALTER TABLE swap_requests ADD COLUMN quoted_swap_fee_sat INTEGER;
