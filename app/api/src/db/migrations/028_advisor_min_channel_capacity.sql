-- Adds minimum recommended channel capacity to the advisor config.
-- Channels below this threshold are flagged as undersized.

ALTER TABLE member_liquidity_advisor_config
  ADD COLUMN min_channel_capacity_sat INTEGER NOT NULL DEFAULT 500000;
