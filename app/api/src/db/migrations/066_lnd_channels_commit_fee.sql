-- Migration 066: lnd_channels.commit_fee_sat — the commitment transaction fee
-- lnd reports (commit_fee), written by persist-channels.ts.
--
-- Implements bitcorn-research specs/2026-11-02-drive-mode-spec.md, P1 item 2.
-- Reported as a component only: lnd's local_balance is already net of it, so
-- capacity never subtracts it again.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE lnd_channels ADD COLUMN commit_fee_sat INTEGER;
