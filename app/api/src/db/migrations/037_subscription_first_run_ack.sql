-- Migration 037: First-run acknowledgement column on subscription_policy.
-- Source of truth: bitcorn-research/specs/2026-05-08-member-subscription.md §3, §8.3
--
-- Path B variant (per V8 fallback — bitcoind direct RPC unavailable, so
-- subscription receipts co-mingle with LND's hot wallet but are
-- logically segregated by per-member label and tracked in the
-- subscription table). The first-run gate is a one-time operator
-- acknowledgement that subscription receipts will live in LND under a
-- subscription label rather than a separate xpub. Address derivation
-- for any member is blocked until this column is non-null.

ALTER TABLE subscription_policy
  ADD COLUMN first_run_acknowledged_at INTEGER;
