-- Migration 070: lnd_channels.is_initiator — 1 when this node opened (funded)
-- the channel, 0 when the peer did; NULL until the first sync after this
-- migration. Written by persist-channels.ts from ln-service's
-- is_partner_initiated (inverted).
--
-- Drive-mode P1, R23(i): the funder pays the commitment fee and lnd keeps a
-- fee buffer on the funder's side when adding an HTLC, so room to send for a
-- funder subtracts that headroom (capacity.ts). Migration 066's commit fee,
-- once only reported, is an input to it for funders.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE lnd_channels ADD COLUMN is_initiator INTEGER;
