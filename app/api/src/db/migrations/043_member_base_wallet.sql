-- Migration 043: member_base_wallet — declared BASE wallet addresses
--
-- Spec: bitcorn-research/specs/2026-05-20-stablecoin-settlement-rail-v1.md §7.3
--
-- Each row maps a Bitcorn member (pubkey) to the BASE wallet they have
-- declared. The wallet is the destination for Coinbase Onramp USDC delivery
-- (§6) and the address the §7 sync loop polls balances for.
--
-- Declared, never inferred — per BITCORN_CONTEXT.md §3 "operator-role
-- declared, never inferred" rule. Members register via the §8.1 UI
-- (separate spec; not landed yet). The sync loop is a no-op when this
-- table is empty (typical state on a fresh install), so the loop being
-- enabled before any registrations exist is harmless.
--
-- One wallet per member at v1. Future v2 may allow multiple (e.g. a
-- treasury operator wanting separate hot/cold wallets) — the schema is
-- ready for that by removing the UNIQUE(member_pubkey) constraint.

CREATE TABLE IF NOT EXISTS member_base_wallet (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    member_pubkey   TEXT NOT NULL,
    wallet_address  TEXT NOT NULL,
    registered_at   INTEGER NOT NULL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    UNIQUE(member_pubkey),
    CHECK(wallet_address LIKE '0x%' AND length(wallet_address) = 42),
    CHECK(is_active IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_member_base_wallet_active
    ON member_base_wallet(is_active, wallet_address);
