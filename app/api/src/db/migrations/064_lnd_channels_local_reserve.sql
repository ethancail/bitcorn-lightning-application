-- Migration 064: lnd_channels.local_reserve_sat — this node's channel reserve
-- (lnd's local_constraints.chan_reserve_sat), written by persist-channels.ts.
--
-- Implements bitcorn-research specs/2026-11-02-drive-mode-spec.md, P1 item 2:
-- room to send = local_balance_sat − local_reserve_sat. lnd's local_balance is
-- already net of the commitment fee and anchors; the reserve is not, being
-- only a constraint. NULL until the next sync tick writes it.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE lnd_channels ADD COLUMN local_reserve_sat INTEGER;
