-- Migration 080: fee_estimate_samples — lnd's next-6-block fee estimate,
-- sampled at most every 10 minutes off the sync tick and kept 8 days, so the
-- node can compute R15(5)'s 7-day median for "calm" (drive-mode P3, R40(8);
-- spec §3.1). Written by transfers/feeSamples.ts, which only READS lnd.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header). The value
-- column is 081.

CREATE TABLE IF NOT EXISTS fee_estimate_samples (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sampled_at INTEGER NOT NULL
);
