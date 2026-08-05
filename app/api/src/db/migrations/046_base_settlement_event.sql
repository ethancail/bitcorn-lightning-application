-- Migration 046: base_settlement_event — indexed Settled event log
--
-- Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §7.2 + §7.3
--
-- Holds one row per (tx_hash, log_index) pair from the SettlementRouter's
-- Settled event. The §7 sync loop's step 3 populates this via eth_getLogs.
--
-- Settled-event ingestion is LIVE: the Worker's /base/events endpoint
-- (eth_getLogs proxy) and the §7 sync loop's ingestion have landed, so this
-- table is populated each tick (confirmation-depth-gated for reorg safety,
-- idempotent on UNIQUE below) and served via GET /api/stablecoin/settlements.
-- (It was created ahead of the endpoint in the first v1 cut — when PR #197
-- shipped eth_call reads only — but that gap has since been closed.)
--
-- UNIQUE(tx_hash, log_index) makes log re-reading on reorg or crash
-- recovery idempotent. The (block_number, settled_at) index supports
-- chronological UI rendering ("recent settlements" pagination).
--
-- All numeric quantities (amount_units, fee_units) are TEXT for the same
-- reason as the balance cache: avoid int64 overflow + match the TS-side
-- bigint representation.

CREATE TABLE IF NOT EXISTS base_settlement_event (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    block_number        INTEGER NOT NULL,
    tx_hash             TEXT NOT NULL,
    log_index           INTEGER NOT NULL,
    sender_address      TEXT NOT NULL,
    recipient_address   TEXT NOT NULL,
    amount_units        TEXT NOT NULL,
    fee_units           TEXT NOT NULL,
    trade_ref           TEXT NOT NULL,
    settled_at          INTEGER NOT NULL,
    discovered_at       INTEGER NOT NULL,
    UNIQUE(tx_hash, log_index),
    CHECK(sender_address LIKE '0x%' AND length(sender_address) = 42),
    CHECK(recipient_address LIKE '0x%' AND length(recipient_address) = 42),
    CHECK(tx_hash LIKE '0x%' AND length(tx_hash) = 66),
    CHECK(trade_ref LIKE '0x%' AND length(trade_ref) = 66)
);

CREATE INDEX IF NOT EXISTS idx_base_settlement_event_block
    ON base_settlement_event(block_number DESC, settled_at DESC);

CREATE INDEX IF NOT EXISTS idx_base_settlement_event_sender
    ON base_settlement_event(sender_address, settled_at DESC);

CREATE INDEX IF NOT EXISTS idx_base_settlement_event_recipient
    ON base_settlement_event(recipient_address, settled_at DESC);
