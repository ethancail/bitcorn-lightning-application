-- Migration 069: lnd_channels.pending_incoming_sat — the sum of this channel's
-- in-flight incoming HTLCs (ln-service pending_payments, not is_outgoing),
-- written by persist-channels.ts.
--
-- Implements bitcorn-research specs/2026-11-02-drive-mode-spec.md, P1 item 2
-- and §3.3, R18(4): reported as a component of room to receive, not
-- subtracted.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE lnd_channels ADD COLUMN pending_incoming_sat INTEGER;
