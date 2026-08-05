-- Migration 045: base_usdc_balance_cache — per-wallet USDC balance snapshots
--
-- Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §7.3
--
-- One row per registered BASE wallet (joined to member_base_wallet by
-- wallet_address). The §7 sync loop upserts this on every successful
-- balance read. Reads are non-authoritative; BASE chain state is the
-- source of truth, this is a cache for fast UI rendering without round-
-- tripping to the RPC on every page load.
--
-- balance_units is stored as TEXT to avoid SQLite's int64 overflow risk.
-- USDC uses 6 decimals; even at $1B holdings the value is 10^15 units
-- (safely within int64), but TEXT is defensive and aligns with the
-- TypeScript-side `bigint` representation that handlers use to format
-- the value for the UI.
--
-- The cache row is the staleness anchor: `as_of_at` drives the §5.4 UI
-- banner when the sync loop has been unable to refresh for > N minutes.

CREATE TABLE IF NOT EXISTS base_usdc_balance_cache (
    wallet_address          TEXT PRIMARY KEY,
    balance_units           TEXT NOT NULL,
    as_of_block_number      INTEGER NOT NULL,
    as_of_at                INTEGER NOT NULL,
    CHECK(wallet_address LIKE '0x%' AND length(wallet_address) = 42)
);
