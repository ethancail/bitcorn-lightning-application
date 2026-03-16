-- Migration 026: Member liquidity actions
-- Clean tables for treasury push top-up — no Loop, no on-chain, no swap fields.

-- Drop old swap tables if they exist (from prior 026 that was replaced)
DROP TABLE IF EXISTS member_swap_outcomes;
DROP TABLE IF EXISTS member_swap_quotes;
DROP TABLE IF EXISTS member_swap_recommendations;
DROP TABLE IF EXISTS member_swap_config;

-- Recommendations: one per detected liquidity opportunity
CREATE TABLE IF NOT EXISTS member_liquidity_recommendations (
  recommendation_id            TEXT PRIMARY KEY,
  cluster_id                   TEXT NOT NULL,
  action_type                  TEXT NOT NULL DEFAULT 'treasury_push_topup'
                               CHECK(action_type IN ('treasury_push_topup')),
  trigger_reason               TEXT NOT NULL,
  suggested_amount_sats        INTEGER NOT NULL,
  projected_local_pct          REAL,
  status                       TEXT NOT NULL DEFAULT 'pending'
                               CHECK(status IN ('pending','approved','rejected','executing','complete','failed')),
  rejected_at                  INTEGER,
  created_at                   INTEGER NOT NULL,
  updated_at                   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mlr_cluster ON member_liquidity_recommendations(cluster_id);
CREATE INDEX IF NOT EXISTS idx_mlr_status ON member_liquidity_recommendations(status);

-- Estimates: projected cost / state for a pending recommendation
CREATE TABLE IF NOT EXISTS member_liquidity_estimates (
  estimate_id                  TEXT PRIMARY KEY,
  recommendation_id            TEXT NOT NULL REFERENCES member_liquidity_recommendations(recommendation_id),
  amount_sats                  INTEGER NOT NULL,
  projected_treasury_local_pct REAL NOT NULL,
  projected_member_local_pct   REAL NOT NULL,
  estimated_routing_fee_sats   INTEGER NOT NULL,
  estimated_at                 INTEGER NOT NULL,
  estimate_ttl_seconds         INTEGER NOT NULL DEFAULT 60
);
CREATE INDEX IF NOT EXISTS idx_mle_rec ON member_liquidity_estimates(recommendation_id);

-- Outcomes: result of an executed push
CREATE TABLE IF NOT EXISTS member_liquidity_outcomes (
  outcome_id                   TEXT PRIMARY KEY,
  recommendation_id            TEXT NOT NULL REFERENCES member_liquidity_recommendations(recommendation_id),
  cluster_id                   TEXT NOT NULL,
  action_type                  TEXT NOT NULL,
  status                       TEXT NOT NULL CHECK(status IN ('success','failure')),
  actual_amount_sats           INTEGER,
  actual_fee_sats              INTEGER,
  payment_hash                 TEXT,
  execution_method             TEXT CHECK(execution_method IN ('invoice','keysend')),
  failure_reason               TEXT,
  executed_at                  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mlo_cluster ON member_liquidity_outcomes(cluster_id);
CREATE INDEX IF NOT EXISTS idx_mlo_status ON member_liquidity_outcomes(status);

-- Per-cluster config with sensible defaults
CREATE TABLE IF NOT EXISTS member_liquidity_config (
  cluster_id                    TEXT PRIMARY KEY,
  treasury_push_trigger_pct     REAL NOT NULL DEFAULT 0.85,
  member_depleted_threshold_pct REAL NOT NULL DEFAULT 0.25,
  min_push_sats                 INTEGER NOT NULL DEFAULT 5000,
  max_push_sats                 INTEGER NOT NULL DEFAULT 50000,
  consecutive_runs_required     INTEGER NOT NULL DEFAULT 2,
  rejection_cooldown_sec        INTEGER NOT NULL DEFAULT 86400,
  activity_window_days          INTEGER NOT NULL DEFAULT 7,
  updated_at                    INTEGER NOT NULL
);
