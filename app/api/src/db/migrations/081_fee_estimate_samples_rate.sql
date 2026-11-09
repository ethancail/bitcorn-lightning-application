-- Migration 081: fee_estimate_samples.sat_per_vbyte — the sampled estimate,
-- lnd's getChainFeeRate at confirmation target 6, in sat/vB.
--
-- ⚠ ONE STATEMENT IN THIS FILE, ON PURPOSE (see 055's header).

ALTER TABLE fee_estimate_samples ADD COLUMN sat_per_vbyte REAL;
