-- ============================================================================
-- Seed: Initial cluster configuration for the rebalance engine v1
-- ============================================================================
--
-- Run ONCE by the treasury node operator after migrations 023-025 have been
-- applied and the sync loop has populated lnd_channels and contacts.
--
-- Usage:
--   sqlite3 /path/to/bitcorn.sqlite < seeds/001_initial_clusters.sql
--
-- On Umbrel:
--   sqlite3 ~/umbrel/app-data/bitcorn-lightning-node/data/db/bitcorn.sqlite \
--     < seeds/001_initial_clusters.sql
--
-- WARNING: Do not re-run without first clearing the rebalance tables:
--   DELETE FROM rebalance_fee_policy;
--   DELETE FROM rebalance_cluster_channels;
--   DELETE FROM rebalance_clusters;
--
-- This script provisions:
--   1. One external_ingress cluster for ACINQ
--   2. One member_primary_outbound cluster per active non-ACINQ channel
--   3. Channel mappings in rebalance_cluster_channels
--   4. Fee policy rows seeded from treasury_fee_policy
-- ============================================================================

BEGIN TRANSACTION;

-- ── ACINQ pubkey constant ───────────────────────────────────────────────────
-- Used in multiple places below; defined here for clarity.
-- ACINQ pubkey: 03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f

-- ── 1. ACINQ external_ingress cluster ───────────────────────────────────────

INSERT INTO rebalance_clusters (
  cluster_id, label, peer_pubkey, member_id, policy_role,
  observed_flow_profile, target_min_pct, target_mid_pct, target_max_pct,
  floor_pct, ceiling_pct, member_priority_tier,
  rebalance_cooldown_sec, last_rebalanced_at, created_at, updated_at
)
SELECT
  lower(hex(randomblob(16))),
  'ACINQ (external_ingress)',
  '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f',
  NULL,
  'external_ingress',
  NULL,
  25, 35, 50,
  15, 65,
  NULL,
  1800, NULL,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
WHERE EXISTS (
  SELECT 1 FROM lnd_channels
  WHERE peer_pubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f'
    AND active = 1
);

-- Map all active ACINQ channels to the ACINQ cluster
INSERT INTO rebalance_cluster_channels (
  cluster_id, channel_id, chan_id_uint64, channel_point,
  exclude_from_auto_fee, channel_fee_weight, preferred_source, preferred_dest
)
SELECT
  rc.cluster_id,
  lc.channel_id,
  NULL,
  NULL,
  0, 1.0, 0, 0
FROM lnd_channels lc
JOIN rebalance_clusters rc
  ON rc.peer_pubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f'
  AND rc.policy_role = 'external_ingress'
WHERE lc.peer_pubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f'
  AND lc.active = 1;

-- Fee policy for ACINQ cluster
INSERT INTO rebalance_fee_policy (
  cluster_id, base_fee_msat, base_fee_rate_ppm, current_fee_rate_ppm,
  min_fee_rate_ppm, max_fee_rate_ppm, step_ppm,
  last_adjusted_at, adjustment_cooldown_sec, admin_override, updated_at
)
SELECT
  rc.cluster_id,
  COALESCE(tfp.base_fee_msat, 0),
  COALESCE(tfp.fee_rate_ppm, 0),
  COALESCE(tfp.fee_rate_ppm, 0),
  1, 500, 10,
  NULL, 3600, 0,
  strftime('%s', 'now') * 1000
FROM rebalance_clusters rc
LEFT JOIN treasury_fee_policy tfp ON tfp.id = 1
WHERE rc.peer_pubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f'
  AND rc.policy_role = 'external_ingress';

-- ── 2. Member clusters — one per distinct active non-ACINQ peer ─────────────

-- Use a temp table to generate cluster IDs for each member peer
CREATE TEMP TABLE _member_peers AS
SELECT DISTINCT
  peer_pubkey,
  lower(hex(randomblob(16))) AS cluster_id,
  COALESCE(
    (SELECT c.name FROM contacts c WHERE c.pubkey = lc.peer_pubkey),
    substr(peer_pubkey, 1, 16)
  ) AS label
FROM lnd_channels lc
WHERE lc.active = 1
  AND lc.peer_pubkey != '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';

INSERT INTO rebalance_clusters (
  cluster_id, label, peer_pubkey, member_id, policy_role,
  observed_flow_profile, target_min_pct, target_mid_pct, target_max_pct,
  floor_pct, ceiling_pct, member_priority_tier,
  rebalance_cooldown_sec, last_rebalanced_at, created_at, updated_at
)
SELECT
  mp.cluster_id,
  mp.label || ' (member)',
  mp.peer_pubkey,
  NULL,
  'member_primary_outbound',
  NULL,
  60, 70, 85,
  45, 95,
  1,
  1800, NULL,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
FROM _member_peers mp;

-- Map each member's active channels to their cluster
INSERT INTO rebalance_cluster_channels (
  cluster_id, channel_id, chan_id_uint64, channel_point,
  exclude_from_auto_fee, channel_fee_weight, preferred_source, preferred_dest
)
SELECT
  mp.cluster_id,
  lc.channel_id,
  NULL,
  NULL,
  0, 1.0, 0, 0
FROM _member_peers mp
JOIN lnd_channels lc
  ON lc.peer_pubkey = mp.peer_pubkey
  AND lc.active = 1;

-- Fee policy for each member cluster
INSERT INTO rebalance_fee_policy (
  cluster_id, base_fee_msat, base_fee_rate_ppm, current_fee_rate_ppm,
  min_fee_rate_ppm, max_fee_rate_ppm, step_ppm,
  last_adjusted_at, adjustment_cooldown_sec, admin_override, updated_at
)
SELECT
  mp.cluster_id,
  COALESCE(tfp.base_fee_msat, 0),
  COALESCE(tfp.fee_rate_ppm, 0),
  COALESCE(tfp.fee_rate_ppm, 0),
  1, 500, 10,
  NULL, 3600, 0,
  strftime('%s', 'now') * 1000
FROM _member_peers mp
LEFT JOIN treasury_fee_policy tfp ON tfp.id = 1;

-- Clean up temp table
DROP TABLE _member_peers;

COMMIT;
