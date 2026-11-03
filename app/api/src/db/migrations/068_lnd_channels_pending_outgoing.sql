-- Migration 068: lnd_channels.pending_outgoing_sat — the sum of this channel's
-- in-flight outgoing HTLCs (ln-service pending_payments, is_outgoing), written
-- by persist-channels.ts.
--
-- Implements bitcorn-research specs/2026-11-02-drive-mode-spec.md, P1 item 2
-- and §3.3, R18(4): in-flight HTLCs are REPORTED as a component of room to
-- send and are not subtracted — lnd's local_balance already excludes them.
-- Stored, not read live, to keep the channel figures' one freshness model.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE lnd_channels ADD COLUMN pending_outgoing_sat INTEGER;
