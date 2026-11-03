-- Migration 065: lnd_channels.remote_reserve_sat — the peer's channel reserve
-- (lnd's remote_constraints.chan_reserve_sat), written by persist-channels.ts.
--
-- Implements bitcorn-research specs/2026-11-02-drive-mode-spec.md, P1 item 2
-- (R13): room to receive = remote_balance_sat − remote_reserve_sat. NULL until
-- the next sync tick writes it.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE lnd_channels ADD COLUMN remote_reserve_sat INTEGER;
