-- Migration 067: lnd_channels.commitment_type — the channel's commitment type
-- as ln-service names it ("anchor", "original", "simplified_taproot", …),
-- written by persist-channels.ts.
--
-- Implements bitcorn-research specs/2026-11-02-drive-mode-spec.md, P1 item 8:
-- Top Up's floor counts lnd's anchor reserve, 10,000 sats per anchor channel
-- up to 100,000, so the anchor channels are counted from this column.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE lnd_channels ADD COLUMN commitment_type TEXT;
