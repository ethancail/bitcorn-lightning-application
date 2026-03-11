-- Execution engine tables: runs, candidates, outcomes, pair history

CREATE TABLE IF NOT EXISTS rebalance_runs (
  run_id                  TEXT PRIMARY KEY,
  started_at              INTEGER NOT NULL,
  completed_at            INTEGER,
  clusters_evaluated      INTEGER,
  fee_adjustments_made    INTEGER,
  candidates_evaluated    INTEGER,
  rebalance_executed      INTEGER NOT NULL DEFAULT 0,
  topology_recommendation TEXT,
  status                  TEXT NOT NULL CHECK (status IN (
                            'running', 'complete', 'error'
                          ))
);

CREATE INDEX IF NOT EXISTS idx_rebalance_runs_started ON rebalance_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_rebalance_runs_status ON rebalance_runs(status);

CREATE TABLE IF NOT EXISTS rebalance_candidates (
  candidate_id            TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL,
  source_cluster_id       TEXT NOT NULL,
  dest_cluster_id         TEXT NOT NULL,
  source_channel_id       TEXT,
  dest_channel_id         TEXT,
  amount_sats             INTEGER NOT NULL,
  route_fingerprint       TEXT,
  estimated_fee_sats      INTEGER,
  candidate_status        TEXT NOT NULL CHECK (candidate_status IN (
                            'theoretical', 'probed', 'executable', 'executed'
                          )),
  probe_result            TEXT CHECK (probe_result IN (
                            'success', 'failure', 'not_attempted'
                          )),
  route_probed_at         INTEGER,
  route_ttl_seconds       INTEGER NOT NULL DEFAULT 20,
  score                   REAL,
  created_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candidates_run ON rebalance_candidates(run_id);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON rebalance_candidates(candidate_status);
CREATE INDEX IF NOT EXISTS idx_candidates_source ON rebalance_candidates(source_cluster_id);
CREATE INDEX IF NOT EXISTS idx_candidates_dest ON rebalance_candidates(dest_cluster_id);

CREATE TABLE IF NOT EXISTS rebalance_outcomes (
  outcome_id              TEXT PRIMARY KEY,
  candidate_id            TEXT NOT NULL,
  run_id                  TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN (
                            'success', 'failure', 'partial'
                          )),
  actual_amount_sats      INTEGER,
  actual_fee_sats         INTEGER,
  duration_ms             INTEGER,
  failure_reason          TEXT,
  executed_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outcomes_run ON rebalance_outcomes(run_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_candidate ON rebalance_outcomes(candidate_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_status ON rebalance_outcomes(status);

CREATE TABLE IF NOT EXISTS rebalance_pair_history (
  pair_id                 TEXT PRIMARY KEY,
  source_cluster_id       TEXT NOT NULL,
  dest_cluster_id         TEXT NOT NULL,
  attempt_count           INTEGER NOT NULL DEFAULT 0,
  success_count           INTEGER NOT NULL DEFAULT 0,
  failure_count           INTEGER NOT NULL DEFAULT 0,
  probe_failure_count     INTEGER NOT NULL DEFAULT 0,
  execution_failure_count INTEGER NOT NULL DEFAULT 0,
  success_p50_sats        INTEGER,
  success_p75_sats        INTEGER,
  avg_success_fee_sats    INTEGER,
  last_failure_reason     TEXT,
  last_probe_at           INTEGER,
  last_probe_success_at   INTEGER,
  last_attempt_at         INTEGER,
  last_success_at         INTEGER,
  updated_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pair_history_source ON rebalance_pair_history(source_cluster_id);
CREATE INDEX IF NOT EXISTS idx_pair_history_dest ON rebalance_pair_history(dest_cluster_id);
