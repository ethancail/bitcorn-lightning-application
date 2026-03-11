-- Topology recommendations, treasury inventory snapshots, channel history

CREATE TABLE IF NOT EXISTS rebalance_topology_recommendations (
  rec_id                  TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL,
  recommendation_type     TEXT NOT NULL CHECK (recommendation_type IN (
                            'open_external_peer',
                            'add_member_channel',
                            'resize_or_replace_channel',
                            'loop_out',
                            'no_action'
                          )),
  cluster_id              TEXT,
  estimated_amount_sats   INTEGER,
  peer_quality_score      REAL,
  expected_roi_sats       INTEGER,
  reason                  TEXT NOT NULL,
  acknowledged            INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_topo_recs_run ON rebalance_topology_recommendations(run_id);
CREATE INDEX IF NOT EXISTS idx_topo_recs_type ON rebalance_topology_recommendations(recommendation_type);
CREATE INDEX IF NOT EXISTS idx_topo_recs_ack ON rebalance_topology_recommendations(acknowledged);

CREATE TABLE IF NOT EXISTS treasury_inventory_snapshots (
  snapshot_id             TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL,
  total_member_local_sats INTEGER NOT NULL,
  total_member_remote_sats INTEGER NOT NULL,
  total_external_local_sats INTEGER NOT NULL,
  total_external_remote_sats INTEGER NOT NULL,
  member_local_pct        REAL NOT NULL,
  external_local_pct      REAL NOT NULL,
  created_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inventory_run ON treasury_inventory_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_inventory_created ON treasury_inventory_snapshots(created_at);

CREATE TABLE IF NOT EXISTS lnd_channel_history (
  channel_id              TEXT PRIMARY KEY,
  peer_pubkey             TEXT NOT NULL,
  capacity_sat            INTEGER,
  opened_at               INTEGER,
  closed_at               INTEGER
);

CREATE INDEX IF NOT EXISTS idx_channel_history_peer ON lnd_channel_history(peer_pubkey);
