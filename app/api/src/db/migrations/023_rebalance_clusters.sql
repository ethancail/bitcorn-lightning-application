-- Cluster definition + fee steering tables for the rebalance engine v1

CREATE TABLE IF NOT EXISTS rebalance_clusters (
  cluster_id              TEXT PRIMARY KEY,
  label                   TEXT NOT NULL,
  peer_pubkey             TEXT NOT NULL,
  member_id               TEXT,
  policy_role             TEXT NOT NULL CHECK (policy_role IN (
                            'member_primary_outbound',
                            'member_secondary_buffer',
                            'external_ingress',
                            'external_cycle_utility'
                          )),
  observed_flow_profile   TEXT CHECK (observed_flow_profile IN (
                            'send_heavy', 'receive_heavy', 'mixed', 'unknown'
                          )),
  target_min_pct          REAL NOT NULL,
  target_mid_pct          REAL NOT NULL,
  target_max_pct          REAL NOT NULL,
  floor_pct               REAL NOT NULL,
  ceiling_pct             REAL NOT NULL,
  member_priority_tier    INTEGER,
  rebalance_cooldown_sec  INTEGER NOT NULL DEFAULT 1800,
  last_rebalanced_at      INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rebalance_clusters_peer ON rebalance_clusters(peer_pubkey);
CREATE INDEX IF NOT EXISTS idx_rebalance_clusters_role ON rebalance_clusters(policy_role);

CREATE TABLE IF NOT EXISTS rebalance_cluster_channels (
  cluster_id              TEXT NOT NULL,
  channel_id              TEXT NOT NULL,
  chan_id_uint64           TEXT,
  channel_point            TEXT,
  exclude_from_auto_fee   INTEGER NOT NULL DEFAULT 0,
  channel_fee_weight      REAL NOT NULL DEFAULT 1.0,
  preferred_source        INTEGER NOT NULL DEFAULT 0,
  preferred_dest          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (cluster_id, channel_id)
);

CREATE TABLE IF NOT EXISTS rebalance_fee_policy (
  cluster_id              TEXT PRIMARY KEY,
  base_fee_msat           INTEGER NOT NULL,
  base_fee_rate_ppm       INTEGER NOT NULL,
  current_fee_rate_ppm    INTEGER NOT NULL,
  min_fee_rate_ppm        INTEGER NOT NULL,
  max_fee_rate_ppm        INTEGER NOT NULL,
  step_ppm                INTEGER NOT NULL DEFAULT 10,
  last_adjusted_at        INTEGER,
  adjustment_cooldown_sec INTEGER NOT NULL DEFAULT 3600,
  admin_override          INTEGER NOT NULL DEFAULT 0,
  updated_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rebalance_fee_events (
  event_id                TEXT PRIMARY KEY,
  cluster_id              TEXT NOT NULL,
  old_fee_rate_ppm        INTEGER NOT NULL,
  new_fee_rate_ppm        INTEGER NOT NULL,
  reason                  TEXT NOT NULL CHECK (reason IN (
                            'below_band', 'above_band', 'return_to_baseline'
                          )),
  created_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fee_events_cluster ON rebalance_fee_events(cluster_id);
CREATE INDEX IF NOT EXISTS idx_fee_events_created ON rebalance_fee_events(created_at);
