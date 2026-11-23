-- 089_kraken_nonce.sql — the Kraken nonce high-water mark (kraken-autobuy P3,
-- Ethan's ruling K2). One row: the last nonce the node issued for its Kraken
-- key, as a decimal string (an unsigned 64-bit integer; TEXT so no driver ever
-- rounds it). autoBuy/krakenNonce.ts saves it BEFORE each signed request is
-- sent, so a restart or a clock stepped backwards never reissues a nonce.
--
-- ONE STATEMENT PER FILE (see 084).
CREATE TABLE IF NOT EXISTS kraken_nonce (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_nonce TEXT NOT NULL CHECK (length(last_nonce) BETWEEN 1 AND 20 AND last_nonce NOT GLOB '*[^0-9]*')
);
