-- Migration 040: rename token scope `prepay` → `payment` and add cached
-- treasury-public-key columns.
--
-- Source of truth:
--   - decisions/2026-05-11-subscription-stage-5a-architectural-deltas.md
--     (decision #2: scope rename; payment scope is issued to every
--      subscriber tier other than `current`)
--   - specs/2026-05-11-subscription-stage-5a-jwt-fix-and-member-ui.md §4.1
--     (cache columns for the treasury Ed25519 public key fetched from
--      Worker /treasury-info)
--
-- SQLite has no ALTER TABLE DROP CONSTRAINT, and migration 039 declared
-- the scope CHECK constraint inline as `scope IN ('full', 'prepay')`.
-- To widen it to `('full', 'payment')` we rebuild the table. Existing
-- rows with scope='prepay' are remapped to 'payment' during the copy,
-- preserving any member's currently-cached token through the upgrade.

ALTER TABLE subscription_local_token RENAME TO subscription_local_token_old;

CREATE TABLE subscription_local_token (
  id                        INTEGER PRIMARY KEY CHECK (id = 1),
  member_pubkey             TEXT NOT NULL,
  jwt                       TEXT NOT NULL,
  scope                     TEXT NOT NULL CHECK (scope IN ('full', 'payment')),
  issued_at                 INTEGER NOT NULL,
  expires_at                INTEGER NOT NULL,
  fetched_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  treasury_public_key_jwk   TEXT,
  treasury_info_fetched_at  INTEGER
);

INSERT INTO subscription_local_token
  (id, member_pubkey, jwt, scope, issued_at, expires_at, fetched_at, updated_at)
SELECT
  id, member_pubkey, jwt,
  CASE scope WHEN 'prepay' THEN 'payment' ELSE scope END,
  issued_at, expires_at, fetched_at, updated_at
FROM subscription_local_token_old;

DROP TABLE subscription_local_token_old;
