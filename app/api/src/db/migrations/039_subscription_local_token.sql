-- Migration 039: Local entitlement-token cache.
-- Source of truth: bitcorn-research/specs/2026-05-08-member-subscription.md §6.4
--
-- Each node (treasury or member) caches the JWT it received from the
-- treasury's /api/subscription/token endpoint. Single row per node
-- (the node has one identity, one current token at a time). Refresh
-- replaces the row in place.
--
-- On treasury nodes the row contains a self-issued full-scope token
-- (the /token endpoint mints full-scope unconditionally for the local
-- treasury pubkey — see app/api/src/subscription/tokenIssuance.ts).
--
-- The Worker validates the JWT itself; this table is the local cache
-- so the application can attach the same token to multiple outgoing
-- Worker calls without re-fetching.

CREATE TABLE IF NOT EXISTS subscription_local_token (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  member_pubkey   TEXT NOT NULL,
  jwt             TEXT NOT NULL,
  scope           TEXT NOT NULL CHECK (scope IN ('full', 'prepay')),
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  fetched_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
