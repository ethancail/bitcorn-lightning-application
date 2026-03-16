-- Member swap actions: detection, quoting, execution, and per-cluster config

CREATE TABLE IF NOT EXISTS member_swap_recommendations (
  recommendation_id       TEXT PRIMARY KEY,
  cluster_id              TEXT NOT NULL,
  swap_type               TEXT NOT NULL CHECK (swap_type IN ('cash_out', 'top_up')),
  trigger_reason          TEXT NOT NULL,
  suggested_amount_sats   INTEGER NOT NULL,
  estimated_fee_sats      INTEGER,
  post_swap_local_pct     REAL,
  status                  TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'approved', 'rejected', 'executing', 'complete', 'failed')),
  rejection_cooldown_sec  INTEGER NOT NULL DEFAULT 86400,
  rejected_at             INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_swap_rec_cluster ON member_swap_recommendations(cluster_id);
CREATE INDEX IF NOT EXISTS idx_swap_rec_status ON member_swap_recommendations(status);
CREATE INDEX IF NOT EXISTS idx_swap_rec_type ON member_swap_recommendations(swap_type);

CREATE TABLE IF NOT EXISTS member_swap_quotes (
  quote_id                  TEXT PRIMARY KEY,
  recommendation_id         TEXT NOT NULL REFERENCES member_swap_recommendations(recommendation_id),
  amount_sats               INTEGER NOT NULL,
  estimated_swap_fee_sats   INTEGER NOT NULL,
  estimated_miner_fee_sats  INTEGER NOT NULL,
  estimated_prepay_fee_sats INTEGER,
  total_estimated_fee_sats  INTEGER NOT NULL,
  fee_as_pct                REAL NOT NULL,
  projected_local_pct       REAL NOT NULL,
  projected_remote_pct      REAL NOT NULL,
  within_fee_tolerance      INTEGER NOT NULL,
  quoted_at                 INTEGER NOT NULL,
  quote_ttl_seconds         INTEGER NOT NULL DEFAULT 30
);

CREATE INDEX IF NOT EXISTS idx_swap_quote_rec ON member_swap_quotes(recommendation_id);

CREATE TABLE IF NOT EXISTS member_swap_outcomes (
  outcome_id          TEXT PRIMARY KEY,
  recommendation_id   TEXT NOT NULL REFERENCES member_swap_recommendations(recommendation_id),
  quote_id            TEXT NOT NULL REFERENCES member_swap_quotes(quote_id),
  cluster_id          TEXT NOT NULL,
  swap_type           TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('success', 'failure', 'pending_onchain')),
  actual_amount_sats  INTEGER,
  actual_fee_sats     INTEGER,
  loop_swap_id        TEXT,
  onchain_txid        TEXT,
  failure_reason      TEXT,
  executed_at         INTEGER NOT NULL,
  settled_at          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_swap_outcome_rec ON member_swap_outcomes(recommendation_id);
CREATE INDEX IF NOT EXISTS idx_swap_outcome_cluster ON member_swap_outcomes(cluster_id);
CREATE INDEX IF NOT EXISTS idx_swap_outcome_status ON member_swap_outcomes(status);

CREATE TABLE IF NOT EXISTS member_swap_config (
  cluster_id                  TEXT PRIMARY KEY,
  cashout_trigger_pct         REAL NOT NULL DEFAULT 0.60,
  topup_trigger_pct           REAL NOT NULL DEFAULT 0.30,
  min_swap_sats               INTEGER NOT NULL DEFAULT 50000,
  max_swap_sats               INTEGER NOT NULL DEFAULT 500000,
  max_fee_tolerance_pct       REAL NOT NULL DEFAULT 0.02,
  consecutive_runs_required   INTEGER NOT NULL DEFAULT 2,
  updated_at                  INTEGER NOT NULL
);
