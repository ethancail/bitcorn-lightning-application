-- Migration 047: base_contract_state_cache — SettlementRouter governance state
--
-- Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §7.3
--
-- Singleton (id=1). Caches the router's governance state as seen by the
-- §7 sync loop. Allows the UI to render "contract paused" banners and
-- the current fee bps without round-tripping to the Worker on every page
-- load.
--
-- The /base/contract-info Worker endpoint returns current_fee_bps and
-- is_paused as part of its standard payload, so the sync loop populates
-- these on every tick. fee_recipient_address requires a separate
-- /base/contract-state(feeRecipient()) call — the sync loop chains both.
--
-- Governance state here is snapshot-based: we cache the current end-state
-- (fee bps, paused, fee recipient) but do NOT capture intermediate
-- governance-event history (the FeeBpsUpdated / Paused / Unpaused logs).
-- NOTE: /base/events HAS since landed and Settled-event ingestion is live
-- (see base_settlement_event), but per-event GOVERNANCE capture is still not
-- wired — only the Settled stream is. Knowing "fee is currently N bps" is
-- enough for the UI; auditors reading governance history read BaseScan.

CREATE TABLE IF NOT EXISTS base_contract_state_cache (
    id                          INTEGER PRIMARY KEY CHECK (id = 1),
    settlement_router_address   TEXT NOT NULL,
    current_fee_bps             INTEGER NOT NULL,
    is_paused                   INTEGER NOT NULL,
    fee_recipient_address       TEXT NOT NULL,
    as_of_block_number          INTEGER NOT NULL,
    as_of_at                    INTEGER NOT NULL,
    CHECK(is_paused IN (0, 1)),
    CHECK(settlement_router_address LIKE '0x%' AND length(settlement_router_address) = 42),
    CHECK(fee_recipient_address LIKE '0x%' AND length(fee_recipient_address) = 42),
    CHECK(current_fee_bps >= 0 AND current_fee_bps <= 10000)
);
