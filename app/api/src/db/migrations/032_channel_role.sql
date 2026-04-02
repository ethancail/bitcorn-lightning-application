-- Adds channel_role and role-aware capacity guidance to the advisor config.
-- channel_role: 'unknown' (default), 'merchant', or 'farmer'.
-- Role determines how the recommendation engine interprets channel balance.

ALTER TABLE member_liquidity_advisor_config
  ADD COLUMN channel_role TEXT NOT NULL DEFAULT 'unknown';

-- Role-aware recommended minimums (separate from the hard floor).
-- These drive "upgrade channel" recommendations per role.
ALTER TABLE member_liquidity_advisor_config
  ADD COLUMN merchant_recommended_capacity_sat INTEGER NOT NULL DEFAULT 2000000;

ALTER TABLE member_liquidity_advisor_config
  ADD COLUMN farmer_recommended_capacity_sat INTEGER NOT NULL DEFAULT 1000000;
