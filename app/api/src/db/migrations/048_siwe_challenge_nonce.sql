-- Migration 048: siwe_challenge_nonce — server-issued nonces for the
-- BASE wallet registration signature challenge.
--
-- Spec: bitcorn-research/specs/2026-05-26-stablecoin-rail-frontend-ux.md §2
-- Original spec: 2026-05-20-stablecoin-settlement-rail-v1.md §8.1
--
-- The wallet registration flow follows EIP-4361 / Sign-In With Ethereum:
--   1. Member's frontend POSTs the wallet address they want to bind.
--   2. API returns a nonce + a structured SIWE message containing the
--      member's Lightning pubkey, the wallet address, the treasury host,
--      the nonce, and an expiration.
--   3. Member's wallet signs the message (off-chain, no gas).
--   4. API verifies the ECDSA signature recovers to the claimed address
--      and that the message echoed back matches the issued nonce.
--   5. On success, the nonce is consumed (one-time-use) and the wallet
--      is upserted into member_base_wallet.
--
-- The nonce table is per-(member_pubkey, wallet_address) because a member
-- might be rotating wallets and request a new challenge for a different
-- address concurrently. UNIQUE constraint prevents multiple in-flight
-- challenges for the same (member, address) pair — a second challenge
-- replaces any unconsumed first one.

CREATE TABLE IF NOT EXISTS siwe_challenge_nonce (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    member_pubkey   TEXT NOT NULL,
    wallet_address  TEXT NOT NULL,
    nonce           TEXT NOT NULL,
    issued_at       INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    UNIQUE(member_pubkey, wallet_address),
    CHECK(wallet_address LIKE '0x%' AND length(wallet_address) = 42),
    CHECK(length(nonce) >= 16),
    CHECK(expires_at > issued_at)
);

CREATE INDEX IF NOT EXISTS idx_siwe_challenge_nonce_member
    ON siwe_challenge_nonce(member_pubkey, expires_at);
