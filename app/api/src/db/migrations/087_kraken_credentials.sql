-- 087_kraken_credentials.sql — the node's Kraken API key (kraken-autobuy Slice 1
-- spec §3 P2, decision D4): a sibling of coinbase_credentials (034), singleton.
--
--   api_key             Kraken's public key identifier (sent as the API-Key
--                       header); stored plain, like coinbase_credentials.key_name.
--   encrypted_secret    the private key, AES-256-GCM under the HKDF label
--   nonce               "kraken-autobuy" (credentials.ts); ciphertext || tag.
--   withdraw_method_id  Kraken's ids for the BTC withdrawal method and the saved
--   withdraw_address_id withdrawal address. Account-bound, so they live with the
--                       key and go when it is deleted; P4 fills them at verify.
--
-- ONE STATEMENT PER FILE (see 084).
CREATE TABLE IF NOT EXISTS kraken_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_key TEXT NOT NULL,
  encrypted_secret BLOB NOT NULL,
  nonce BLOB NOT NULL,
  connected_at INTEGER NOT NULL,
  last_verified_at INTEGER,
  withdraw_method_id TEXT,
  withdraw_address_id TEXT
);
