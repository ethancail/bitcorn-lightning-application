-- Extend advisor config with member withdrawal limits
ALTER TABLE member_liquidity_advisor_config
  ADD COLUMN max_daily_withdrawal_sat INTEGER NOT NULL DEFAULT 5000000;

ALTER TABLE member_liquidity_advisor_config
  ADD COLUMN min_withdrawal_sat INTEGER NOT NULL DEFAULT 250000;

ALTER TABLE member_liquidity_advisor_config
  ADD COLUMN max_withdrawal_sat INTEGER NOT NULL DEFAULT 2000000;
