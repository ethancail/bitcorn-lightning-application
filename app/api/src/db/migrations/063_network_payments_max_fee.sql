-- Migration 063: network_payments.max_fee_sats — the fee limit the server sent
-- with a member's Lightning payment (max_fee_mtokens), in sats rounded up.
--
-- Implements bitcorn-research specs/2026-11-02-drive-mode-spec.md, P1 item 4
-- (R15(7): 10 sats + 1% of the amount, members only per R18(7)). NULL on a
-- payment sent before this migration, on a receive, and on a treasury send,
-- which carries no limit.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header): the runner
-- marks a whole file applied when a statement hits "duplicate column".

ALTER TABLE network_payments ADD COLUMN max_fee_sats INTEGER;
